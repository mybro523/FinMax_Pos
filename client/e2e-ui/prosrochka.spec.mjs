// ── Просроченный товар ──
// Самая дорогая из найденных ошибок: касса отдавала покупателю просрочку первой,
// потому что списывала партию с ближайшим сроком. Проверяем глазами кассира.
import { test, expect } from '@playwright/test'
import { login, goTo, addProduct, removeProducts, waitForProducts, scan, withServer, tag, barcode, pickSupplier } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Амоксициллин'
const CODE = barcode()

const dayShift = (n) => {
  const d = new Date(Date.now() + n * 86400000)
  return d.toISOString().slice(0, 10)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  // Товар заводим без остатка: весь остаток придёт приходом, партиями со сроками
  await addProduct(page, { name: NAME, code: CODE, price: '60', cost: '0', stock: '0', unitsPerPack: '1' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await page.close()
})

// Приёмка партии с заданным сроком годности
async function receive(page, { qty, cost, expiry }) {
  await goTo(page, 'Приход товара')
  await page.getByRole('button', { name: /Новый приход/ }).click()
  const modal = page.locator('.modal', { hasText: 'Новый приход товара' })
  await expect(modal).toBeVisible()

  await pickSupplier(page, modal, TAG)

  // Принимают товар сканером, коробка за коробкой — так и делаем.
  // Сначала убеждаемся, что список товаров доехал: подсказка берётся из него же.
  const scanBox = modal.locator('.scan-input')
  await scanBox.fill(TAG)
  await expect(modal.locator('table tbody tr').first()).toContainText(NAME, { timeout: 30000 })
  await scanBox.fill(CODE)
  await scanBox.press('Enter')

  const line = modal.locator('.arr-line').first()
  await expect(line).toContainText(NAME)
  await line.locator('.arr-qty').fill(String(qty))
  await line.locator('.arr-cost').fill(String(cost))
  await line.locator('.arr-exp').fill(expiry)

  // Ждём именно ответ сервера: приход показывается на экране сразу, ещё до записи
  await withServer(page, '/arrivals', () => modal.getByRole('button', { name: 'Оприходовать' }).click())
  await expect(modal).toBeHidden()
  // Сообщение на экране живёт пару секунд и к этому моменту уже гаснет — да и
  // проверять его незачем: ответ сервера выше и есть настоящее подтверждение
}

test('приёмка принимает партию с истёкшим сроком', async ({ page }) => {
  await login(page)
  await receive(page, { qty: 4, cost: 30, expiry: dayShift(-10) })

  await goTo(page, 'Товары')
  await page.locator('input.search').fill(TAG)
  await expect(page.locator('tbody tr', { hasText: TAG }).first()).toContainText('4')
})

test('раздел сроков показывает, сколько штук негодно', async ({ page }) => {
  await login(page)
  await goTo(page, 'Срок годности')
  const row = page.locator('tbody tr', { hasText: TAG }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText(/просрочен/i)
  await expect(row).toContainText(/негодно\s*4/i)
})

test('касса отказывается продавать просроченный товар', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  // В корзину не попал, вместо этого — понятная причина
  await expect(page.locator('.toast')).toContainText(/весь остаток просрочен/i)
  await expect(page.getByText('Корзина пуста')).toBeVisible()
})

test('годная партия того же товара продаётся, просроченная остаётся', async ({ page }) => {
  await login(page)
  await receive(page, { qty: 3, cost: 30, expiry: dayShift(200) })

  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  // Товар добавился, но кассир предупреждён про просрочку на полке
  const cart = page.locator('.panel', { hasText: 'Корзина' })
  await expect(cart.locator('tbody tr').first()).toContainText(NAME)
  await expect(page.locator('.note.err')).toContainText(/просроченными партиями/i)

  await withServer(page, '/sales', () => page.getByRole('button', { name: /Провести продажу/ }).click())
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await receipt.getByRole('button', { name: 'Готово' }).click()
})

test('больше годного остатка продать нельзя', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)
  await scan(page, CODE)
  // Годных было 3, одну продали в прошлом сценарии — осталось 2.
  // Третье сканирование должно упереться в лимит, а не в общий остаток (6).
  await scan(page, CODE)
  await expect(page.locator('.toast')).toContainText(/Максимум на складе: 2/)
})

test('просроченное списывается со страницы сроков', async ({ page }) => {
  await login(page)
  await goTo(page, 'Срок годности')
  const row = page.locator('tbody tr', { hasText: TAG }).first()
  await row.getByRole('button', { name: /Списать/ }).click()

  await expect(page.locator('.topbar h1')).toContainText('Списание')
  // Количество подставлено просроченное, а не весь остаток
  await expect(page.locator('tbody tr', { hasText: TAG }).locator('input').first()).toHaveValue('4')

  await page.getByRole('button', { name: /^Списать$/ }).click()
  const confirm = page.locator('.overlay .modal', { hasText: 'Списать товар?' })
  await withServer(page, '/writeoffs', () => confirm.getByRole('button', { name: 'Списать', exact: true }).click())

  // Просрочки не осталось, годный товар на месте
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(TAG)
  await expect(page.locator('tbody tr', { hasText: TAG }).first()).toContainText('2')
})
