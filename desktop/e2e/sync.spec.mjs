// ── Обмен с сервером на настоящей программе: четыре главных случая ──
//
//   1. Продажа без интернета.
//   2. Возврат интернета.
//   3. Повторная отправка без дублей.
//   4. Обрыв связи посреди синхронизации.
//
// Те же случаи проверяются на уровне основной части программы, без окна
// (test-live/sync.live.mjs). Здесь — целиком: настоящее окно, настоящая основная
// часть, настоящий сервер, а между ними пересыльщик, который по команде выдёргивает
// провод или «теряет» ответы сервера.
//
// Самый коварный обрыв — не «запрос не дошёл», а «запрос дошёл, сервер всё сделал,
// а ответ потерялся». Программа не знает, принят ли чек. Если она пошлёт его второй
// раз, а сервер не узнает повтор, — в базе окажутся два чека и дважды списанный товар.
//
// Перед запуском:  npm run electron:build -- --dir   (нужен собранный интерфейс)
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import { freshUserData, goTo, launchApp, PASS, readLocal, server, serverLogin, signIn, startProxy, USER } from './app.mjs'

test.describe.configure({ mode: 'serial' })

const TAG = 'SYN-' + Date.now().toString(36)
const userData = freshUserData()
let proxy = null
let app = null
let page = null
let token = ''
let code = ''
let X = null

const badge = () => page.getByTestId('sync-badge')
const queue = (state) => readLocal(userData, code, 'SELECT COUNT(*) AS n FROM outbox WHERE state = ?', state)?.[0]?.n
const isPush = (req) => req.method === 'POST' && /\/sync\/push$/.test(req.url)
const pushes = () => proxy.seen.filter((r) => r.method === 'POST' && /\/sync\/push$/.test(r.url) && r.online).length
// Чеки проверки на сервере
const serverSales = async () => (await server(token, 'GET', '/sales')).filter((s) => s.items.some((i) => i.productId === X.id))
const serverStock = async () => (await server(token, 'GET', '/products')).find((p) => p.id === X.id).stock
const shelf = async () => (await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/products' }))).data.find((p) => p.id === X.id).stock

async function sell(times = 1) {
  await goTo(page, 'Касса')
  for (let n = 0; n < times; n++) {
    const scan = page.locator('.scan-input')
    if (await scan.inputValue()) await scan.fill('')
    await scan.focus()
    await page.keyboard.type(X.barcode + '\n', { delay: 3 })
    await expect(page.locator('.kassa-table tbody tr', { hasText: X.name })).toBeVisible()
    await page.getByRole('button', { name: /Провести продажу/ }).click()
    const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
    await expect(receipt).toBeVisible()
    await receipt.getByRole('button', { name: 'Готово' }).click()
    await expect(page.getByText('Корзина пуста')).toBeVisible()
  }
}

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS — логин и пароль владельца тестовой аптеки').toBeTruthy()
  token = await serverLogin()
  code = (await server(token, 'GET', '/auth/me')).pharmacy.code
  X = await server(token, 'POST', '/products', {
    name: `${TAG} Таблетки`, barcode: '275' + String(Date.now()).slice(-9) + '1', category: 'Таблетки', price: 25, cost: 10, stock: 50, minStock: 0, unitsPerPack: 1, expiryDate: '2028-01-31',
  })
  proxy = await startProxy()
  ;({ app, page } = await launchApp({ userData, env: { APTEKA_API_URL: proxy.apiUrl } }))
  await signIn(page)
  await expect(badge()).toContainText('Всё отправлено', { timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  await proxy?.close()
  if (X) await server(token, 'DELETE', `/products/${X.id}`).catch(() => {})
})

test('1. продажа без интернета: чек пробит и сохранён, сервер о нём не знает', async () => {
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 30_000 })
  await sell(2)
  await expect(badge()).toContainText('ждут отправки: 2')
  expect(await shelf()).toBe(48)
  expect(queue('pending')).toBe(2)
  expect(readLocal(userData, code, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale' AND sync = 'pending'")[0].n).toBe(2)
  // На сервере — ничего: ни чеков, ни списания
  expect((await serverSales()).length).toBe(0)
  expect(await serverStock()).toBe(50)
})

test('2. возврат интернета: чеки уходят на сервер сами — те же самые, с тем же временем', async () => {
  const local = readLocal(userData, code, "SELECT id, date FROM docs WHERE kind = 'sale' AND sync = 'pending' ORDER BY date")
  proxy.online()
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  expect(queue('pending')).toBe(0)
  const onServer = await serverSales()
  expect(onServer.map((s) => s.id).sort()).toEqual(local.map((d) => d.id).sort())
  for (const d of local) expect(onServer.find((s) => s.id === d.id).date, 'время чека — когда продали, а не когда дошло').toBe(d.date)
  expect(await serverStock()).toBe(48)
  expect(await shelf()).toBe(48)
})

test('3. повторная отправка без дублей: сервер принял чек, а ответ потерялся — и так три раза', async () => {
  proxy.seen.length = 0
  proxy.loseResponses(isPush)
  await sell(1)
  // Программа отправляет чек; сервер его принимает; ответ не доходит. Она пробует
  // снова — с тем же номером операции
  await expect.poll(() => proxy.lost(), { timeout: 90_000, message: 'программа не повторяет отправку' }).toBeGreaterThanOrEqual(3)
  expect(queue('pending'), 'программа не вправе считать чек отправленным, пока не получила ответ').toBe(1)
  expect((await serverSales()).length, 'сервер принял чек с первого раза — и только один').toBe(3)
  expect(await serverStock()).toBe(47)
  expect(await shelf(), 'на кассе продажа не потеряна и не задвоена, пока ответа нет').toBe(47)

  // Связь наладилась: следующий повтор получает ответ «уже принято»
  proxy.loseResponses(null)
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  expect(queue('pending')).toBe(0)
  expect(pushes(), 'чек уходил несколько раз').toBeGreaterThanOrEqual(4)
  const sales = await serverSales()
  expect(sales.length, 'на сервере по-прежнему один чек, а не четыре').toBe(3)
  expect(new Set(sales.map((s) => s.id)).size).toBe(3)
  expect(await serverStock(), 'товар списан один раз').toBe(47)
  expect(await shelf()).toBe(47)
})

test('4. обрыв связи посреди синхронизации: очередь доходит целиком и ровно один раз', async () => {
  // День без интернета: пять чеков
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 30_000 })
  await sell(5)
  expect(queue('pending')).toBe(5)
  const lostBefore = proxy.lost()

  // Связь появляется, сервер принимает пачку — и связь рвётся на ответе…
  proxy.loseResponses(isPush)
  proxy.online()
  await expect.poll(() => proxy.lost(), { timeout: 120_000, message: 'пачка не ушла на сервер' }).toBeGreaterThan(lostBefore)
  expect((await serverSales()).length, 'сервер принял всю пачку').toBe(8)
  expect(queue('pending'), 'а программа об этом не знает').toBe(5)
  // …потом пропадает совсем…
  proxy.loseResponses(null)
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 60_000 })
  // …и ещё один чек пробивается уже без связи
  await sell(1)
  expect(queue('pending')).toBe(6)

  // Связь возвращается окончательно
  proxy.online()
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  expect(queue('pending')).toBe(0)
  expect(queue('rejected')).toBe(0)

  const sales = await serverSales()
  expect(sales.length, 'каждый чек на сервере ровно один раз: 3 прежних + 5 + 1').toBe(9)
  expect(new Set(sales.map((s) => s.id)).size).toBe(9)
  expect(await serverStock(), '50 − 9').toBe(41)
  expect(await shelf(), 'касса и сервер сходятся').toBe(41)
  // Журнал кассы: те же девять чеков, ни одного «ждёт отправки»
  expect(readLocal(userData, code, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale' AND sync <> 'synced'")[0].n).toBe(0)
  const mine = (await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/sales?days=60' }))).data.filter((s) => s.items.some((i) => i.name.startsWith('SYN-')))
  expect(mine.filter((s) => s.items[0].productId === X.id).length).toBe(9)
})
