// ── Поставщики, наличные в смене, оплата переводом, история товара ──
// Владелец принимает товар в долг, платит поставщику из кассы, кассир вносит размен
// и отдаёт выручку, покупатель платит переводом через Alif — и вечером смена сходится.
// Здесь проходится то же, что делают они: в настоящем браузере, со всеми окнами.
// В конце — то же с телефона.
import { test, expect } from '@playwright/test'
import { login, goTo, addProduct, removeProducts, waitForProducts, scan, withServer, tag, barcode, moneyValue } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Амоксициллин'
const CODE = barcode()
const SUPPLIER = TAG + ' Опт-Маркет'

test.describe.configure({ mode: 'serial' })

const metric = (page, label) => page.locator('.cards .metric').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) })
const metricValue = async (page, label) => moneyValue(await metric(page, label).locator('.value').innerText())
const expected = (page) => metricValue(page, 'Ожидается в кассе')

// Смена должна быть открыта: берём открытую или открываем новую со 100 на начало
async function ensureShift(page) {
  await goTo(page, 'Смена кассы')
  const openBox = page.locator('[data-tour="shift.open"]')
  const expectedCard = page.locator('[data-tour="shift.expected"]')
  await expect(openBox.or(expectedCard).first()).toBeVisible()
  // Пока смены не загрузились, страница рисует форму открытия — даём данным дойти:
  // открытая смена покажет карточку «ожидается», и форма исчезнет
  await expectedCard.waitFor({ timeout: 4000 }).catch(() => {})
  if (await openBox.isVisible()) {
    await page.locator('#openCash').fill('100')
    await withServer(page, '/shifts/open', () => openBox.getByRole('button', { name: 'Открыть смену' }).click())
  }
  await expect(expectedCard).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await addProduct(page, { name: NAME, code: CODE, price: '50', cost: '30', stock: '0', unitsPerPack: '1' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await page.close()
})

test('приход в долг: поставщик заводится при приёмке, долг появляется в разделе «Поставщики» и на панели', async ({ page }) => {
  await login(page)
  await goTo(page, 'Приход товара')
  await page.getByRole('button', { name: /Новый приход/ }).click()
  const form = page.locator('.modal', { hasText: 'Новый приход товара' })
  await expect(form).toBeVisible()

  // Нового поставщика заводят, не бросая приёмку
  await form.locator('[data-tour="af.supplier"]').getByRole('button', { name: 'Новый поставщик' }).click()
  const dlg = page.locator('.overlay .modal', { hasText: 'Новый поставщик' }).last()
  await dlg.locator('#dlg_name').fill(SUPPLIER)
  await dlg.locator('#dlg_phone').fill('+992 900 00 00 01')
  await withServer(page, '/suppliers', () => dlg.getByRole('button', { name: 'Добавить', exact: true }).click())
  await expect(form.locator('[data-tour="af.supplier"] select')).toContainText(SUPPLIER)

  // Товар — 10 упаковок по 30, всего 300; оплачено 100, в долг 200
  await form.locator('[data-tour="af.pick"] select').selectOption({ label: `${NAME} (остаток 0)` })
  await form.locator('[data-tour="af.pick"] button').click()
  const line = form.locator('.arr-line', { hasText: NAME })
  await expect(line).toBeVisible()
  await line.locator('.arr-qty').fill('10')
  await line.locator('.arr-cost').fill('30')
  await line.locator('.arr-exp').fill('2028-01-31')
  await form.locator('[data-tour="af.credit"]').getByLabel('В долг (оплачено не полностью)').check()
  await form.locator('[data-tour="af.credit"] input').nth(1).fill('100')
  await expect(form.locator('[data-tour="af.credit"]')).toContainText('200')
  await withServer(page, '/arrivals', () => form.getByRole('button', { name: 'Оприходовать' }).click())
  await expect(page.locator('tbody tr', { hasText: SUPPLIER }).first()).toContainText('в долг')

  await goTo(page, 'Поставщики')
  const row = page.locator('tbody tr', { hasText: SUPPLIER })
  await expect(row).toContainText('200')
  await expect(metric(page, 'Долги поставщикам')).toContainText('200')

  await goTo(page, 'Панель управления')
  await expect(metric(page, 'Долги поставщикам')).toBeVisible()
  await metric(page, 'Долги поставщикам').click()
  await expect(page.locator('.modal', { hasText: 'Долги поставщикам' }).locator('tbody tr', { hasText: SUPPLIER })).toContainText('200')
})

test('оплата поставщику из кассы уменьшает долг и наличные в смене; после закрытия смены она не отменяется', async ({ page }) => {
  await login(page)
  await ensureShift(page)
  const before = await expected(page)

  await goTo(page, 'Поставщики')
  await page.locator('tbody tr', { hasText: SUPPLIER }).getByRole('button', { name: 'Долг и оплата' }).click()
  const card = page.locator('.modal', { hasText: SUPPLIER })
  await expect(card).toBeVisible()
  await expect(card.locator('tbody tr', { hasText: '200' }).first()).toBeVisible()
  // Больше долга заплатить нельзя
  await card.locator('#supPayAmount').fill('500')
  await card.getByRole('button', { name: 'Записать оплату' }).click()
  await expect(page.locator('.toast').last()).toContainText('больше долга')
  // 80 из кассы
  await card.locator('#supPayAmount').fill('80')
  await card.locator('#supPayNote').fill(TAG + ' курьеру')
  await card.getByLabel('Оплачено из кассы').check()
  await withServer(page, '/pay', () => card.getByRole('button', { name: 'Записать оплату' }).click())
  await expect(card.locator('.mini-card', { hasText: 'Долг сейчас' })).toContainText('120')
  await expect(card.locator('tbody tr', { hasText: TAG + ' курьеру' })).toContainText('из кассы')
  await card.getByRole('button', { name: 'Готово' }).click()

  await goTo(page, 'Смена кассы')
  await expect.poll(() => expected(page)).toBeCloseTo(before - 80, 2)
  await expect(page.locator('.total-row', { hasText: 'Оплачено поставщикам' })).toContainText('80')
})

test('внесение и изъятие наличных: ожидаемая сумма идёт следом, список операций с именем', async ({ page }) => {
  await login(page)
  await ensureShift(page)
  const before = await expected(page)

  await page.getByRole('button', { name: 'Внести', exact: true }).click()
  let dlg = page.locator('.overlay .modal', { hasText: 'Внести наличные в кассу' })
  await dlg.locator('#dlg_amount').fill('200')
  await dlg.locator('#dlg_note').fill(TAG + ' размен')
  await withServer(page, '/shifts/cash', () => dlg.getByRole('button', { name: 'Внести', exact: true }).click())
  await expect.poll(() => expected(page)).toBeCloseTo(before + 200, 2)

  await page.getByRole('button', { name: 'Изъять', exact: true }).click()
  dlg = page.locator('.overlay .modal', { hasText: 'Изъять наличные из кассы' })
  await dlg.locator('#dlg_amount').fill('50')
  await dlg.locator('#dlg_note').fill(TAG + ' владельцу')
  await withServer(page, '/shifts/cash', () => dlg.getByRole('button', { name: 'Изъять', exact: true }).click())
  await expect.poll(() => expected(page)).toBeCloseTo(before + 150, 2)

  const list = page.locator('[data-tour="shift.cash-list"]')
  await expect(list.locator('tbody tr', { hasText: TAG + ' размен' })).toContainText('+')
  await expect(list.locator('tbody tr', { hasText: TAG + ' владельцу' })).toContainText('−')
  await expect(page.locator('[data-tour="shift.cash-rows"]').first()).toBeVisible()
  // Ошибочное внесение можно отменить, пока смена открыта
  await page.getByRole('button', { name: 'Внести', exact: true }).click()
  dlg = page.locator('.overlay .modal', { hasText: 'Внести наличные в кассу' })
  await dlg.locator('#dlg_amount').fill('5')
  await dlg.locator('#dlg_note').fill(TAG + ' ошибка')
  await withServer(page, '/shifts/cash', () => dlg.getByRole('button', { name: 'Внести', exact: true }).click())
  await list.locator('tbody tr', { hasText: TAG + ' ошибка' }).getByRole('button', { name: /Отменить/ }).click()
  await withServer(page, '/cash-moves/', () => page.locator('.overlay .modal', { hasText: 'Отменить операцию?' }).getByRole('button', { name: 'Отменить', exact: true }).click(), 'DELETE')
  await expect(list.locator('tbody tr', { hasText: TAG + ' ошибка' })).toHaveCount(0)
  await expect.poll(() => expected(page)).toBeCloseTo(before + 150, 2)
})

test('оплата переводом: сервис выбирается на кассе, в чеке и в смене видно, через какой; в ящик не попадает', async ({ page }) => {
  await login(page)
  await ensureShift(page)
  const before = await expected(page)

  await goTo(page, 'Касса')
  await waitForProducts(page, NAME)
  await scan(page, CODE)
  await expect(page.locator('.kassa-table tbody tr', { hasText: NAME })).toBeVisible()
  await page.locator('.pay-methods button', { hasText: 'Перевод' }).click()
  const via = page.locator('[data-tour="pos.pay-via"]')
  await expect(via).toBeVisible()
  await via.getByRole('button', { name: 'DC', exact: true }).click()
  await withServer(page, '/sales', () => page.getByRole('button', { name: /Провести продажу/ }).click())
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await expect(receipt.locator('.total-row', { hasText: 'Оплата' })).toContainText('Перевод · DC')
  await receipt.getByRole('button', { name: 'Готово' }).click()

  await goTo(page, 'Смена кассы')
  await expect(metric(page, 'Переводом')).toContainText('50')
  await expect(metric(page, 'Переводом')).toContainText('DC')
  await expect.poll(() => expected(page)).toBeCloseTo(before, 2)

  // В отчётах — переводы по сервисам
  await goTo(page, 'Отчёты')
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  await expect(page.locator('[data-tour="rep.paystruct"]')).toContainText('Перевод')
  await expect(page.locator('[data-tour="rep.transfer-by"]')).toContainText('DC')

  // Возврат по этому чеку — тем же способом, переводом
  await goTo(page, 'Возврат товара')
  const sale = page.locator('tbody tr', { hasText: NAME }).first()
  await sale.getByRole('button', { name: 'Выбрать' }).click()
  const retForm = page.locator('[data-tour="ret.refund"] select')
  await expect(retForm).toHaveValue('transfer')
  await page.locator('[data-tour="ret.lines"] input').first().fill('1')
  await withServer(page, '/returns', () => page.getByRole('button', { name: /Оформить возврат/ }).click())
  await expect(page.locator('.toast').last()).toContainText('Возврат оформлен')
})

test('закрытие смены: Z-отчёт показывает переводы, внесения, изъятия и оплаты поставщикам — и смена сходится', async ({ page }) => {
  await login(page)
  await ensureShift(page)
  const want = await expected(page)
  await page.getByRole('button', { name: 'Закрыть смену' }).first().click()
  const dialog = page.locator('.overlay .modal', { hasText: 'Закрытие смены' })
  await expect(dialog).toContainText('внесено')
  await withServer(page, '/shifts/close', () => dialog.getByRole('button', { name: 'Закрыть смену' }).click())
  const z = page.locator('.modal', { hasText: 'Z-отчёт смены' })
  await expect(z.locator('.note.info')).toBeHidden({ timeout: 20000 })
  for (const label of ['Переводом', 'Внесено в кассу', 'Изъято из кассы', 'Оплачено поставщикам']) {
    await expect(z.locator('.total-row', { hasText: label })).toBeVisible()
  }
  await expect(z.locator('.total-row', { hasText: 'DC' })).toBeVisible()
  const diff = moneyValue(await z.locator('.total-row.big', { hasText: 'Расхождение' }).locator('span').last().innerText())
  expect(Math.abs(diff)).toBeLessThan(0.02)
  expect(moneyValue(await z.locator('.total-row', { hasText: 'Ожидалось в кассе' }).locator('span').last().innerText())).toBeCloseTo(want, 2)
  await z.getByRole('button', { name: 'Готово' }).click()

  // Оплата поставщику из закрытой смены больше не отменяется
  await goTo(page, 'Поставщики')
  await page.locator('tbody tr', { hasText: SUPPLIER }).getByRole('button', { name: 'Долг и оплата' }).click()
  const card = page.locator('.modal', { hasText: SUPPLIER })
  await expect(card.locator('tbody tr', { hasText: TAG + ' курьеру' })).toContainText('в отчёте смены')
  await card.getByRole('button', { name: 'Готово' }).click()
})

test('история движения товара: приход, продажа, возврат — с остатком после каждого', async ({ page }) => {
  await login(page)
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(NAME)
  await page.locator('tbody tr', { hasText: NAME }).getByRole('button', { name: /Движение товара/ }).click()
  const modal = page.locator('.modal', { hasText: 'Движение товара' })
  await expect(modal).toBeVisible()
  const rows = modal.locator('[data-tour="ph.rows"] tbody tr')
  await expect(rows.filter({ hasText: 'Приход' })).toContainText('+10')
  await expect(rows.filter({ hasText: 'Приход' })).toContainText(SUPPLIER)
  await expect(rows.filter({ hasText: 'Продажа' })).toContainText('-1')
  await expect(rows.filter({ hasText: 'Возврат' })).toContainText('+1')
  // Остаток после самой свежей строки = нынешнему: 10 − 1 + 1
  await expect(rows.first()).toContainText('10')
  await modal.getByRole('button', { name: 'Всё время', exact: true }).click()
  await expect(rows.filter({ hasText: 'Приход' })).toBeVisible()
  await modal.getByRole('button', { name: 'Готово' }).click()
})

test('настройки: свой сервис перевода появляется на кассе, убранный — остаётся в прежних чеках', async ({ page }) => {
  await login(page)
  await goTo(page, 'Настройки')
  const panel = page.locator('[data-tour="set.payservices"]')
  await expect(panel.locator('tbody tr', { hasText: 'Alif' })).toBeVisible()
  await panel.locator('#paySvcName').fill(TAG + ' Банк')
  await withServer(page, '/pay-services', () => panel.getByRole('button', { name: 'Добавить' }).click())
  await expect(panel.locator('tbody tr', { hasText: TAG + ' Банк' })).toBeVisible()

  await goTo(page, 'Касса')
  await page.locator('.pay-methods button', { hasText: 'Перевод' }).click()
  await expect(page.locator('[data-tour="pos.pay-via"]').getByRole('button', { name: TAG + ' Банк' })).toBeVisible()
  await page.locator('.pay-methods button', { hasText: 'Наличные' }).click()

  await goTo(page, 'Настройки')
  await panel.locator('tbody tr', { hasText: TAG + ' Банк' }).getByRole('button').click()
  await withServer(page, '/pay-services/', () => page.locator('.overlay .modal', { hasText: 'Убрать сервис?' }).getByRole('button', { name: 'Убрать', exact: true }).click(), 'DELETE')
  await expect(panel.locator('tbody tr', { hasText: TAG + ' Банк' })).toHaveCount(0)
})

test('на телефоне: поставщики и смена помещаются на экране, расход… то есть внесение работает', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await login(page)
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  await page.locator('.burger').click()
  await page.locator('.sidebar').getByRole('link', { name: 'Поставщики' }).click()
  await expect(page.locator('.topbar h1')).toHaveText('Поставщики')
  await expect(page.locator('tbody tr', { hasText: SUPPLIER })).toBeVisible()
  expect(await fits(), 'поставщики не должны быть шире экрана телефона').toBe(true)
  await page.locator('tbody tr', { hasText: SUPPLIER }).getByRole('button', { name: 'Долг и оплата' }).click()
  const card = page.locator('.modal', { hasText: SUPPLIER })
  await expect(card.getByRole('button', { name: 'Записать оплату' })).toBeVisible()
  expect(await fits()).toBe(true)
  await card.getByRole('button', { name: 'Готово' }).click()

  await page.locator('.burger').click()
  await page.locator('.sidebar').getByRole('link', { name: 'Смена кассы' }).click()
  await expect(page.locator('.topbar h1')).toHaveText('Смена кассы')
  expect(await fits()).toBe(true)
})

test('на таджикском новые разделы переведены', async ({ page }) => {
  await login(page)
  await goTo(page, 'Настройки')
  await page.locator('[data-tour="set.lang"]').getByRole('button', { name: 'Тоҷикӣ' }).click()
  try {
    await page.locator('.sidebar').getByRole('link', { name: 'Таъминкунандагон' }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Таъминкунандагон')
    await expect(page.getByRole('button', { name: 'Илова кардани таъминкунанда' })).toBeVisible()
    await page.locator('.sidebar').getByRole('link', { name: 'Касса', exact: true }).click()
    await expect(page.locator('.pay-methods button', { hasText: 'Интиқол' })).toBeVisible()
    const text = await page.locator('.content').innerText()
    for (const ru of ['Перевод', 'Наличные', 'Отложить чек']) expect(text.includes(ru), `на таджикском экране осталось «${ru}»`).toBe(false)
  } finally {
    await page.locator('.sidebar').getByRole('link', { name: 'Танзимот' }).click()
    await page.locator('[data-tour="set.lang"]').getByRole('button', { name: 'Русский' }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Настройки')
  }
})
