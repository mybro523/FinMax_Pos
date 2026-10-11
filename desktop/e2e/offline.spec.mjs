// ── Касса без интернета ──
//
// Главное обещание программы проверяется так, как это будет в аптеке: человек вошёл,
// интернет пропал — и он продолжает работать. Продаёт, принимает возврат и товар,
// открывает и закрывает смену, кладёт в ящик размен и забирает выручку, продаёт по
// переводу, принимает товар в долг поставщику, вносит расход и берёт на него деньги
// из кассы, перезагружает окно, закрывает и открывает программу, выходит и входит снова.
// Всё это — без единого запроса к серверу. А когда интернет
// возвращается, сделанное само уходит на сервер — целиком и ровно по одному разу.
//
// Интернет «выключается» честно: между программой и настоящим сервером стоит
// пересыльщик, который по команде начинает обрывать соединения, как выдернутый провод.
//
// Перед запуском:  npm run electron:build -- --dir   (нужен собранный интерфейс)
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MESSAGES } from '../src/gateway.mjs'
import { freshUserData, goTo, launchApp, moneyValue, PASS, readLocal, server, serverLogin, signIn, startProxy, USER } from './app.mjs'

test.describe.configure({ mode: 'serial' })

const TAG = 'OFF-' + Date.now().toString(36)
const userData = freshUserData()
let proxy = null
let app = null
let page = null
let token = ''
let code = ''
// Неделимый товар и делимый (10 штук в упаковке)
let X = null
let Y = null
// Поставщик, заведённый на сервере: касса получает его при входе
let S = null

const ask = (method, path, body) => page.evaluate((req) => window.apteka.request(req), { method, path, body })
const scanInput = () => page.locator('.scan-input')
const cartRow = (p) => page.locator('.kassa-table tbody tr', { hasText: p.name })
const total = async () => moneyValue(await page.locator('.kassa-itogo .total-row.big span').last().textContent())
const pending = (type) => readLocal(userData, code, "SELECT COUNT(*) AS n FROM outbox WHERE type = ? AND state = 'pending'", type)?.[0]?.n
// Вся очередь: сколько операций в таком состоянии (pending — ждут, done — приняты, rejected — отвергнуты)
const queue = (state) => readLocal(userData, code, 'SELECT COUNT(*) AS n FROM outbox WHERE state = ?', state)?.[0]?.n
const card = (p) => ({ stock: p.stock, looseUnits: p.looseUnits, cost: p.cost, price: p.price, expiryDate: p.expiryDate, expiredUnits: p.expiredUnits })

// Сканер: печатает как клавиатура и сам дожимает Enter.
// Пустое поле не «очищаем»: очистка нажимает Delete, а Delete при пустом поле на
// кассе — это «убрать выбранную строку чека». Проверка сама стёрла бы свой чек.
async function scan(barcode) {
  if (await scanInput().inputValue()) await scanInput().fill('')
  await scanInput().focus()
  await page.keyboard.type(barcode + '\n', { delay: 3 })
}

// Остаток товара — как его видит кассир в каталоге кассы
async function shelf(p) {
  await scanInput().fill(p.name)
  const row = page.locator('.kc-row', { hasText: p.name }).first()
  await expect(row).toBeVisible()
  const text = (await row.locator('.badge').textContent()).trim()
  await scanInput().fill('')
  return text
}

async function pay() {
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  return receipt
}

// Обращалась ли программа к серверу с операциями кассы. Не должна ни разу: продажа,
// возврат, приход, списание, смена, долг и новый расход всегда идут в локальную базу.
// (Правка и удаление расхода — дело сервера; их здесь проверяют отдельно, и до сервера
// они не доходят: расход ещё не отправлен.)
const KASSA = /\/api\/(sales|returns|arrivals|writeoffs|shifts|customers|deferred|expenses|expense-categories)(\/|\?|$)/
const writesToServer = () => proxy.seen.filter((r) => r.method !== 'GET' && KASSA.test(r.url)).map((r) => `${r.method} ${r.url}`)

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS — логин и пароль владельца тестовой аптеки').toBeTruthy()
  token = await serverLogin()
  code = (await server(token, 'GET', '/auth/me')).pharmacy.code
  const n = String(Date.now()).slice(-9)
  X = await server(token, 'POST', '/products', {
    name: `${TAG} Таблетки`, barcode: '278' + n + '1', category: 'Таблетки', price: 25, cost: 10, stock: 10, minStock: 0, unitsPerPack: 1, expiryDate: '2028-01-31',
  })
  Y = await server(token, 'POST', '/products', {
    name: `${TAG} Делимый`, barcode: '278' + n + '2', category: 'Таблетки', price: 50, cost: 30, stock: 3, minStock: 0, unitsPerPack: 10, expiryDate: '2028-01-31',
  })
  S = await server(token, 'POST', '/suppliers', { name: TAG, phone: '', openingDebt: 0 })
  proxy = await startProxy()
  ;({ app, page } = await launchApp({ userData, env: { APTEKA_API_URL: proxy.apiUrl } }))
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  await proxy?.close()
  // Приход в долг убирается первым: с ним уходит долг, и поставщика можно удалить
  if (S) {
    for (const a of (await server(token, 'GET', '/arrivals').catch(() => [])).filter((x) => x.supplierId === S.id)) {
      await server(token, 'DELETE', `/arrivals/${a.id}`).catch(() => {})
    }
    await server(token, 'DELETE', `/suppliers/${S.id}`).catch(() => {})
  }
  for (const p of [X, Y]) if (p) await server(token, 'DELETE', `/products/${p.id}`).catch(() => {})
})

test('вход с интернетом: каталог и журналы ложатся в локальную базу', async () => {
  await signIn(page)
  await goTo(page, 'Касса')
  expect(await shelf(X)).toBe('10 уп')
  expect(await shelf(Y)).toBe('3 уп')
  // Отметка «всё загружено» стоит на диске: после перезапуска ждать сервер не нужно
  await expect.poll(() => readLocal(userData, code, "SELECT value FROM meta WHERE key = 'loaded'")?.[0]?.value, { timeout: 30_000 }).toBe('1')
  expect(readLocal(userData, code, 'SELECT COUNT(*) AS n FROM products')[0].n).toBeGreaterThanOrEqual(2)
})

test('интернет пропал — продажа проходит, чек печатается, остаток уменьшается', async () => {
  proxy.offline()
  proxy.seen.length = 0

  await scan(X.barcode)
  await expect(cartRow(X).locator('.qty-ctrl b')).toHaveText('1')
  await scan(X.barcode)
  await expect(cartRow(X).locator('.qty-ctrl b')).toHaveText('2')
  expect(await total()).toBe(50)
  const receipt = await pay()
  await expect(receipt).toContainText(X.name)
  await expect(receipt).toContainText('50')
  await receipt.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()

  expect(await shelf(X)).toBe('8 уп')
  // Ни ошибки, ни предупреждения «продажа не записана»: для кассира ничего не изменилось
  await page.waitForTimeout(3500)
  await expect(page.locator('.toast.err')).toHaveCount(0)
  await expect(page.locator('.modal', { hasText: 'Продажа не записана' })).toHaveCount(0)
})

test('чек лежит на диске и стоит в очереди на отправку', async () => {
  expect(pending('sale')).toBe(1)
  const [doc] = readLocal(userData, code, "SELECT body, sync FROM docs WHERE kind = 'sale' AND sync = 'pending'")
  const sale = JSON.parse(doc.body)
  expect(sale.total).toBe(50)
  expect(sale.payment).toBe('cash')
  expect(sale.items.map((i) => [i.name, i.qty, i.price, i.cost])).toEqual([[X.name, 2, 25, 10]])
  expect(sale.user.name).toBe(USER)
  // Номер чека создан на кассе — по нему сервер потом узнает повтор
  expect(sale.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  // Касса даже не пыталась идти с продажей на сервер: она всегда работает с локальной базой
  expect(writesToServer()).toEqual([])
})

test('без интернета: поштучная продажа картой', async () => {
  await scan(Y.barcode)
  await cartRow(Y).locator('.inp-pieces').fill('3')
  // Упаковка за 50 и три штуки по 5
  await expect.poll(total).toBe(65)
  await page.locator('.pay-methods button', { hasText: 'Карта' }).click()
  const receipt = await pay()
  await receipt.getByRole('button', { name: 'Готово' }).click()
  expect(await shelf(Y)).toBe('1 уп + 7 шт')
  await page.locator('.pay-methods button', { hasText: 'Наличные' }).click()
})

test('без интернета: новый клиент и продажа в долг', async () => {
  await scan(X.barcode)
  await page.locator('.pay-methods button', { hasText: 'В долг' }).click()
  await page.getByRole('button', { name: 'Новый клиент' }).click()
  const dialog = page.locator('.modal', { hasText: 'Новый клиент' })
  await dialog.locator('input').first().fill(`${TAG} Должник`)
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(page.locator('.toast')).toContainText('Клиент добавлен')
  const receipt = await pay()
  await receipt.getByRole('button', { name: 'Готово' }).click()
  await page.locator('.pay-methods button', { hasText: 'Наличные' }).click()

  // Долг виден в разделе долгов — и гасится тоже без интернета
  await goTo(page, 'Долги клиентов')
  const row = page.locator('tbody tr', { hasText: `${TAG} Должник` })
  await expect(row).toContainText('25')
  await row.getByRole('button', { name: 'Погасить' }).click()
  const payDialog = page.locator('.modal', { hasText: 'Погашение долга' })
  await payDialog.locator('input').first().fill('10')
  await payDialog.getByRole('button', { name: 'Погасить' }).click()
  await expect(row).toContainText('15')
  await page.waitForTimeout(1500)
  await expect(page.locator('.toast.err')).toHaveCount(0)
  expect(pending('customer.create')).toBe(1)
  expect(pending('debt.pay')).toBe(1)
})

test('без интернета: перезагрузка окна ничего не теряет', async () => {
  await goTo(page, 'Касса')
  await page.reload()
  await expect(scanInput()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.login-card')).toHaveCount(0)
  expect(await shelf(X)).toBe('7 уп')
  expect(await shelf(Y)).toBe('1 уп + 7 шт')
})

test('без интернета: программу закрыли и открыли — вход, товары и чеки на месте', async () => {
  await app.close()
  ;({ app, page } = await launchApp({ userData, env: { APTEKA_API_URL: proxy.apiUrl } }))
  // Экрана входа нет: «кто я» отвечает сама программа, по сохранённому
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.login-card')).toHaveCount(0)
  await goTo(page, 'Касса')
  expect(await shelf(X)).toBe('7 уп')

  // И сразу продаём
  await scan(X.barcode)
  const receipt = await pay()
  await receipt.getByRole('button', { name: 'Готово' }).click()
  expect(await shelf(X)).toBe('6 уп')
  expect(pending('sale')).toBe(4)
})

test('без интернета: возврат по чеку возвращает товар на полку', async () => {
  await goTo(page, 'Возврат товара')
  await page.getByPlaceholder('Поиск чека по товару или сумме…').fill('50')
  const saleRow = page.locator('tbody tr', { hasText: X.name }).filter({ hasText: '50' }).first()
  await expect(saleRow).toBeVisible()
  await saleRow.getByRole('button', { name: /Выбрать/ }).click()
  const form = page.locator('.panel', { hasText: 'Что возвращают' })
  await form.locator('input.disc-input').first().fill('1')
  await expect(form.locator('.total-row.big')).toContainText('25')
  // Срок с упаковки можно вписать и без связи. Здесь его не вписывают — срок
  // возвращённому товару касса ставит сама, по своим партиям
  await expect(form.locator('.ret-expiry')).toContainText('Срок на упаковке')
  await form.getByRole('button', { name: /Оформить возврат/ }).click()
  const done = page.locator('.modal', { hasText: 'Возврат оформлен' })
  await expect(done).toBeVisible()
  await done.getByRole('button', { name: 'Готово' }).click()
  await page.waitForTimeout(3500)
  await expect(page.locator('.modal', { hasText: 'Возврат не записан' })).toHaveCount(0)

  await goTo(page, 'Касса')
  expect(await shelf(X)).toBe('7 уп')
  expect(pending('return')).toBe(1)
})

test('без интернета: приход товара кладёт партию на полку', async () => {
  await goTo(page, 'Приход товара')
  await page.getByRole('button', { name: /Новый приход/ }).click()
  const modal = page.locator('.modal', { hasText: 'Новый приход товара' })
  // Поставщик — из справочника, который касса получила при входе
  await modal.locator('[data-tour="af.supplier"] select').selectOption({ label: TAG })
  const box = modal.locator('.scan-input')
  await box.fill(X.barcode)
  await box.press('Enter')
  const line = modal.locator('.arr-line').first()
  await expect(line).toContainText(X.name)
  await line.locator('.arr-qty').fill('5')
  await line.locator('.arr-cost').fill('12')
  await line.locator('.arr-exp').fill('2028-06-30')
  // В долг: 5 × 12 = 60, оплачено 30, остальное — долг поставщику
  await modal.locator('[data-tour="af.credit"]').getByLabel('В долг (оплачено не полностью)').check()
  await modal.locator('[data-tour="af.credit"] input').nth(1).fill('30')
  await expect(modal.locator('[data-tour="af.credit"]')).toContainText('30')
  await modal.getByRole('button', { name: 'Оприходовать' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('tbody tr', { hasText: TAG }).first()).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('.toast.err')).toHaveCount(0)

  await goTo(page, 'Касса')
  expect(await shelf(X)).toBe('12 уп')
  // Закупочная цена — средневзвешенная: (7 × 10 + 5 × 12) / 12 = 10,83
  const card = (await ask('GET', '/products')).data.find((p) => p.id === X.id)
  expect(card.cost).toBe(10.83)
  expect(pending('arrival')).toBe(1)
  // Долг поставщику виден сразу — из локальной базы
  expect((await ask('GET', '/suppliers')).data.find((s) => s.id === S.id).debt).toBe(30)
})

test('без интернета: приход, оформленный здесь, пока нельзя править — и программа объясняет почему', async () => {
  await goTo(page, 'Приход товара')
  await page.locator('tbody tr', { hasText: TAG }).first().getByRole('button', { name: /Подробно/ }).click()
  await expect(page.locator('.modal', { hasText: 'Приход · детали' })).toBeVisible()
  await page.getByRole('button', { name: /Изменить/ }).click()
  await expect(page.locator('.toast.err')).toContainText(MESSAGES.notSent, { timeout: 15_000 })
  await page.keyboard.press('Escape')
})

test('без интернета: списание убирает товар с полки', async () => {
  await goTo(page, 'Списание')
  const panel = page.locator('.panel').first()
  await panel.locator('select').first().selectOption(Y.id)
  await panel.locator('button.btn.icon').first().click()
  await panel.locator('input.disc-input').first().fill('2')
  await panel.getByRole('button', { name: 'Списать', exact: true }).click()
  await page.locator('.overlay .modal', { hasText: 'Списать товар?' }).getByRole('button', { name: 'Списать', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('Списано')
  await goTo(page, 'Касса')
  expect(await shelf(Y)).toBe('1 уп + 5 шт')
  expect(pending('writeoff')).toBe(1)
})

test('без интернета: смена открывается, считает наличные и закрывается', async () => {
  await goTo(page, 'Смена кассы')
  await page.locator('#openCash').fill('100')
  await page.getByRole('button', { name: 'Открыть смену' }).click()
  await expect(page.locator('.toast')).toContainText('Смена открыта')

  await goTo(page, 'Касса')
  await scan(X.barcode)
  const receipt = await pay()
  await receipt.getByRole('button', { name: 'Готово' }).click()

  await goTo(page, 'Смена кассы')
  await expect(page.locator('.metric', { hasText: 'Ожидается в кассе' })).toContainText('125')

  // ── Внесение, изъятие и перевод без интернета ──
  // Кассир положил в ящик 50 размена и отдал владельцу 20: обе записи ложатся в смену
  // этой кассы и ждут отправки, а «ожидается в кассе» меняется сразу
  const cashDialog = async (button, title, amount, note) => {
    await page.getByRole('button', { name: button, exact: true }).click()
    const dlg = page.locator('.overlay .modal', { hasText: title })
    await dlg.locator('#dlg_amount').fill(amount)
    await dlg.locator('#dlg_note').fill(note)
    await dlg.getByRole('button', { name: button, exact: true }).click()
    await expect(dlg).toBeHidden()
  }
  await cashDialog('Внести', 'Внести наличные в кассу', '50', `${TAG} размен`)
  await expect(page.locator('.metric', { hasText: 'Ожидается в кассе' })).toContainText('175')
  await cashDialog('Изъять', 'Изъять наличные из кассы', '20', `${TAG} владельцу`)
  await expect(page.locator('.metric', { hasText: 'Ожидается в кассе' })).toContainText('155')
  await expect(page.locator('[data-tour="shift.cash-list"]')).toContainText(`${TAG} размен`)
  expect(pending('cash.move')).toBe(2)

  // Чек переводом: сервисы — из локальной базы; в ящик такие деньги не попадают
  await goTo(page, 'Касса')
  await scan(X.barcode)
  await page.locator('.pay-methods button', { hasText: 'Перевод' }).click()
  await page.locator('[data-tour="pos.pay-via"]').getByRole('button', { name: 'DC', exact: true }).click()
  const transfer = await pay()
  await expect(transfer.locator('.total-row', { hasText: 'Оплата' })).toContainText('Перевод · DC')
  await transfer.getByRole('button', { name: 'Готово' }).click()
  await goTo(page, 'Смена кассы')
  await expect(page.locator('.metric', { hasText: 'Ожидается в кассе' })).toContainText('155')
  await expect(page.locator('.metric', { hasText: 'Переводом' })).toContainText('25')

  // ── Расходы без интернета ──
  // Владелец берёт из ящика 10 на такси и записывает аренду. Статьи расходов и касса,
  // из которой берут деньги, — из локальной базы: сервер недоступен
  await goTo(page, 'Расходы')
  const history = page.locator('[data-tour="exp.history"] tbody tr')
  const addExpense = async ({ category, amount, note, fromCash }) => {
    await page.locator('#expCategory').selectOption({ label: category })
    await page.locator('#expAmount').fill(amount)
    await page.locator('#expNote').fill(note)
    if (fromCash) await page.getByLabel('Оплачен из кассы').check()
    await page.getByRole('button', { name: 'Добавить расход' }).click()
    await expect(page.locator('.toast').last()).toContainText('Расход добавлен')
    await expect(history.filter({ hasText: note })).toBeVisible()
  }
  await expect(page.locator('#expCategory option', { hasText: 'Аренда' })).toHaveCount(1)
  await expect(page.getByLabel('Оплачен из кассы'), 'смена открыта — деньги из кассы взять можно').toBeEnabled()
  await addExpense({ category: 'Транспорт', amount: '10', note: `${TAG} такси`, fromCash: true })
  await expect(history.filter({ hasText: `${TAG} такси` })).toContainText('из кассы')
  await addExpense({ category: 'Аренда', amount: '300', note: `${TAG} аренда` })
  expect(pending('expense')).toBe(2)

  // Править и удалять расход умеет только сервер, а этот до него ещё не дошёл —
  // программа говорит об этом словами, и расход остаётся на месте
  await history.filter({ hasText: `${TAG} аренда` }).getByRole('button', { name: 'Удалить' }).click()
  await page.locator('.overlay .modal', { hasText: 'Удалить расход?' }).getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(page.locator('.toast.err').last()).toContainText(MESSAGES.notSent, { timeout: 15_000 })
  await expect(history.filter({ hasText: `${TAG} аренда` })).toBeVisible()

  // Чистая прибыль в отчётах считается и без связи: расходы — из локальной базы
  await goTo(page, 'Отчёты')
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  const metric = (label) => page.locator('.cards .metric').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).locator('.value')
  await expect(metric('Чистая прибыль')).toBeVisible()
  const [spent, profit, net] = [moneyValue(await metric('Расходы').textContent()), moneyValue(await metric('Прибыль').textContent()), moneyValue(await metric('Чистая прибыль').textContent())]
  expect(spent, 'расходы за сегодня — не меньше внесённых сейчас').toBeGreaterThanOrEqual(310)
  expect(Math.abs(profit - spent - net), 'чистая прибыль = прибыль − расходы').toBeLessThan(0.02)

  // Деньги взяты из ящика: в нём должно быть на 10 меньше
  await goTo(page, 'Смена кассы')
  await expect(page.locator('.metric', { hasText: 'Ожидается в кассе' })).toContainText('145')
  await expect(page.locator('[data-tour="shift.expenses"]')).toContainText('10')
  await page.getByRole('button', { name: 'Закрыть смену' }).click()
  const dialog = page.locator('.modal', { hasText: 'Закрытие смены' })
  await dialog.locator('input').first().fill('140')
  await dialog.getByRole('button', { name: 'Закрыть смену' }).click()
  await expect(page.locator('.toast').last()).toContainText('Смена закрыта')

  // Z-отчёт открывается сам. Цифры в нём — уже итоговые, а не «предварительные»:
  // считает их та же касса, ждать сервер не нужно
  const report = page.locator('.modal', { hasText: 'Z-отчёт смены' })
  await expect(report).toBeVisible()
  await expect(report.getByText('Цифры предварительные')).toHaveCount(0)
  const line = (label) => report.locator('.total-row', { hasText: label }).first().locator('span').last()
  // Отдельной строкой и со знаком: деньги из ящика ушли
  expect((await line('Расходы из кассы').textContent()).replace(/\s/g, '')).toContain('−10')
  // Внесённое, изъятое и переводы — своими строками
  expect(moneyValue(await line('Внесено в кассу').textContent())).toBe(50)
  expect(moneyValue(await line('Изъято из кассы').textContent())).toBe(20)
  expect(moneyValue(await line('Переводом').textContent())).toBe(25)
  expect(moneyValue(await line('Ожидалось в кассе').textContent())).toBe(145)
  expect(moneyValue(await line('Пересчитано (факт)').textContent())).toBe(140)
  expect(moneyValue(await line('Расхождение').textContent())).toBe(-5)
  await report.getByRole('button', { name: 'Готово' }).click()
  await page.waitForTimeout(1500)
  await expect(page.locator('.toast.err')).toHaveCount(0)

  // Z-отчёт посчитан локально: 100 на начало + 25 наличными + 50 внесено − 20 изъято − 10 на
  // такси = 145, в кассе 140 — недостача 5; чек переводом в ящик не попадает
  const [doc] = readLocal(userData, code, "SELECT body FROM docs WHERE kind = 'shift' AND closedAt IS NOT NULL ORDER BY date DESC LIMIT 1")
  const shift = JSON.parse(doc.body)
  expect([shift.openingCash, shift.salesCash, shift.count, shift.expenseCash, shift.expectedCash, shift.countedCash, shift.difference]).toEqual([100, 25, 2, 10, 145, 140, -5])
  expect([shift.cashIn, shift.cashOut, shift.salesTransfer, shift.transferBy]).toEqual([50, 20, 25, { DC: 25 }])
  await expect(page.locator('tbody tr').filter({ hasText: 'Z-отчёт' }).first()).toContainText('140')
  expect(pending('shift.open')).toBe(1)
  expect(pending('shift.close')).toBe(1)
  expect(pending('cash.move')).toBe(2)

  // Смена закрыта: её расход из кассы вошёл в отчёт и больше не меняется, а брать
  // деньги из кассы уже неоткуда — и программа говорит, что делать
  await goTo(page, 'Расходы')
  const taxi = page.locator('[data-tour="exp.history"] tbody tr').filter({ hasText: `${TAG} такси` })
  await expect(taxi).toContainText('в отчёте смены')
  await expect(taxi.getByRole('button', { name: 'Удалить' })).toHaveCount(0)
  await expect(page.getByLabel('Оплачен из кассы')).toBeDisabled()
  await expect(page.locator('[data-tour="exp.cash"]')).toContainText('Нет открытой смены')
})

test('без интернета: разделы, которым нужен сервер, объясняют это словами', async () => {
  // Поставщики: список — из локальной базы, а завести нового можно только с интернетом
  await goTo(page, 'Поставщики')
  await expect(page.locator('[data-tour="sup.list"]')).toContainText(TAG)
  await page.locator('[data-tour="sup.add"]').click()
  await page.locator('#supName').fill(`${TAG} Без связи`)
  await page.locator('[data-tour="sup.save"]').click()
  await expect(page.locator('.toast.err')).toContainText(MESSAGES.supplierOnline, { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.toast.err')).toHaveCount(0, { timeout: 15_000 })

  // История движения товара открывается только с интернетом — и говорит об этом сама
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(X.name)
  await page.locator('tbody tr', { hasText: X.name }).first().getByRole('button', { name: /Движение товара/ }).click()
  await expect(page.locator('.modal', { hasText: 'Движение товара' }).locator('.note.err')).toContainText(MESSAGES.historyOnline, { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await page.locator('input.search').fill('')

  await goTo(page, 'Сотрудники')
  await expect(page.locator('.toast.err')).toContainText(MESSAGES.onlineOnly, { timeout: 15_000 })

  await goTo(page, 'Товары')
  await page.getByRole('button', { name: /Добавить товар/ }).click()
  const modal = page.locator('.modal')
  await modal.locator('.field', { hasText: 'Название' }).locator('input').first().fill(`${TAG} Без связи`)
  await modal.locator('input[placeholder="487…"]').fill('2789' + String(Date.now()).slice(-9))
  await modal.locator('select').first().selectOption('Таблетки')
  const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
  await num('Закупочная цена').fill('10')
  await num('Цена продажи').fill('20')
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.toast.err')).toContainText(MESSAGES.onlineOnly, { timeout: 15_000 })
  // Товар, который не удалось завести, с экрана исчезает, а не висит призраком
  await page.keyboard.press('Escape')
  await page.locator('input.search').fill(`${TAG} Без связи`)
  await expect(page.locator('tbody tr', { hasText: `${TAG} Без связи` })).toHaveCount(0, { timeout: 15_000 })
})

test('без интернета: выход и вход — паролем, который проверяется на месте', async () => {
  await page.locator('.su-logout').click()
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })

  await page.locator('#lg-name').fill(USER)
  await page.locator('#lg-pw').fill('не-тот-пароль')
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.login-card')).toContainText('Неверное имя или пароль', { timeout: 30_000 })

  // Тот, кто на этом компьютере не входил, без интернета войти не может — и видит почему
  await page.locator('#lg-name').fill('kto-to-drugoj')
  await page.locator('#lg-pw').fill('lyuboj-parol')
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.login-card')).toContainText(MESSAGES.noOfflineLogin, { timeout: 30_000 })

  await signIn(page)
  await goTo(page, 'Касса')
  expect(await shelf(X)).toBe('10 уп')
})

test('за всё время без интернета программа ни разу не писала на сервер, а в журнале нет ошибок', async () => {
  expect(writesToServer()).toEqual([])
  const log = readFileSync(join(userData, 'main.log'), 'utf8')
  expect(log).not.toMatch(/ERROR/)
  expect(log).toMatch(/вход без связи/)
  // Сервер о сделанном без связи пока не знает: его остаток прежний
  const onServer = (await server(token, 'GET', '/products')).find((p) => p.id === X.id)
  expect(onServer.stock).toBe(10)
})

test('интернет вернулся: сделанное без связи само уходит на сервер, а его изменения приходят сюда', async () => {
  // Пока связи не было, на сервере сменили цену и продали упаковку с сайта
  await server(token, 'PATCH', `/products/${X.id}`, { price: 27 })
  await server(token, 'POST', '/sales', { payment: 'cash', items: [{ productId: X.id, qty: 1 }] })
  // За день без связи накопилось: 6 чеков, клиент, погашение, возврат, приход,
  // списание, открытие и закрытие смены, внесение и изъятие, два расхода
  expect(queue('pending')).toBe(17)

  proxy.online()
  // Программа сама замечает, что связь есть: кассир ничего не нажимает
  await expect.poll(() => queue('pending'), { timeout: 150_000, message: 'очередь не ушла на сервер' }).toBe(0)
  expect(queue('rejected'), 'сервер что-то отверг').toBe(0)
  expect(queue('done')).toBe(17)
  expect(readLocal(userData, code, "SELECT COUNT(*) AS n FROM docs WHERE sync <> 'synced'")[0].n).toBe(0)

  await goTo(page, 'Касса')
  await scanInput().fill(X.name)
  const row = page.locator('.kc-row', { hasText: X.name }).first()
  await expect(row.locator('.kc-price'), 'новая цена с сервера не пришла').toContainText('27', { timeout: 60_000 })
  // Остаток: на сервере было 9; сделанное без связи −2 −1 −1 +1 +5 −1 −1 = 0 → 9
  await expect(row.locator('.badge')).toHaveText('9 уп')
  await scanInput().fill('')
})

test('после обмена на сервере — всё, что сделано без связи, и ровно по одному разу', async () => {
  const mine = (list, pick) => list.filter((d) => pick(d))
  const sales = mine(await server(token, 'GET', '/sales'), (s) => s.items.some((i) => i.name.startsWith(TAG)))
  expect(sales.length, 'шесть чеков кассы и один с сайта').toBe(7)
  expect(new Set(sales.map((s) => s.id)).size).toBe(7)
  // Время чека — когда продали, а не когда дошло; кассир — тот, кто пробил
  const first = JSON.parse(readLocal(userData, code, "SELECT body FROM docs WHERE kind = 'sale' AND body LIKE ? ORDER BY date LIMIT 1", `%${TAG}%`)[0].body)
  const onServer = sales.find((s) => s.id === first.id)
  expect(onServer.date).toBe(first.date)
  expect(onServer.user.name).toBe(USER)
  expect(onServer.total).toBe(50)

  expect(mine(await server(token, 'GET', '/returns'), (r) => r.items.some((i) => i.name.startsWith(TAG))).length).toBe(1)
  expect(mine(await server(token, 'GET', '/arrivals'), (a) => a.supplier === TAG).length).toBe(1)
  expect(mine(await server(token, 'GET', '/writeoffs'), (w) => w.items.some((i) => i.name.startsWith(TAG))).length).toBe(1)
  const debtor = (await server(token, 'GET', '/customers')).find((c) => c.name === `${TAG} Должник`)
  expect(debtor?.debt, 'клиент, заведённый без связи: 25 в долг − 10 погасил').toBe(15)
  expect(mine(await server(token, 'GET', '/payments'), (p) => p.customerId === debtor.id).length).toBe(1)

  // Смена кассы: итоги сервер посчитал сам — и получил то же, что касса
  const local = JSON.parse(readLocal(userData, code, "SELECT body FROM docs WHERE kind = 'shift' AND closedAt IS NOT NULL ORDER BY date DESC LIMIT 1")[0].body)
  const shift = (await server(token, 'GET', '/shifts')).find((s) => s.id === local.id)
  expect(shift, 'смены кассы нет в истории на сервере').toBeTruthy()
  expect([shift.openingCash, shift.salesCash, shift.count, shift.expenseCash, shift.expectedCash, shift.countedCash, shift.difference]).toEqual([100, 25, 2, 10, 145, 140, -5])
  expect([shift.cashIn, shift.cashOut, shift.salesTransfer, shift.transferBy]).toEqual([50, 20, 25, { DC: 25 }])
  // Внесение и изъятие — на сервере, в смене кассы и с автором; чек переводом — с сервисом
  const moves = (await server(token, 'GET', '/cash-moves?days=1')).filter((m) => String(m.note).startsWith(TAG))
  expect(moves.map((m) => [m.kind, m.amount, m.shiftId]).sort()).toEqual([['in', 50, shift.id], ['out', 20, shift.id]])
  expect(moves.every((m) => m.user?.name === USER)).toBe(true)
  expect(sales.filter((s) => s.payment === 'transfer').map((s) => s.payVia)).toEqual(['DC'])
  // Приход в долг: долг поставщику — на сервере, ровно тот, что считала касса
  expect((await server(token, 'GET', '/suppliers')).find((s) => s.id === S.id)?.debt).toBe(30)

  // Расходы: оба на сервере, по одному разу; тот, что из кассы, — в смене этой кассы
  const spent = mine(await server(token, 'GET', '/expenses'), (e) => String(e.note).startsWith(TAG))
  expect(spent.map((e) => [e.category, e.amount, e.fromCash, e.shiftId]).sort()).toEqual([['Аренда', 300, false, null], ['Транспорт', 10, true, shift.id]])
  expect(spent.every((e) => e.user?.name === USER), 'расход записан на того, кто его внёс').toBe(true)
  // И касса показывает их серверными копиями — без дублей
  const hereSpent = (await ask('GET', '/expenses?days=180')).data.filter((e) => String(e.note).startsWith(TAG))
  expect(hereSpent.map((e) => e.id).sort()).toEqual(spent.map((e) => e.id).sort())

  // Остатки и цены: сервер и касса показывают одно и то же
  const remote = await server(token, 'GET', '/products')
  const here = (await ask('GET', '/products')).data
  for (const p of [X, Y]) {
    expect(card(here.find((x) => x.id === p.id)), p.name).toEqual(card(remote.find((x) => x.id === p.id)))
  }
  expect(remote.find((p) => p.id === X.id).stock).toBe(9)
  const y = remote.find((p) => p.id === Y.id)
  expect([y.stock, y.looseUnits]).toEqual([1, 5])

  // Расхождений нет: товара хватило, а цены в чеках — те, что были в момент продажи
  const notes = (await server(token, 'GET', '/discrepancies')).filter((d) => [X.id, Y.id].includes(d.productId))
  expect(notes).toEqual([])
})

test('с интернетом чек уходит на сервер сразу, а касса по-прежнему пишет его на свой диск', async () => {
  proxy.seen.length = 0
  await goTo(page, 'Касса')
  await scan(X.barcode)
  expect(await total()).toBe(27)
  const receipt = await pay()
  await receipt.getByRole('button', { name: 'Готово' }).click()
  expect(await shelf(X)).toBe('8 уп')
  await expect
    .poll(async () => (await server(token, 'GET', '/products')).find((p) => p.id === X.id).stock, { timeout: 30_000, message: 'чек не дошёл до сервера' })
    .toBe(8)
  expect(queue('pending')).toBe(0)
  // На сервер ушла очередь, а не прямой запрос «продать»: путь у чека один — с интернетом и без
  expect(writesToServer()).toEqual([])
  expect(proxy.seen.some((r) => r.method === 'POST' && /\/api\/sync\/push$/.test(r.url))).toBe(true)
})
