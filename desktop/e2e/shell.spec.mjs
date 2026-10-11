// ── Программа открывается и работает как сайт ──
//
// Запускается настоящая программа и проходит путь человека: вход, касса, продажа,
// перезагрузка окна, закрытие и повторный запуск, выход. Заодно проверяется то,
// ради чего интерфейс отделён от основной части: ключа входа в окне нет, в интернет
// окно не ходит, на чужую страницу не уходит.
//
// Работа без интернета проверяется отдельно — offline.spec.mjs.
//
// Перед запуском:  npm run electron:build -- --dir   (нужен собранный интерфейс)
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, electronBinary, electronEnv } from '../scripts/env.mjs'
import { API, freshUserData, goTo, launchApp, moneyValue, PASS, readLocal, server, serverLogin, signIn, USER } from './app.mjs'

test.describe.configure({ mode: 'serial' })

// Одна папка данных на весь файл: так проверяется и «закрыли — открыли снова»
const userData = freshUserData()
let app = null
let page = null
let token = ''
let code = ''
let product = null

// Запрос окна к основной части программы — тем же путём, каким ходит интерфейс
const ask = (method, path, body) => page.evaluate((req) => window.apteka.request(req), { method, path, body })

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS — логин и пароль владельца тестовой аптеки').toBeTruthy()
  token = await serverLogin()
  code = (await server(token, 'GET', '/auth/me')).pharmacy.code
  // Товар, который точно есть на складе и продаётся целыми упаковками
  const all = await server(token, 'GET', '/products')
  product = all.find((p) => p.stock >= 5 && (p.unitsPerPack || 1) === 1 && !p.expiredUnits)
  expect(product, 'в тестовой аптеке нет товара с остатком').toBeTruthy()
  ;({ app, page } = await launchApp({ userData }))
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
})

test('программа открывается на экране входа, у своего адреса', async () => {
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  expect(page.url()).toMatch(/^app:\/\/apteka\/index\.html/)
  await expect(page).toHaveTitle(/Аптека/)
})

test('окно — обычная страница: ни Node, ни доступа к системе', async () => {
  const env = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    bridge: Object.keys(window.apteka || {}).sort(),
    desktop: window.apteka?.desktop,
  }))
  expect(env.require).toBe('undefined')
  expect(env.process).toBe('undefined')
  expect(env.module).toBe('undefined')
  expect(env.desktop).toBe(true)
  // Мост — короткий и известный наперёд список. Появится лишнее — увидим здесь
  expect(env.bridge).toEqual(['backup', 'desktop', 'info', 'print', 'realtime', 'request', 'session', 'sync', 'update'])
})

test('шрифт свой, а не из интернета', async () => {
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    await document.fonts.load('600 16px Inter', 'Касса қ')
    return {
      inter: document.fonts.check('600 16px Inter', 'Касса қ'),
      remote: [...document.querySelectorAll('link')].filter((l) => /^https?:/.test(l.href)).map((l) => l.href),
    }
  })
  expect(fonts.remote, 'страница ссылается на адреса в интернете').toEqual([])
  expect(fonts.inter, 'шрифт Inter не загрузился из файлов программы').toBe(true)
})

test('вход: ключ остаётся в основной части, окно получает только пометку', async () => {
  await signIn(page)
  const seen = await page.evaluate(() => {
    const all = {}
    for (let i = 0; i < localStorage.length; i++) all[localStorage.key(i)] = localStorage.getItem(localStorage.key(i))
    return { token: all.apteka_token, dump: JSON.stringify(all) }
  })
  expect(seen.token).toBe('desktop')
  // Настоящий ключ — две части через точку, первая из которых раскрывается в запись
  // с номером учётной записи. Ничего похожего в хранилище окна быть не должно
  expect(seen.dump.includes(token.split('.')[0].slice(0, 40)), 'в окно попал ключ входа').toBe(false)
  expect(/eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/.test(seen.dump), 'в хранилище окна лежит что-то похожее на ключ').toBe(false)

  // А на диске он есть — и зашифрован
  const file = join(userData, 'session.json')
  expect(existsSync(file), 'ключ входа не сохранён').toBe(true)
  const raw = readFileSync(file, 'utf8')
  expect(/eyJ[A-Za-z0-9_-]{30,}/.test(raw), 'ключ входа лежит на диске открытым текстом').toBe(false)
})

test('разделы открываются, адрес раздела пишется после решётки', async () => {
  await goTo(page, 'Касса')
  await expect(page.locator('.scan-input')).toBeVisible()
  expect(page.url()).toMatch(/^app:\/\/apteka\/index\.html#\/pos$/)
  await goTo(page, 'Товары')
  expect(page.url()).toMatch(/#\/products$/)
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 })
})

test('сканер печатает как клавиатура — товар встаёт в чек, продажа проходит', async () => {
  await goTo(page, 'Касса')
  await page.locator('.scan-input').fill(product.name)
  await expect(page.locator('.kc-row').first()).toContainText(product.name, { timeout: 30_000 })
  await page.locator('.scan-input').fill('')

  // Сканер шлёт знаки с разрывом в единицы миллисекунд и сам дожимает Enter
  await page.locator('.scan-input').focus()
  await page.keyboard.type(product.barcode + '\n', { delay: 3 })
  const row = page.locator('.kassa-table tbody tr', { hasText: product.name })
  await expect(row).toBeVisible()
  expect(moneyValue(await page.locator('.kassa-itogo .total-row.big span').last().textContent())).toBe(Number(product.price))

  await page.getByRole('button', { name: /Провести продажу/ }).click()
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText(product.name)

  // Продажа должна лечь на диск этого компьютера, а не остаться нарисованной в окне:
  // чек — в локальной базе, операция — в очереди
  await expect
    .poll(() => readLocal(userData, code, "SELECT COUNT(*) AS n FROM outbox WHERE type = 'sale'")?.[0]?.n, { timeout: 30_000 })
    .toBe(1)
  const [op] = readLocal(userData, code, "SELECT payload FROM outbox WHERE type = 'sale'")
  const sale = JSON.parse(op.payload).sale
  expect(sale.items[0].name).toBe(product.name)
  const local = (await ask('GET', '/products')).data.find((p) => p.id === product.id)
  expect(local.stock).toBe(product.stock - 1)

  // Интернет есть — очередь уходит на сервер сама, и чек там тот же самый
  await expect
    .poll(() => readLocal(userData, code, "SELECT state FROM outbox WHERE type = 'sale'")?.[0]?.state, { timeout: 30_000, message: 'чек не ушёл на сервер' })
    .toBe('done')
  const onServer = (await server(token, 'GET', '/sales')).find((s) => s.id === sale.id)
  expect(onServer, 'чека нет на сервере').toBeTruthy()
  expect(onServer.date).toBe(sale.date)
  expect((await server(token, 'GET', '/products')).find((p) => p.id === product.id).stock).toBe(product.stock - 1)
  expect(readLocal(userData, code, "SELECT sync FROM docs WHERE kind = 'sale' AND id = ?", sale.id)[0].sync).toBe('synced')
})

test('чек печатается: страница для печати собирается', async () => {
  // Сам диалог печати Windows из проверки не нажать. Проверяем то, что идёт в печать:
  // программа превращает открытый чек в печатный лист — тем же путём, что и принтер
  const pdf = await app.evaluate(async ({ BrowserWindow }) => {
    const data = await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: false })
    return { size: data.length, head: data.subarray(0, 5).toString('latin1') }
  })
  expect(pdf.head).toBe('%PDF-')
  expect(pdf.size).toBeGreaterThan(2000)
  expect(await page.evaluate(() => typeof window.print)).toBe('function')
  await page.locator('.modal').getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()
})

test('изменение на сервере доходит до окна само, без перезагрузки', async () => {
  // Постоянное соединение держит основная часть программы и пересылает события в окно
  await page.locator('.scan-input').fill(product.name)
  const line = page.locator('.kc-row', { hasText: product.name }).first()
  await expect(line).toBeVisible()
  const newPrice = Number(product.price) + 7
  await server(token, 'PATCH', `/products/${product.id}`, { price: newPrice })
  try {
    await expect(line, 'новая цена не пришла в окно').toContainText(String(newPrice), { timeout: 20_000 })
  } finally {
    await server(token, 'PATCH', `/products/${product.id}`, { price: Number(product.price) })
    await page.locator('.scan-input').fill('')
  }
})

test('пересчёт остатков в программе: насчитанное применяется на сервере и доходит до кассы', async () => {
  // Пересчёт — раздел, которому нужен сервер: окно ходит к нему через основную часть
  // программы. Здесь проверяется весь путь страницы пересчёта этой дорогой: свежий
  // лист, одно «применить» с числами — и остаток на сервере и в локальной базе кассы
  const tag = 'APP-' + Date.now().toString(36)
  const cat = await server(token, 'POST', '/categories', { name: tag + '-kat', noExpiry: true })
  const item = await server(token, 'POST', '/products', { name: tag + ' Пересчёт', barcode: '275' + String(Date.now()).slice(-10), category: cat.name, cost: 10, price: 20, stock: 6, minStock: 0, unitsPerPack: 1, unit: 'уп' })
  try {
    await goTo(page, 'Инвентаризация')
    // Новая категория приходит в программу с ближайшим обменом
    const scope = page.locator('[data-tour="inv.scope"] select')
    await expect(scope.locator('option', { hasText: cat.name })).toHaveCount(1, { timeout: 30_000 })
    await scope.selectOption(cat.name)
    await page.locator('[data-tour="inv.create"]').click()
    const row = page.locator('tbody tr', { hasText: item.name })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.locator('input').fill('4')
    await page.locator('[data-tour="inv.apply"]').click()
    await page.locator('.overlay .modal').getByRole('button', { name: 'Применить', exact: true }).click()

    await expect
      .poll(async () => (await server(token, 'GET', '/products')).find((x) => x.id === item.id)?.stock, { timeout: 30_000, message: 'на сервере остаток не изменился' })
      .toBe(4)
    const sheet = (await server(token, 'GET', '/inventory')).find((x) => x.scope === cat.name)
    expect([sheet.status, sheet.items[0].actualUnits]).toEqual(['applied', 4])
    // Касса узнаёт о новом остатке сама: её локальная база забирает изменение с сервера
    await expect
      .poll(async () => (await ask('GET', '/products')).data.find((x) => x.id === item.id)?.stock, { timeout: 30_000, message: 'до кассы новый остаток не дошёл' })
      .toBe(4)
    await expect(page.locator('.modal', { hasText: /Пересчёт не применён|Не удалось узнать|с другими числами/ })).toHaveCount(0)
    await expect(page.locator('tbody tr', { hasText: cat.name }).filter({ hasText: 'применён' })).toHaveCount(1)
  } finally {
    await server(token, 'DELETE', `/products/${item.id}`).catch(() => {})
    await server(token, 'DELETE', `/categories/${cat.id}`).catch(() => {})
    // Следующие проверки ждут кассу
    await goTo(page, 'Касса')
  }
})

test('камера для штрихкода работает, а микрофон программе не выдаётся', async () => {
  // Из всех разрешений программе нужна одна камера — ею читают код, когда нет сканера
  await page.locator('[data-tour="pos.camera"]').click()
  const modal = page.locator('.modal', { hasText: 'Сфотографировать и распознать' })
  await expect(modal).toBeVisible()
  // Кнопка снимка оживает, только когда камера действительно отдала картинку
  await expect(modal.getByRole('button', { name: /Сфотографировать и распознать/ }), 'камера не включилась').toBeEnabled({ timeout: 20_000 })
  const video = await page.evaluate(() => {
    const v = document.querySelector('.modal video')
    const track = v?.srcObject?.getVideoTracks?.()[0]
    return { live: track?.readyState, audio: v?.srcObject?.getAudioTracks?.().length }
  })
  expect(video.live).toBe('live')
  expect(video.audio).toBe(0)
  await modal.getByRole('button', { name: 'Отмена' }).click()
  await expect(modal).toBeHidden()

  const mic = await page.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (s) => {
        s.getTracks().forEach((t) => t.stop())
        return 'выдан'
      },
      (e) => e.name,
    ),
  )
  expect(mic, 'программа выдала доступ к микрофону').toBe('NotAllowedError')
  const geo = await page.evaluate(() => new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('выдана'), (e) => resolve('отказ ' + e.code), { timeout: 5000 })))
  expect(geo, 'программа выдала геолокацию').toMatch(/^отказ/)
})

test('перезагрузка окна возвращает в тот же раздел и не просит входа', async () => {
  // На сайте адрес раздела — настоящий. У программы хостинга нет, и /pos означал бы
  // файл, которого не существует: после перезагрузки был бы пустой экран
  expect(page.url()).toMatch(/#\/pos$/)
  await page.reload()
  await expect(page.locator('.scan-input')).toBeVisible({ timeout: 30_000 })
  expect(page.url()).toMatch(/#\/pos$/)
  await expect(page.locator('.login-card')).toHaveCount(0)
})

test('окно не может обратиться в интернет', async () => {
  const res = await page.evaluate(async (api) => {
    const tryFetch = (url) => fetch(url).then((r) => 'прошёл: ' + r.status, () => 'закрыто')
    const tryImage = (url) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve('прошла')
        img.onerror = () => resolve('закрыто')
        img.src = url
      })
    return {
      api: await tryFetch(api + '/health'),
      other: await tryFetch('https://example.com/'),
      image: await tryImage('https://www.google.com/favicon.ico'),
    }
  }, API)
  // Даже до своего сервера окно само не достаёт — только через основную часть
  expect(res).toEqual({ api: 'закрыто', other: 'закрыто', image: 'закрыто' })
})

test('окно не уходит на чужую страницу и не открывает новых окон', async () => {
  const before = page.url()
  const opened = await page.evaluate(() => {
    const w = window.open('https://example.com/')
    return w === null ? 'нет' : 'открылось'
  })
  expect(opened).toBe('нет')
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(1200)
  expect(page.url()).toBe(before)
  expect(app.windows().length).toBe(1)
})

test('мост не выполняет запрос на посторонний адрес', async () => {
  const r = await page.evaluate(() => window.apteka.request({ method: 'GET', path: 'https://example.com/steal' }))
  expect(r.status).toBe(400)
  const up = await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/../../etc' }))
  expect(up.status).toBe(400)
})

test('вторая копия программы не запускается', async () => {
  // Две копии работали бы с одним ключом входа, каждая со своим представлением
  // о том, что отправлено на сервер
  const second = spawn(electronBinary(), ['.'], { cwd: DESKTOP, env: electronEnv({ APTEKA_USER_DATA: userData }), stdio: 'ignore' })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      second.kill()
      resolve('не закрылась')
    }, 20_000)
    second.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  expect(code, 'вторая копия осталась работать').toBe(0)
  expect(app.windows().length).toBe(1)
})

test('закрыли программу и открыли снова — вход сохранился', async () => {
  await app.close()
  ;({ app, page } = await launchApp({ userData }))
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.login-card')).toHaveCount(0)
  // И сервер по-прежнему отвечает этому входу
  await goTo(page, 'Товары')
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 })
})

test('выход: за кассой никого — окно без пароля ничего не получает', async () => {
  await page.locator('.su-logout').click()
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  // Ни из локальной базы, ни с сервера: без входа основная часть не выполняет ничего
  for (const [method, path] of [['GET', '/products'], ['GET', '/auth/me'], ['GET', '/users'], ['POST', '/sales']]) {
    expect((await ask(method, path, {})).status, `${method} ${path}`).toBe(401)
  }
  // Файл с ключами остаётся: ими уйдёт на сервер сделанное без связи. Но он зашифрован,
  // и окну от него никакой пользы — в хранилище окна входа уже нет
  expect(/eyJ[A-Za-z0-9_-]{30,}/.test(readFileSync(join(userData, 'session.json'), 'utf8'))).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('apteka_token'))).toBe(null)
  // После перезапуска программа тоже встречает экраном входа
  await app.close()
  ;({ app, page } = await launchApp({ userData }))
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  expect((await ask('GET', '/products')).status).toBe(401)
})

test('неверный пароль — понятный отказ, а не молчание', async () => {
  await page.locator('#lg-name').fill(USER)
  await page.locator('#lg-pw').fill('совсем-не-тот-пароль')
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.login-card')).toContainText(/Неверное имя или пароль/, { timeout: 30_000 })
  await expect(page.locator('.sidebar')).toHaveCount(0)
  expect((await ask('GET', '/products')).status).toBe(401)
})

test('владельцу сервиса программа отвечает, что его место на сайте', async () => {
  // Программа сделана для аптеки. У владельца сервиса ни кассы, ни склада нет —
  // его панель целиком живёт на сайте
  const adminPass = process.env.ADMIN_PASS
  test.skip(!adminPass, 'нужен ADMIN_PASS — пароль владельца сервиса')
  await page.locator('#lg-name').fill(process.env.ADMIN_USER || 'admin')
  await page.locator('#lg-pw').fill(adminPass)
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.login-card')).toContainText('работает на сайте', { timeout: 30_000 })
  await expect(page.locator('.sidebar')).toHaveCount(0)
  // Его вход в программе не остаётся — ни в окне, ни в основной части
  expect(await page.evaluate(() => localStorage.getItem('apteka_token'))).toBe(null)
  expect((await ask('GET', '/admin/pharmacies')).status).toBe(401)
})
