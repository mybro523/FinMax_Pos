// ── Расхождения с касс на панели владельца ──
// Программа для Windows продаёт и без интернета, а сервер принимает её чеки позже.
// Если что-то не сошлось с базой, владелец должен увидеть это на панели управления
// и отметить, когда разберётся.
//
// Кассу здесь играет сама проверка: присылает серверу чеки так, как прислала бы
// программа. Из браузера такого не сделать — у сайта интернет есть всегда.
import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { login, goTo, tag, barcode } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Последняя'
// Кассы проверки — одни и те же от прогона к прогону: иначе в магазине копились бы
// десятки касс, которых никогда не было
const KASSA_1 = '00000000-0000-4000-8000-0000000e2e01'
const KASSA_2 = '00000000-0000-4000-8000-0000000e2e02'

test.describe.configure({ mode: 'serial' })

// Адрес сервера и ключ входа берём у самой страницы: сайт знает, куда ходит
async function server(page) {
  const seen = page.waitForRequest((r) => /\/api\//.test(r.url()), { timeout: 30000 })
  await login(page)
  const api = (await seen).url().replace(/\/api\/.*$/, '/api')
  const token = await page.evaluate(() => localStorage.getItem('apteka_token'))
  const call = async (method, path, data) => {
    const res = await page.request.fetch(api + path, { method, data, headers: { Authorization: 'Bearer ' + token } })
    const text = await res.text()
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${text}`)
    return text ? JSON.parse(text) : null
  }
  return { call }
}

// Чек, каким его записала бы касса без интернета
function saleOp(product, price = product.price) {
  const id = randomUUID()
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'sale',
    createdAt: now,
    payload: {
      sale: {
        id, clientId: 'tmp_' + id.slice(0, 8), date: now,
        total: price, cost: product.cost, profit: price - product.cost,
        payment: 'cash', customerId: null, shiftId: null,
        items: [{ id: randomUUID(), saleId: id, productId: product.id, name: product.name, qty: 1, pieces: 0, unitsPerPack: 1, price, cost: product.cost, discount: 0 }],
      },
    },
  }
}

let product

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  const { call } = await server(page)
  product = await call('POST', '/products', { name: NAME, barcode: barcode(), category: 'Таблетки', cost: 10, price: 30, stock: 1, minStock: 0, unitsPerPack: 1, unit: 'уп' })

  // Две кассы без связи продали одну и ту же последнюю упаковку
  const push = (deviceId, op) => call('POST', '/sync/push', { deviceId, appVersion: 'ui-test', ops: [op] })
  const a = await push(KASSA_1, saleOp(product))
  const b = await push(KASSA_2, saleOp(product))
  expect([a.results[0].status, b.results[0].status]).toEqual(['ok', 'ok'])
  // И третий чек — с ценой, которой у товара никогда не было
  const c = await push(KASSA_2, saleOp(product, 1))
  expect(c.results[0].status).toBe('ok')
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  const { call } = await server(page)
  // Вдруг проверка упала раньше, чем разобрала свои записи
  for (const d of await call('GET', '/discrepancies')) {
    if (d.productId === product?.id) await call('POST', `/discrepancies/${d.id}/resolve`, {})
  }
  if (product) await call('DELETE', '/products/' + product.id).catch(() => {})
  await page.close()
})

const rows = (page) => page.getByTestId('discrepancies').locator('.rash-row', { hasText: NAME })

test('владелец видит на панели, что с кассы пришло не то, что в базе', async ({ page }) => {
  await login(page)
  await goTo(page, 'Панель управления')
  const block = page.getByTestId('discrepancies')
  await expect(block).toBeVisible()
  await expect(block).toContainText('Расхождения с касс')
  // Чека три, расхождений три: один раз не хватило остатка на вторую кассу,
  // один раз — на третью, и у третьего чека ещё и цена не та
  await expect(rows(page)).toHaveCount(3)
  const oversold = rows(page).filter({ hasText: 'Продано больше, чем было на складе' })
  await expect(oversold).toHaveCount(2)
  await expect(oversold.first()).toContainText('сверх остатка 1 шт')
  await expect(oversold.first()).toContainText('Касса')
  const price = rows(page).filter({ hasText: 'Цена в чеке не та, что была в базе' })
  await expect(price).toHaveCount(1)
  await expect(price).toContainText('в чеке 1 сомони, в базе 30 сомони')
})

test('на телефоне блок помещается в экран', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await login(page)
  await expect(rows(page).first()).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'страница шире экрана телефона').toBeLessThanOrEqual(0)
  const button = rows(page).first().getByRole('button', { name: 'Разобрался' })
  const box = await button.boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(360)
})

test('на таджикском блок переведён', async ({ page }) => {
  await login(page)
  await page.evaluate(() => localStorage.setItem('apteka_lang', 'tg'))
  await page.reload()
  const block = page.getByTestId('discrepancies')
  await expect(block).toContainText('Фарқиятҳо аз кассаҳо')
  await expect(rows(page).filter({ hasText: 'зиёда аз бақия 1 дона' })).toHaveCount(2)
  await expect(rows(page).filter({ hasText: 'дар чек 1 сомони, дар пойгоҳ 30 сомони' })).toHaveCount(1)
  await expect(rows(page).first().getByRole('button')).toHaveText('Ҳал кардам')
  await page.evaluate(() => localStorage.setItem('apteka_lang', 'ru'))
})

test('владелец видит свои кассы в настройках и называет их по-своему — имя доходит до расхождений', async ({ page }) => {
  // server() сам входит и открывает первую страницу — поэтому сначала он, потом раздел
  const { call } = await server(page)
  const second = (await call('GET', '/sync/devices')).find((d) => d.id === KASSA_2)
  await goTo(page, 'Настройки')
  const panel = page.getByTestId('devices')
  await expect(panel).toBeVisible()
  const line = panel.locator('tbody tr', { hasText: second.name }).first()
  await expect(line).toBeVisible()
  await expect(line).toContainText('ui-test')

  const fresh = 'Ночная ' + TAG
  await line.getByRole('button', { name: 'Переименовать' }).click()
  const ask = page.locator('.overlay .modal', { hasText: 'Переименовать кассу' })
  await ask.locator('input').first().fill(fresh)
  await ask.getByRole('button', { name: 'Переименовать' }).click()
  await expect(page.locator('.toast')).toContainText('Касса переименована')
  await expect(panel.locator('tbody tr', { hasText: fresh })).toBeVisible()

  // Новое имя — в расхождениях: владелец видит, на какой кассе это случилось
  await goTo(page, 'Панель управления')
  await expect(rows(page).filter({ hasText: fresh }).first()).toBeVisible()
  // Возвращаем прежнее имя: кассы у проверки общие на все прогоны
  await call('PATCH', '/sync/devices/' + KASSA_2, { name: second.name })
})

test('«Разобрался» убирает запись, и после перезагрузки она не возвращается', async ({ page }) => {
  await login(page)
  await goTo(page, 'Панель управления')
  await expect(rows(page)).toHaveCount(3)
  for (let left = 2; left >= 0; left--) {
    await rows(page).first().getByRole('button', { name: 'Разобрался' }).click()
    await expect(rows(page)).toHaveCount(left)
  }
  await page.reload()
  await expect(page.locator('.cards .metric').first()).toBeVisible()
  await expect(rows(page)).toHaveCount(0)
})

// ── Ещё два вида расхождений и смена кассы, которая сама её не закроет ──

test('пересчёт остатка и переплата долга: владелец видит и это', async ({ page }) => {
  const { call } = await server(page)
  const push = (ops) => call('POST', '/sync/push', { deviceId: KASSA_1, appVersion: 'ui-test', ops })
  const made = { products: [], customers: [] }
  try {
    // Касса без связи продала упаковку, а владелец тем временем поправил остаток в карточке
    const counted = await call('POST', '/products', { name: TAG + ' Пересчитанный', barcode: barcode(), category: 'Таблетки', cost: 10, price: 30, stock: 5, minStock: 0, unitsPerPack: 1, unit: 'уп' })
    made.products.push(counted.id)
    const early = saleOp(counted)
    const before = new Date(Date.now() - 10 * 60000).toISOString()
    early.createdAt = before
    early.payload.sale.date = before
    await call('PATCH', '/products/' + counted.id, { stock: 4 })
    expect((await push([early])).results[0].status).toBe('ok')
    expect((await call('GET', '/products')).find((p) => p.id === counted.id).stock, 'остаток не должен уменьшиться второй раз').toBe(4)

    // Клиент заплатил на кассе пятьдесят сомони, а долга за ним нет
    const debtor = { id: randomUUID(), name: TAG + ' Переплатил', phone: '', debt: 0, createdAt: new Date().toISOString() }
    made.customers.push(debtor.id)
    const pay = { id: randomUUID(), type: 'debt.pay', createdAt: new Date().toISOString(), payload: { payment: { id: randomUUID(), customerId: debtor.id, amount: 50, shiftId: null, createdAt: new Date().toISOString() } } }
    const r = await push([{ id: randomUUID(), type: 'customer.create', createdAt: new Date().toISOString(), payload: { customer: debtor } }, pay])
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok'])

    await goTo(page, 'Панель управления')
    const block = page.getByTestId('discrepancies')
    const late = block.locator('.rash-row', { hasText: counted.name })
    await expect(late).toContainText('Операция кассы пришла после пересчёта остатка')
    await expect(late).toContainText('1 шт — остаток не менялся')
    const over = block.locator('.rash-row', { hasText: debtor.name })
    await expect(over).toContainText('Сумма больше долга клиента')
    await expect(over).toContainText('принято 50 сомони, долг был 0 сомони')

    // И на таджикском
    await page.evaluate(() => localStorage.setItem('apteka_lang', 'tg'))
    await page.reload()
    await expect(page.getByTestId('discrepancies').locator('.rash-row', { hasText: counted.name })).toContainText('1 дона — бақия тағйир наёфт')
    await expect(page.getByTestId('discrepancies').locator('.rash-row', { hasText: debtor.name })).toContainText('қабул шуд 50 сомони, қарз буд 0 сомони')
    await page.evaluate(() => localStorage.setItem('apteka_lang', 'ru'))
  } finally {
    for (const d of await call('GET', '/discrepancies')) {
      if (made.products.includes(d.productId) || String(d.name).startsWith(TAG + ' Переплатил')) await call('POST', `/discrepancies/${d.id}/resolve`, {})
    }
    for (const id of made.products) await call('DELETE', '/products/' + id).catch(() => {})
    for (const id of made.customers) await call('DELETE', '/customers/' + id).catch(() => {})
  }
})

test('смену кассы, которая сама её уже не закроет, владелец закрывает в настройках', async ({ page }) => {
  const { call } = await server(page)
  // Кассы у проверки общие на все прогоны: вдруг прошлый оставил смену открытой
  const left = (await call('GET', '/sync/devices')).find((d) => d.id === KASSA_1)
  if (left?.openShift) await call('POST', `/sync/devices/${KASSA_1}/close-shift`, { countedCash: 0 })

  const shift = { id: randomUUID(), openedAt: new Date().toISOString(), openingCash: 100 }
  const opened = await call('POST', '/sync/push', { deviceId: KASSA_1, appVersion: 'ui-test', ops: [{ id: randomUUID(), type: 'shift.open', createdAt: shift.openedAt, payload: { shift } }] })
  expect(opened.results[0].status).toBe('ok')

  await goTo(page, 'Настройки')
  // По номеру кассы, а не по имени: имена у касс проверки могут совпадать
  const line = page.getByTestId('devices').locator(`tbody tr[data-device="${KASSA_1}"]`)
  await expect(line).toContainText('открыта с')
  await line.getByTestId('close-device-shift').click()
  const ask = page.locator('.overlay .modal', { hasText: 'Закрыть смену' })
  await expect(ask).toContainText('только если сама касса закрыть её уже не может')
  // Без суммы смена не закрывается
  await ask.getByRole('button', { name: 'Закрыть смену' }).click()
  await expect(page.locator('.toast')).toContainText('Укажите, сколько наличных в ящике')
  expect((await call('GET', '/sync/devices')).find((d) => d.id === KASSA_1).openShift?.id).toBe(shift.id)

  await line.getByTestId('close-device-shift').click()
  const again = page.locator('.overlay .modal', { hasText: 'Закрыть смену' })
  await again.locator('input').first().fill('90')
  await again.getByRole('button', { name: 'Закрыть смену' }).click()
  await expect(page.locator('.toast')).toContainText('Смена закрыта')
  await expect(line.getByTestId('close-device-shift')).toHaveCount(0)

  const closed = (await call('GET', '/shifts')).find((s) => s.id === shift.id)
  expect(closed.closedAt, 'смена закрыта на сервере').toBeTruthy()
  expect(Number(closed.countedCash)).toBe(90)
  expect(Number(closed.difference)).toBe(-10)
  expect((await call('GET', '/sync/devices')).find((d) => d.id === KASSA_1).openShift).toBeNull()
})
