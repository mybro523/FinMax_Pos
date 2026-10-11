// ── Печать на чековом принтере ──
//
// Настоящего чекового принтера у проверки нет. Вместо него — приёмник на этом же
// компьютере: чековые принтеры с сетевым гнездом печатают всё, что пришло им на
// порт, и приёмник ведёт себя так же — только не печатает, а запоминает. Так
// проверяется весь путь: настройка в программе → кнопка «Печать» → байты у принтера.
//
// Что это НЕ проверяет: как эти байты выглядят на бумаге у конкретной модели.
// Для этого в настройках есть «Пробная печать».
//
// Перед запуском:  npm run electron:build -- --dir   (нужен собранный интерфейс)
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import net from 'node:net'
import { freshUserData, goTo, launchApp, PASS, server, serverLogin, signIn, USER } from './app.mjs'

test.describe.configure({ mode: 'serial' })

const TAG = 'PRN-' + Date.now().toString(36)
const userData = freshUserData()
let app = null
let page = null
let token = ''
let X = null
let printer = null

// «Принтер»: запоминает каждое пришедшее задание
function fakePrinter() {
  const jobs = []
  const srv = net.createServer((socket) => {
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => jobs.push(Buffer.concat(chunks)))
    socket.on('error', () => {})
  })
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, jobs, close: () => new Promise((r) => srv.close(r)) })),
  )
}

// Байты принтера обратно в текст (таблица CP866), команды выкидываются
function text866(buf) {
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x1b) {
      i += buf[i + 1] === 0x40 ? 1 : buf[i + 1] === 0x70 ? 4 : 2
      continue
    }
    if (b === 0x1d) {
      i += buf[i + 1] === 0x56 ? 3 : 2
      continue
    }
    if (b === 0x0a) out += '\n'
    else if (b < 0x80) out += String.fromCharCode(b)
    else if (b <= 0xaf) out += String.fromCharCode(b - 0x80 + 0x410)
    else if (b >= 0xe0 && b <= 0xef) out += String.fromCharCode(b - 0xe0 + 0x440)
    else if (b === 0xf0) out += 'Ё'
    else if (b === 0xf1) out += 'ё'
    else if (b === 0xfc) out += '№'
    else out += '?'
  }
  return out
}

const panel = () => page.getByTestId('print-panel')
const jobsCount = (n) => expect.poll(() => printer.jobs.length, { timeout: 20_000, message: 'задание не дошло до принтера' }).toBe(n)

async function sellOne() {
  await goTo(page, 'Касса')
  const scan = page.locator('.scan-input')
  if (await scan.inputValue()) await scan.fill('')
  await scan.focus()
  await page.keyboard.type(X.barcode + '\n', { delay: 3 })
  await expect(page.locator('.kassa-table tbody tr', { hasText: X.name })).toBeVisible()
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  return receipt
}

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS — логин и пароль владельца тестовой аптеки').toBeTruthy()
  token = await serverLogin()
  X = await server(token, 'POST', '/products', {
    name: `${TAG} Нурофен`, barcode: '276' + String(Date.now()).slice(-9) + '1', category: 'Таблетки', price: 150, cost: 100, stock: 20, minStock: 0, unitsPerPack: 1, expiryDate: '2028-01-31',
  })
  printer = await fakePrinter()
  ;({ app, page } = await launchApp({ userData }))
  // Окно печати Windows проверка нажать не может — подменяем его счётчиком
  await page.addInitScript(() => {
    window.__printed = 0
    window.print = () => {
      window.__printed++
    }
  })
  await page.reload()
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  await printer?.close()
  if (X) await server(token, 'DELETE', `/products/${X.id}`).catch(() => {})
})

test('по умолчанию печать обычная — как на сайте, через окно печати', async () => {
  await signIn(page)
  await goTo(page, 'Настройки')
  await expect(panel()).toBeVisible()
  await expect(panel().getByTestId('print-mode')).toHaveValue('system')
  // Пока чековый принтер не выбран, его настроек на экране нет
  await expect(panel().getByTestId('print-width')).toHaveCount(0)

  const receipt = await sellOne()
  await receipt.getByRole('button', { name: 'Печать' }).click()
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1)
  expect(printer.jobs.length).toBe(0)
  await receipt.getByRole('button', { name: 'Готово' }).click()
})

test('чековый принтер по сети: пробная печать доходит до принтера и читается', async () => {
  await goTo(page, 'Настройки')
  await panel().getByTestId('print-mode').selectOption('network')
  await panel().getByTestId('print-host').fill('127.0.0.1')
  await panel().getByTestId('print-port').fill(String(printer.port))
  await panel().getByTestId('print-width').selectOption('48')
  await panel().getByRole('button', { name: 'Пробная печать' }).click()
  await expect(page.locator('.toast')).toContainText('Пробный чек отправлен на принтер', { timeout: 20_000 })
  await jobsCount(1)

  const job = printer.jobs[0]
  // Сброс принтера и таблица русских букв — первым делом; отрез — последним
  expect([...job.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 17])
  expect([...job.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
  const text = text866(job)
  expect(text).toContain('Пробная печать')
  expect(text).toContain('АБВГД абвгд ЁЖЗ')
  expect(text.split('\n').every((l) => l.length <= 48)).toBe(true)
  expect(text).toContain('-'.repeat(48))
})

test('адрес принтера — только из сети аптеки: чужой адрес программа не принимает и прежнюю настройку не портит', async () => {
  // Окну сеть закрыта целиком, и печать не должна стать для него дорогой наружу
  const refusal = page.locator('.toast', { hasText: 'Адрес принтера должен быть из сети аптеки' })
  await goTo(page, 'Настройки')
  await panel().getByTestId('print-host').fill('collector.example.org')
  await panel().getByRole('button', { name: 'Сохранить' }).click()
  await expect(refusal.first()).toBeVisible()
  // Введённое осталось на экране — его поправят; а в программе адрес прежний
  await expect(panel().getByTestId('print-host')).toHaveValue('collector.example.org')
  expect((await page.evaluate(() => window.apteka.print.config())).host).toBe('127.0.0.1')

  // «Пробная печать» с таким адресом никуда не идёт
  await expect(refusal).toHaveCount(0, { timeout: 15_000 })
  const before = printer.jobs.length
  await panel().getByRole('button', { name: 'Пробная печать' }).click()
  await expect(refusal.first()).toBeVisible()
  expect(printer.jobs.length).toBe(before)

  // И мимо экрана, прямо через мост, — тоже: ни имя, ни адрес в интернете
  for (const host of ['collector.example.org', '8.8.8.8']) {
    expect(await page.evaluate((h) => window.apteka.print.setConfig({ mode: 'network', host: h, port: 443 }), host)).toEqual({ refused: 'host' })
  }
  const kept = await page.evaluate(() => window.apteka.print.config())
  expect([kept.mode, kept.host, kept.port]).toEqual(['network', '127.0.0.1', printer.port])

  await panel().getByTestId('print-host').fill('127.0.0.1')
})

test('чек печатается сам после продажи, если так настроено, — и по кнопке ещё раз', async () => {
  await panel().getByTestId('print-auto').check()
  await panel().getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.locator('.toast')).toContainText('Сохранено')

  const receipt = await sellOne()
  await jobsCount(2)
  const text = text866(printer.jobs[1])
  const lines = text.split('\n')
  expect(lines).toContain(X.name)
  expect(lines.some((l) => /^ {2}1 уп x 150 сомони +150 сомони$/.test(l)), 'количество слева, сумма у правого края:\n' + text).toBe(true)
  expect(lines.some((l) => /^Итого +150 сомони$/.test(l))).toBe(true)
  expect(lines.some((l) => /^Оплата +Наличные$/.test(l))).toBe(true)
  expect(text).toContain(`Кассир: ${USER}`)
  expect(text).toContain('Спасибо за покупку!')
  // Окно печати при этом не открывалось
  expect(await page.evaluate(() => window.__printed)).toBe(1)

  await receipt.getByRole('button', { name: 'Печать' }).click()
  await jobsCount(3)
  expect(text866(printer.jobs[2])).toBe(text)
  await receipt.getByRole('button', { name: 'Готово' }).click()
})

test('Z-отчёт смены печатается на том же принтере', async () => {
  await goTo(page, 'Смена кассы')
  await page.locator('#openCash').fill('100')
  await page.getByRole('button', { name: 'Открыть смену' }).click()
  await expect(page.locator('.toast')).toContainText('Смена открыта')
  await page.getByRole('button', { name: 'Закрыть смену' }).click()
  const dialog = page.locator('.modal', { hasText: 'Закрытие смены' })
  await dialog.locator('input').first().fill('100')
  await dialog.getByRole('button', { name: 'Закрыть смену' }).click()
  const report = page.locator('.modal', { hasText: 'Z-отчёт смены' })
  await expect(report).toBeVisible()
  const before = printer.jobs.length
  await report.getByRole('button', { name: 'Печать' }).click()
  await jobsCount(before + 1)
  const text = text866(printer.jobs.at(-1))
  expect(text).toContain('Z-отчёт смены')
  expect(text.split('\n').some((l) => /^Касса на старте +100 сомони$/.test(l))).toBe(true)
  expect(text.split('\n').some((l) => /^Расхождение +0 сомони$/.test(l))).toBe(true)
  await report.getByRole('button', { name: 'Готово' }).click()
})

test('принтер выключен — продажа всё равно проходит, а кассир видит, почему чек не напечатан', async () => {
  await printer.close()
  const receipt = await sellOne()
  await expect(page.locator('.toast.err')).toContainText('Не удалось связаться с принтером', { timeout: 20_000 })
  // Чек при этом пробит и сохранён: печать — не условие продажи
  await expect(receipt).toContainText(X.name)
  await receipt.getByRole('button', { name: 'Готово' }).click()
  const sales = (await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/sales' }))).data
  expect(sales.filter((s) => s.items.some((i) => i.productId === X.id)).length).toBe(3)
})

test('настройка печати помнится после перезапуска программы', async () => {
  await app.close()
  ;({ app, page } = await launchApp({ userData }))
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await goTo(page, 'Настройки')
  await expect(panel().getByTestId('print-mode')).toHaveValue('network')
  await expect(panel().getByTestId('print-host')).toHaveValue('127.0.0.1')
  await expect(panel().getByTestId('print-width')).toHaveValue('48')
  await expect(panel().getByTestId('print-auto')).toBeChecked()
})
