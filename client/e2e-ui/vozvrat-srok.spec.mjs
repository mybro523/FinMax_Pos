// ── Возврат в продажу: срок годности возвращённого товара ──
// Товару, который возвращается на полку, нужен срок годности: без него он выпадает из
// контроля сроков. Раньше возвращённое получало срок партии, лежащей на складе, — а
// при пустом складе не получало никакого. Теперь срок ставит программа (самый ранний
// из тех, с какими товар продавался в день покупки), а кассир может вписать точный —
// с коробки, которую держит в руках. Здесь проверяется окно возврата: когда поле
// появляется, что уходит на сервер и что в итоге стоит в карточке товара.
import { test, expect } from '@playwright/test'
import { login, goTo, tag, toast, withServer } from './helpers.mjs'

const TAG = tag()
const CAT = TAG + '-srok'
const CAT_FREE = TAG + '-bez-sroka'
const LAST = TAG + ' Последняя пачка'
const BOXED = TAG + ' Срок с коробки'
const BINT = TAG + ' Бинт'

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const iso = (d) => d + 'T00:00:00.000Z'
const NEAR = day(200)
const FAR = day(500)

test.describe.configure({ mode: 'serial' })

// Адрес сервера и ключ входа берём у самой страницы: сайт знает, куда ходит
async function server(page) {
  const seen = page.waitForRequest((r) => /\/api\//.test(r.url()), { timeout: 30000 })
  await login(page)
  const api = (await seen).url().replace(/\/api\/.*$/, '/api')
  const token = await page.evaluate(() => localStorage.getItem('apteka_token'))
  return async (method, path, data) => {
    const res = await page.request.fetch(api + path, { method, data, headers: { Authorization: 'Bearer ' + token } })
    const text = await res.text()
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

const made = { products: [], categories: [] }
let last
let boxed
let bint
let n = 0

// Товар с одной упаковкой на складе — и сразу проданной: склад пуст
async function soldOut(call, name, category, expiryDate) {
  const p = await call('POST', '/products', { name, barcode: '274' + String(Date.now()).slice(-9) + ++n, category, cost: 10, price: 20, stock: 0, minStock: 0, unitsPerPack: 1, unit: 'уп' })
  made.products.push(p.id)
  await call('POST', '/arrivals', { supplier: TAG, items: [{ productId: p.id, qty: 1, cost: 10, ...(expiryDate ? { expiryDate } : {}) }] })
  await call('POST', '/sales', { items: [{ productId: p.id, qty: 1 }], payment: 'cash', clientId: `${TAG}-${n}` })
  return p
}
const cardOf = async (call, p) => (await call('GET', '/products')).find((x) => x.id === p.id)

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  for (const [name, noExpiry] of [[CAT, false], [CAT_FREE, true]]) made.categories.push((await call('POST', '/categories', { name, noExpiry })).id)
  last = await soldOut(call, LAST, CAT, NEAR)
  boxed = await soldOut(call, BOXED, CAT, NEAR)
  bint = await soldOut(call, BINT, CAT_FREE, null)
  expect([(await cardOf(call, last)).stock, (await cardOf(call, last)).expiryDate], 'склад пуст, срока в карточке нет').toEqual([0, null])
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  for (const id of made.products) await call('DELETE', '/products/' + id).catch(() => {})
  for (const id of made.categories) await call('DELETE', '/categories/' + id).catch(() => {})
  await page.close()
})

// Открыть чек с этим товаром в окне возврата
async function openReceipt(page, name) {
  await goTo(page, 'Возврат товара')
  await page.getByPlaceholder('Поиск чека по товару или сумме…').fill(name)
  const sale = page.locator('tbody tr', { hasText: name }).first()
  await expect(sale).toBeVisible()
  await sale.getByRole('button', { name: /Выбрать/ }).click()
  const form = page.locator('.panel', { hasText: 'Что возвращают' })
  await expect(form).toBeVisible()
  return { form, line: form.locator('tbody tr', { hasText: name }) }
}
const submit = (page, form) => withServer(page, '/returns', () => form.getByRole('button', { name: /Оформить возврат/ }).click())
const closeDone = async (page) => {
  const done = page.locator('.modal', { hasText: 'Возврат оформлен' })
  await expect(done).toBeVisible()
  await done.getByRole('button', { name: 'Готово' }).click()
}

test('последнюю упаковку вернули в продажу: срок кассир не вписывал — товар всё равно получает срок, а не остаётся без него', async ({ page }) => {
  const call = await server(page)
  const { form, line } = await openReceipt(page, LAST)

  // Пока не сказано, сколько возвращают, спрашивать срок не о чем
  await expect(line.locator('.ret-expiry')).toHaveCount(0)
  await line.locator('input.disc-input').fill('1')
  const field = line.locator('.ret-expiry')
  await expect(field).toBeVisible()
  await expect(field).toContainText('Срок на упаковке')
  await expect(field).toContainText('программа поставит срок сама')
  // Срок нужен только тому, что идёт на полку
  await line.locator('select').selectOption('off')
  await expect(line.locator('.ret-expiry')).toHaveCount(0)
  await line.locator('select').selectOption('stock')
  await expect(field).toBeVisible()

  const res = await submit(page, form)
  expect(res.request().postDataJSON().items, 'срок не вписан — на сервер он и не уходит').toEqual([{ productId: last.id, units: 1, restock: true }])
  await closeDone(page)
  const card = await cardOf(call, last)
  expect([card.stock, card.expiryDate], 'товар на полке — со сроком партии, из которой был продан').toEqual([1, iso(NEAR)])
})

test('кассир вписал срок с коробки — в карточке товара стоит именно он; истёкший срок в продажу не принимается', async ({ page }) => {
  const call = await server(page)
  const { form, line } = await openReceipt(page, BOXED)
  await line.locator('input.disc-input').fill('1')
  const date = line.locator('.ret-expiry input[type="date"]')

  // Истёкший срок: такой товар не возвращают в продажу — и запрос не уходит вовсе
  const sent = []
  page.on('request', (r) => r.url().includes('/returns') && r.method() === 'POST' && sent.push(r.url()))
  await date.fill(day(-3))
  await form.getByRole('button', { name: /Оформить возврат/ }).click()
  await expect(toast(page).filter({ hasText: 'Срок на упаковке уже истёк' })).toBeVisible()
  expect(sent, 'возврат с истёкшим сроком не отправлялся').toEqual([])
  expect((await cardOf(call, boxed)).stock, 'и на полке ничего не появилось').toBe(0)

  await date.fill(FAR)
  const res = await submit(page, form)
  expect(res.request().postDataJSON().items).toEqual([{ productId: boxed.id, units: 1, restock: true, expiryDate: FAR }])
  await closeDone(page)
  const card = await cardOf(call, boxed)
  expect([card.stock, card.expiryDate], 'срок — тот, что вписан с коробки').toEqual([1, iso(FAR)])
})

test('товар без срока годности (бинты, приборы): срок не спрашивается и не появляется', async ({ page }) => {
  const call = await server(page)
  const { form, line } = await openReceipt(page, BINT)
  await line.locator('input.disc-input').fill('1')
  await expect(line.locator('select')).toBeEnabled()
  await expect(form.locator('.ret-expiry')).toHaveCount(0)
  const res = await submit(page, form)
  expect(res.request().postDataJSON().items).toEqual([{ productId: bint.id, units: 1, restock: true }])
  await closeDone(page)
  const card = await cardOf(call, bint)
  expect([card.stock, card.expiryDate]).toEqual([1, null])
})

test('на телефоне поле срока помещается в окно возврата', async ({ page }) => {
  const call = await server(page)
  // Ещё одна продажа того же товара — чтобы было что возвращать
  await call('POST', '/sales', { items: [{ productId: last.id, qty: 1 }], payment: 'cash', clientId: `${TAG}-phone` })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.reload()
  await expect(page.locator('.topbar h1')).toBeVisible()
  await page.goto('/returns')
  await page.getByPlaceholder('Поиск чека по товару или сумме…').fill(LAST)
  const sale = page.locator('tbody tr', { hasText: LAST }).first()
  await expect(sale).toBeVisible()
  await sale.getByRole('button', { name: /Выбрать/ }).click()
  const form = page.locator('.panel', { hasText: 'Что возвращают' })
  const line = form.locator('tbody tr', { hasText: LAST })
  await line.locator('input.disc-input').fill('1')
  const date = line.locator('.ret-expiry input[type="date"]')
  await date.scrollIntoViewIfNeeded()
  await expect(date).toBeVisible()
  // Поле целиком на экране: не шире окна и не уехало за правый край
  const box = await date.boundingBox()
  expect(box.x, 'поле начинается на экране').toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, 'поле не выходит за правый край').toBeLessThanOrEqual(390)
  expect(box.width, 'в поле помещается дата').toBeGreaterThan(110)
  await date.fill(FAR)
  await expect(date).toHaveValue(FAR)
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/vozvrat-phone.png', fullPage: false })
  // Возврат проходит и с телефона
  const res = await submit(page, form)
  expect(res.request().postDataJSON().items[0].expiryDate).toBe(FAR)
})
