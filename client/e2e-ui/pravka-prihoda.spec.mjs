// ── Правка и удаление оформленного прихода ──
//
// Ошибиться при приёмке легко: не та цифра в количестве или в закупочной. Раньше
// исправить было нечем — приход оформлялся навсегда.
//
// Опасность этой правки в том, что приход не запись в журнале, а уже случившееся
// движение: он положил на полку партии, поднял остаток и сдвинул среднюю
// закупочную цену. Поэтому здесь проверяется не «кнопка нажимается», а то, что
// склад после правки сходится с тем, что лежит на полке.
//
// Живой проверкой тут поймано две ошибки, и обе тихие:
//   1) правка СКЛАДЫВАЛА остаток вместо замены: 50 поправили на 40, вышло 90;
//   2) правка СТИРАЛА срок годности партии — контроль сроков молча отваливался.
// Проверки ниже стерегут ровно это.
//
// Запуск:  npx playwright test e2e-ui/pravka-prihoda.spec.mjs   (в папке client)
import { test, expect } from '@playwright/test'
import { login, goTo, addProduct, removeProducts, withServer, tag, barcode, pickSupplier } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Правка'
const CODE = barcode()
const SROK = '2028-03-31'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  // Без остатка: всё придёт приходом, чтобы правка считалась по партиям
  await addProduct(page, { name: NAME, code: CODE, price: '150', cost: '0', stock: '0', unitsPerPack: '1' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await page.close()
})

async function receive(page, { qty, cost, expiry = SROK }) {
  await goTo(page, 'Приход товара')
  await page.getByRole('button', { name: /Новый приход/ }).click()
  const modal = page.locator('.modal', { hasText: 'Новый приход товара' })
  await expect(modal).toBeVisible()
  await pickSupplier(page, modal, TAG)

  const scanBox = modal.locator('.scan-input')
  await scanBox.fill(TAG)
  await expect(modal.locator('table tbody tr').first()).toContainText(NAME, { timeout: 30_000 })
  await scanBox.fill(CODE)
  await scanBox.press('Enter')

  const line = modal.locator('.arr-line').first()
  await expect(line).toContainText(NAME)
  await line.locator('.arr-qty').fill(String(qty))
  await line.locator('.arr-cost').fill(String(cost))
  await line.locator('.arr-exp').fill(expiry)
  await withServer(page, '/arrivals', () => modal.getByRole('button', { name: 'Оприходовать' }).click())
  await expect(modal).toBeHidden()
}

// Остаток, закупочная и срок прямо из карточки товара — то, что видит владелец
async function tovar(page) {
  await goTo(page, 'Товары')
  const row = page.locator('tbody tr', { hasText: NAME }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  // Карточка открывается карандашом в строке, а не нажатием по ней
  await row.locator('[data-tour="prod.row-actions"]').first().click()
  const modal = page.locator('.modal').first()
  await expect(modal).toBeVisible()
  const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
  const итог = {
    остаток: Number(await num('Остаток (упаковок)').inputValue()) || 0,
    закупочная: Number(await num('Закупочная цена').inputValue()) || 0,
    срок: await num('Срок годности').inputValue(),
  }
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  return итог
}

async function openEdit(page) {
  await goTo(page, 'Приход товара')
  const row = page.locator('tbody tr', { hasText: TAG }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: /Подробно/ }).click()
  await expect(page.locator('.modal', { hasText: 'Приход · детали' })).toBeVisible()
  await page.getByRole('button', { name: /Изменить/ }).click()
  const modal = page.locator('.modal', { hasText: 'Изменить приход' })
  await expect(modal).toBeVisible({ timeout: 30_000 })
  return modal
}

test('приход виден в журнале и открывается на правку', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  await receive(page, { qty: 50, cost: 100 })

  const до = await tovar(page)
  expect(до.остаток, 'приход не положил товар на полку').toBe(50)
  expect(до.закупочная, 'закупочная не взялась из прихода').toBe(100)

  const modal = await openEdit(page)
  // Срок обязан подставиться: пустое поле выглядело бы так, будто срока не было
  await expect(modal.locator('input[type="date"]').first(), 'срок годности не подставился').toHaveValue(SROK)
})

test('правка ЗАМЕНЯЕТ остаток, а не складывает с прежним', async ({ page }) => {
  // Та самая ошибка: партии снимались, но карточка ещё держала прежний остаток,
  // и он возвращался отдельной партией. 50 поправили на 40 — вышло 90
  test.setTimeout(180_000)
  await login(page)
  const modal = await openEdit(page)

  await modal.locator('tbody input').nth(0).fill('40')
  await modal.locator('tbody input').nth(1).fill('90')
  await expect(modal.locator('.total-row.big')).toContainText('3 600')
  await withServer(page, '/arrivals', () => modal.getByRole('button', { name: /^Сохранить$/ }).click(), 'PATCH')
  await expect(modal).toBeHidden()

  const после = await tovar(page)
  expect(после.остаток, 'остаток сложился вместо замены').toBe(40)
  expect(после.закупочная, 'закупочная не пересчиталась по партиям').toBe(90)
  expect(после.срок, 'правка стёрла срок годности').toBe(SROK)
})

test('ниже проданного количество не опустить', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)

  // Продаём 12 упаковок — их уже не вернуть на полку
  await goTo(page, 'Касса')
  const scan = page.locator('.scan-input')
  await scan.fill(TAG)
  await expect(page.locator('.kc-row').first()).toContainText(NAME, { timeout: 30_000 })
  await scan.fill(CODE)
  await scan.press('Enter')
  const line = page.locator('tbody tr', { hasText: NAME }).last()
  await expect(line).toBeVisible()
  for (let i = 0; i < 11; i++) await line.locator('.qty-ctrl button').last().click()
  await expect(line.locator('.qty-ctrl b')).toHaveText('12')
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 40_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay.printable')).toBeHidden()

  const modal = await openEdit(page)
  // Строка обязана сказать, сколько уже ушло: без этого запрет выглядит произволом
  await expect(modal, 'в правке не видно, сколько уже продано').toContainText('уже продано')

  await modal.locator('tbody input').nth(0).fill('5')
  await expect(
    modal.getByRole('button', { name: /^Сохранить$/ }),
    'дали сохранить количество меньше проданного',
  ).toBeDisabled()

  // Ровно проданное — можно: на полке просто не останется ничего
  await modal.locator('tbody input').nth(0).fill('12')
  await expect(modal.getByRole('button', { name: /^Сохранить$/ })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  const после = await tovar(page)
  expect(после.остаток, 'отказ не должен был трогать склад').toBe(28)
})

test('удаление снимает с полки непроданное и возвращает прежнюю цену', async ({ page }) => {
  test.setTimeout(240_000)
  await login(page)

  // Вторая поставка по другой цене: средняя станет между ними
  await receive(page, { qty: 40, cost: 200, expiry: '2029-01-31' })
  const две = await tovar(page)
  expect(две.остаток).toBe(68) // 28 осталось от первой поставки + 40
  expect(две.закупочная, 'вторая поставка не усреднила цену').toBeGreaterThan(90)

  // Удаляем ВТОРУЮ поставку — цена обязана вернуться к первой.
  // Журнал новыми вверх, поэтому первая строка и есть вторая поставка
  await goTo(page, 'Приход товара')
  const row = page.locator('tbody tr', { hasText: TAG }).first()
  await row.getByRole('button', { name: /Подробно/ }).click()
  await expect(page.locator('.modal', { hasText: 'Приход · детали' })).toBeVisible()
  await page.getByRole('button', { name: /^Удалить$/ }).first().click()

  const ask = page.locator('.modal', { hasText: 'Удалить приход?' })
  await expect(ask).toBeVisible()
  // Человеку сказали, что произойдёт со складом, а не просто спросили «уверены?»
  await expect(ask).toContainText(/снимется|склад/i)
  await withServer(page, '/arrivals', () => ask.getByRole('button', { name: /^Удалить$/ }).click(), 'DELETE')

  const после = await tovar(page)
  expect(после.остаток, 'удаление сняло не то количество').toBe(28)
  expect(после.закупочная, 'закупочная не вернулась к оставшейся партии').toBe(90)
  expect(после.срок, 'удаление сбило срок оставшейся партии').toBe(SROK)
})

test('кассиру править и удалять приходы нельзя', async ({ page, request }) => {
  test.setTimeout(180_000)
  await login(page)

  // Заводим кассира и смотрим его глазами
  await goTo(page, 'Сотрудники')
  await page.getByRole('button', { name: /Добавить|Завести/ }).first().click()
  const form = page.locator('.modal').first()
  await expect(form).toBeVisible()
  const имя = TAG + ' Кассир'
  await form.locator('input').first().fill(имя)
  await form.locator('input').nth(1).fill('proverka-2026')
  await withServer(page, '/users', () => form.getByRole('button', { name: /Сохранить|Добавить|Завести/ }).last().click())

  const API = process.env.API_URL || 'https://saasapteka-production.up.railway.app/api'
  const вход = await request.post(`${API}/auth/login`, { data: { name: имя, password: 'proverka-2026' } })
  expect(вход.ok(), 'кассир не смог войти').toBeTruthy()
  const h = { Authorization: `Bearer ${(await вход.json()).token}` }

  const list = await request.get(`${API}/arrivals`, { headers: h })
  expect(list.ok(), 'кассиру закрыли журнал приходов — а он ему нужен').toBeTruthy()
  const any = (await list.json())[0]

  // Запрет обязан жить на сервере, а не только в спрятанных кнопках
  const one = await request.get(`${API}/arrivals/${any.id}`, { headers: h })
  const patch = await request.patch(`${API}/arrivals/${any.id}`, { headers: h, data: { items: [{ id: 'x', qty: 1, cost: 1 }] } })
  const del = await request.delete(`${API}/arrivals/${any.id}`, { headers: h })
  expect(one.status(), 'кассир увидел приход на правку').toBe(403)
  expect(patch.status(), 'кассир переписал приход').toBe(403)
  expect(del.status(), 'кассир удалил приход').toBe(403)
})
