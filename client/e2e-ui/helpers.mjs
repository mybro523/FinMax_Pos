// Общие действия для браузерных проверок: вход, заведение товара, уборка.
// Тестовые данные помечаются меткой и удаляются в конце — база общая с магазином.
import { expect } from '@playwright/test'

export const USER = process.env.APP_USER || 'admin'
export const PASS = process.env.APP_PASS || 'admin'

// Метка прогона: по ней тестовые записи видно в списке и легко убрать
export const tag = () => 'UI-' + Date.now().toString(36)
export const barcode = () => '277' + String(Date.now()).slice(-10)

export async function login(page) {
  await page.goto('/')
  // Программа могла остаться в системе с прошлого прогона
  const loginCard = page.locator('.login-card')
  if (await loginCard.isVisible().catch(() => false)) {
    await page.locator('#lg-name').fill(USER)
    await page.locator('#lg-pw').fill(PASS)
    await page.getByRole('button', { name: /Войти/ }).click()
  }
  await expect(page.locator('.sidebar')).toBeVisible()
}

// Переход по левому меню
export async function goTo(page, label) {
  await page.locator('.sidebar').getByRole('link', { name: label, exact: false }).first().click()
  await expect(page.locator('.topbar h1')).toBeVisible()
}

// Тост с сообщением (успех или ошибка)
export const toast = (page) => page.locator('.toast')

// Заводим товар через интерфейс раздела «Товары»
export async function addProduct(page, { name, code, price = '100', cost = '60', stock = '10', unitsPerPack = '1', category = 'Таблетки' }) {
  await goTo(page, 'Товары')
  await page.getByRole('button', { name: /Добавить товар/ }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()

  await modal.locator('.field', { hasText: 'Название' }).locator('input').first().fill(name)
  await modal.locator('input[placeholder="487…"]').fill(code)
  await modal.locator('select').first().selectOption(category)

  const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
  await num('Закупочная цена').fill(cost)
  await num('Цена продажи').fill(price)
  await num('Остаток (упаковок)').fill(stock)
  await num('Штук в упаковке').fill(unitsPerPack)

  // Ждём именно ответ сервера, а не появление строки на экране. Программа
  // показывает товар сразу, ещё до записи, и при отказе (скажем, такой штрихкод
  // уже занят) строка просто исчезла бы обратно — а проверки пошли бы работать
  // с несуществующим товаром. Перезагружать страницу тут тоже нельзя: запрос
  // ещё в полёте, и перезагрузка его обрывает.
  const saved = page.waitForResponse(
    (r) => r.url().includes('/products') && r.request().method() === 'POST',
    { timeout: 30000 },
  )
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click()
  const res = await saved
  if (!res.ok()) throw new Error(`товар не создан: ${res.status()} ${await res.text()}`)
  await expect(modal).toBeHidden()
  await expect(page.getByRole('cell', { name }).first()).toBeVisible()
}

// Убираем за собой: удаляем товары, чьё название начинается с метки
export async function removeProducts(page, prefix) {
  await goTo(page, 'Товары')
  const search = page.locator('input.search')
  await search.fill(prefix)
  // Удаляем, пока строки с меткой не кончатся
  for (let i = 0; i < 20; i++) {
    const rows = page.locator('tbody tr', { hasText: prefix })
    if ((await rows.count()) === 0) break
    await rows.first().locator('button').last().click()
    const dialog = page.locator('.overlay .modal', { hasText: 'Удалить товар?' })
    await dialog.getByRole('button', { name: 'Удалить', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(300)
  }
  await search.fill('')
}

// ── Дождаться, что сервер принял операцию ──
// Программа намеренно оптимистична: чек, приход и списание она показывает сразу,
// не дожидаясь ответа. Для кассира это правильно — покупатель не ждёт. Но проверка,
// закрывшая браузер сразу после нажатия, прошла бы на нарисованном: запрос
// оборвался бы вместе с вкладкой, и в базе не осталось бы ничего.
// method — на случай правки и удаления: они ходят PATCH и DELETE, а по умолчанию
// здесь ждали только POST, и ожидание молча истекало на верном коде
export async function withServer(page, pathPart, action, method = 'POST') {
  const wait = page.waitForResponse(
    (r) => r.url().includes(pathPart) && r.request().method() === method,
    { timeout: 30000 },
  )
  await action()
  const res = await wait
  if (!res.ok()) throw new Error(`сервер отказал: ${pathPart} → ${res.status()} ${await res.text()}`)
  return res
}

// ── Поставщик в форме прихода ──
// Поставщик выбирается из справочника; нового заводят тут же кнопкой «Новый поставщик».
// Такой уже есть (повторный прогон) — просто выбирается
export async function pickSupplier(page, modal, name) {
  const field = modal.locator('[data-tour="af.supplier"]')
  const select = field.locator('select')
  if ((await select.locator('option', { hasText: name }).count()) > 0) {
    await select.selectOption({ label: name })
    return
  }
  await field.getByRole('button', { name: 'Новый поставщик' }).click()
  const dlg = page.locator('.overlay .modal', { hasText: 'Новый поставщик' }).last()
  await dlg.locator('#dlg_name').fill(name)
  await withServer(page, '/suppliers', () => dlg.getByRole('button', { name: 'Добавить', exact: true }).click())
  await expect(select).toContainText(name)
}

// Касса ищет товар в списке, который лежит на самом устройстве. В чистом браузере
// этот список ещё едет с сервера, и сканирование в первую секунду не найдёт ничего.
// Ждём строку каталога с этим названием — каталог берётся из того же списка,
// поэтому её появление и означает, что данные на месте.
export async function waitForProducts(page, needle) {
  const scan = page.locator('.scan-input')
  await scan.fill(needle)
  await expect(page.locator('.kc-row').first()).toContainText(needle, { timeout: 30000 })
  await scan.fill('')
}

// Отсканировать штрихкод так, как это делает USB-сканер: печатает код и жмёт Enter
export async function scan(page, code) {
  await page.locator('.scan-input').fill(code)
  await page.locator('.scan-input').press('Enter')
}

// Сумма из строки вида «1 234,5 сомони» → число
export const moneyValue = (text) => Number(String(text).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.')) || 0
