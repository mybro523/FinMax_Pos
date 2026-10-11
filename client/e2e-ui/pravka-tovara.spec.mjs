// ── Правка карточки товара, пока товар продаётся ──
// Форма правки держит все поля карточки, в том числе остаток. Пока она открыта, товар
// продаётся — на сайте, на кассах, чеками, которые касса без интернета досылает позже.
// Раньше при сохранении остаток из формы ложился поверх настоящего: владелец правил
// цену, а проданное за эту минуту «возвращалось» на полку.
import { test, expect } from '@playwright/test'
import { login, goTo, tag, barcode, withServer } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Ходовой'

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

let product

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  product = await call('POST', '/products', { name: NAME, barcode: barcode(), category: 'Таблетки', cost: 100, price: 150, stock: 10, minStock: 0, unitsPerPack: 1, unit: 'уп' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  if (product) await call('DELETE', '/products/' + product.id).catch(() => {})
  await page.close()
})

async function openCard(page) {
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(TAG)
  const row = page.locator('tbody tr', { hasText: NAME })
  await expect(row).toBeVisible()
  await row.locator('button[data-tour="prod.row-actions"]').first().click()
  const modal = page.locator('.modal', { hasText: 'Редактировать товар' })
  await expect(modal).toBeVisible()
  return modal
}
const field = (modal, label) => modal.locator('.field', { hasText: label }).locator('input').first()
const save = (page, modal) =>
  withServer(page, '/products/' + product.id, () => modal.getByRole('button', { name: 'Сохранить', exact: true }).click(), 'PATCH')

test('правили цену, а товар в это время продали: проданное не возвращается на полку', async ({ page }) => {
  const call = await server(page)
  const modal = await openCard(page)
  await expect(field(modal, 'Остаток (упаковок)')).toHaveValue('10')

  // Пока карточка открыта, две упаковки продали
  await call('POST', '/sales', { items: [{ productId: product.id, qty: 2 }], payment: 'cash', clientId: TAG + '-poka-otkryta' })

  await field(modal, 'Цена продажи').fill('175')
  const res = await save(page, modal)
  const sent = res.request().postDataJSON()
  expect('stock' in sent, 'остаток не правили — на сервер он уходить не должен').toBe(false)
  expect(sent.price).toBe(175)

  const after = (await call('GET', '/products')).find((p) => p.id === product.id)
  expect(after.price).toBe(175)
  expect(after.stock, 'остаток из открытой формы лёг поверх настоящего').toBe(8)
  // И на экране — настоящий остаток
  await expect(page.locator('tbody tr', { hasText: NAME })).toContainText('8')
})

test('остаток в карточке поправили — он записывается', async ({ page }) => {
  const call = await server(page)
  const modal = await openCard(page)
  await expect(field(modal, 'Остаток (упаковок)')).toHaveValue('8')
  await field(modal, 'Остаток (упаковок)').fill('5')
  const res = await save(page, modal)
  expect(res.request().postDataJSON().stock).toBe(5)
  expect((await call('GET', '/products')).find((p) => p.id === product.id).stock).toBe(5)
})
