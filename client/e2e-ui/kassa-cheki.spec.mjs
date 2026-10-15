// ── Новая касса: каталог, клавиши, сдача и открытые чеки ──
//
// Раскладку кассы переделали: чек слева, каталог справа, несколько чеков сразу,
// «Получено → Сдача», работа с клавиатуры. Всё это — про то, что делают руками
// у прилавка, и расчётами не проверяется: что фокус остался в сканере, что Enter
// взял ту строку, которую выбрали стрелками, что чек пережил перезагрузку.
//
// Товары заводятся через сервер, а не через форму: проверяется касса, а не
// карточка товара (её стережёт kassa.spec.mjs).
//
// Запуск:  APP_USER=<логин владельца магазина> APP_PASS=<пароль> npx playwright test e2e-ui/kassa-cheki.spec.mjs
import { test, expect } from '@playwright/test'
import { login, goTo, moneyValue, tag, USER, PASS } from './helpers.mjs'

const API = process.env.API_URL || 'https://saasapteka-production.up.railway.app/api'
const TAG = tag()
const kod = (n) => '277' + String(Date.now()).slice(-9) + n

// Делимая пачка, неделимый бинт и товар, которого нет на складе
const ALFA = { name: `${TAG} Альфа штуки`, barcode: kod(1), price: 200, cost: 120, stock: 30, unitsPerPack: 20 }
const BETA = { name: `${TAG} Бета бинт`, barcode: kod(2), price: 40, cost: 18, stock: 30, unitsPerPack: 1 }
const GAMMA = { name: `${TAG} Гамма сироп`, barcode: kod(3), price: 75, cost: 50, stock: 0, unitsPerPack: 1 }

let h = null // заголовок с ключом владельца
let cats = [] // две категории магазина: у «Альфы» и «Гаммы» первая, у «Беты» вторая

test.describe.configure({ mode: 'serial' })

async function api(request, method, path, data) {
  const res = await request.fetch(`${API}${path}`, { method, headers: h, data })
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`)
  return res.status() === 204 ? null : res.json().catch(() => null)
}

test.beforeAll(async ({ request }) => {
  const вход = await request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
  expect(вход.ok(), 'не удалось войти владельцем магазина').toBe(true)
  h = { Authorization: `Bearer ${(await вход.json()).token}` }

  const все = (await api(request, 'GET', '/categories')).map((c) => c.name)
  expect(все.length, 'для проверки нужны хотя бы две категории товаров').toBeGreaterThan(1)
  cats = все.slice(0, 2)

  for (const [p, c] of [[ALFA, cats[0]], [BETA, cats[1]], [GAMMA, cats[0]]]) {
    const made = await api(request, 'POST', '/products', { ...p, category: c, minStock: 1 })
    p.id = made.id
    p.category = c
  }
})

test.afterAll(async ({ request }) => {
  for (const p of [ALFA, BETA, GAMMA]) {
    if (p.id) await api(request, 'DELETE', `/products/${p.id}`).catch(() => {})
  }
})

// ── Общие действия ──
const scanInput = (page) => page.locator('.scan-input')
const rows = (page) => page.locator('.kassa-table tbody tr')
const row = (page, p) => page.locator('.kassa-table tbody tr', { hasText: p.name })
const total = async (page) => moneyValue(await page.locator('.kassa-itogo .total-row.big span').last().textContent())
const tabs = (page) => page.locator('.chek-tab')

// Касса открыта, товары доехали, чеков с прошлых проверок нет
async function kassa(page) {
  await login(page)
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('apteka_cheki_')) localStorage.removeItem(k)
  })
  await goTo(page, 'Касса')
  await scanInput(page).fill(TAG)
  await expect(page.locator('.kc-row').first()).toContainText(TAG, { timeout: 30_000 })
  await scanInput(page).fill('')
}

async function scan(page, p) {
  await scanInput(page).fill(p.barcode)
  await scanInput(page).press('Enter')
  await expect(row(page, p)).toBeVisible()
}

// ═════════ Каталог ═════════

test('каталог виден сразу, категория и поиск отбирают товары', async ({ page }) => {
  await kassa(page)

  // Ничего не набрано — а товары уже на экране
  await expect(page.locator('.kc-row').first()).toBeVisible()

  await scanInput(page).fill(TAG)
  await expect(page.locator('.kc-row')).toHaveCount(3)

  // Категория «Беты»: «Альфа» и «Гамма» лежат в другой и из списка уходят
  await page.locator('.kc-cats .chip', { hasText: cats[1] }).click()
  await expect(page.locator('.kc-row')).toHaveCount(1)
  await expect(page.locator('.kc-row').first()).toContainText(BETA.name)
  // Нажатие на плашку не уводит курсор из сканера
  await expect(scanInput(page)).toBeFocused()

  // В выбранной категории такого нет, а в магазине есть — «ничего не найдено» было бы враньём
  await scanInput(page).fill(`${TAG} Альфа`)
  await expect(page.locator('.kc-note')).toContainText('показаны товары из других категорий')
  await expect(page.locator('.kc-row').first()).toContainText(ALFA.name)

  await page.locator('.kc-cats .chip').first().click()
  await scanInput(page).fill(`${TAG} Гамма`)
  const gamma = page.locator('.kc-row').first()
  await expect(gamma).toContainText(GAMMA.name)
  await expect(gamma, 'товар без остатка не отмечен в каталоге').toHaveClass(/net/)
})

test('нажатие на строку каталога кладёт товар в чек, курсор остаётся в сканере', async ({ page }) => {
  await kassa(page)

  await scanInput(page).fill(`${TAG} Альфа`)
  await page.locator('.kc-row', { hasText: ALFA.name }).click()
  await expect(row(page, ALFA)).toBeVisible()
  expect(await total(page)).toBe(200)
  // Следующий скан не должен уйти в никуда
  await expect(scanInput(page)).toBeFocused()
  await expect(scanInput(page)).toHaveValue('')

  // Товара нет на складе — в чек он не попадает, касса говорит почему
  await scanInput(page).fill(`${TAG} Гамма`)
  await page.locator('.kc-row', { hasText: GAMMA.name }).click()
  await expect(page.locator('.toast.err')).toContainText('нет на складе')
  await expect(rows(page)).toHaveCount(1)
  // Набранное при этом не стёрлось: рядом в списке другие формы того же товара
  await expect(scanInput(page)).toHaveValue(`${TAG} Гамма`)
})

test('поиск по названию: Enter берёт первый товар, стрелки — выбранный, обрывок цифр — никакой', async ({ page }) => {
  await kassa(page)

  await scanInput(page).fill(`${TAG} Бета`)
  await scanInput(page).press('Enter')
  await expect(row(page, BETA)).toBeVisible()
  await expect(scanInput(page)).toHaveValue('')

  // Три товара по алфавиту: Альфа, Бета, Гамма. Одна стрелка вниз — «Бета»
  await scanInput(page).fill(TAG)
  await expect(page.locator('.kc-row')).toHaveCount(3)
  await scanInput(page).press('ArrowDown')
  await expect(page.locator('.kc-row.hi')).toContainText(BETA.name)
  await scanInput(page).press('Enter')
  await expect(row(page, BETA).locator('.qty-ctrl b')).toHaveText('2')
  await expect(rows(page)).toHaveCount(1)

  // Пять цифр — обрывок кода. По нему нельзя класть в чек «первый похожий» товар
  await scanInput(page).fill(ALFA.barcode.slice(0, 5))
  await scanInput(page).press('Enter')
  await expect(page.locator('.toast.err')).toBeVisible()
  await expect(rows(page), 'по обрывку штрихкода в чек попал товар').toHaveCount(1)
  await expect(page.locator('.modal'), 'обрывок кода открыл форму нового товара').toHaveCount(0)

  // А короткий код, которого нет ни у одного товара даже частью, — это новый код:
  // свои четырёх-пятизначные коды магазина тоже заводят с кассы
  await scanInput(page).fill('00000')
  await expect(page.locator('.kassa-catalog .empty')).toBeVisible()
  await scanInput(page).press('Enter')
  const modal = page.locator('.modal', { hasText: 'Новый товар по штрихкоду' })
  await expect(modal, 'короткий незнакомый код не предложил завести товар').toBeVisible()
  await modal.getByRole('button', { name: 'Отмена' }).click()
  await expect(modal).toBeHidden()
})

// ═════════ Клавиши ═════════

test('клавиши: стрелки выбирают строку, + и − меняют упаковки, F2 и F4 ведут в поля, Delete убирает', async ({ page }) => {
  await kassa(page)
  await scan(page, ALFA)
  await scan(page, BETA)

  // Выбрана строка, пробитая последней
  await expect(row(page, BETA)).toHaveClass(/sel/)
  await page.keyboard.press('ArrowUp')
  await expect(row(page, ALFA)).toHaveClass(/sel/)

  await page.keyboard.press('+')
  await expect(row(page, ALFA).locator('.qty-ctrl b')).toHaveText('2')
  await page.keyboard.press('-')
  await expect(row(page, ALFA).locator('.qty-ctrl b')).toHaveText('1')

  // F4 — штуки выбранной строки. 200 за пачку из 20: три штуки — ещё 30
  await page.keyboard.press('F4')
  await expect(row(page, ALFA).locator('.inp-pieces')).toBeFocused()
  await page.keyboard.type('3', { delay: 120 })
  await page.keyboard.press('Enter')
  await expect(scanInput(page), 'Enter в поле штук не вернул курсор в сканер').toBeFocused()
  expect(await total(page)).toBe(270)

  // F2 — скидка выбранной строки
  await page.keyboard.press('F2')
  await expect(row(page, ALFA).locator('.inp-discount')).toBeFocused()
  await page.keyboard.type('10', { delay: 120 })
  await page.keyboard.press('Enter')
  expect(await total(page)).toBe(260)

  // У неделимого товара поля штук нет — F4 объясняет, а не молчит
  await page.keyboard.press('ArrowDown')
  await expect(row(page, BETA)).toHaveClass(/sel/)
  await page.keyboard.press('F4')
  await expect(page.locator('.toast.err')).toContainText('целыми упаковками')

  await page.keyboard.press('Delete')
  await expect(row(page, BETA)).toHaveCount(0)
  await expect(rows(page)).toHaveCount(1)

  // Пока в поле набирают название, «+» — это буква, а не «упаковкой больше»
  await scanInput(page).fill('но')
  await page.keyboard.press('+')
  await expect(scanInput(page)).toHaveValue('но+')
  await expect(row(page, ALFA).locator('.qty-ctrl b')).toHaveText('1')
  // Escape стирает набранное
  await page.keyboard.press('Escape')
  await expect(scanInput(page)).toHaveValue('')
})

test('набор с клавиатуры попадает в сканер, даже если курсор стоял не в нём', async ({ page }) => {
  await kassa(page)
  await scan(page, ALFA)

  // Кассир щёлкнул по строке чека — курсор из поля сканера ушёл
  await row(page, ALFA).locator('.kt-name').click()
  await page.evaluate(() => document.activeElement?.blur?.())
  // …и взял сканер: код печатается «в никуда»
  await page.keyboard.type(BETA.barcode)
  await page.keyboard.press('Enter')
  await expect(row(page, BETA), 'скан после щелчка мышью потерялся').toBeVisible()
})

// ═════════ Сдача ═════════

test('сдача: не хватает — продажа закрыта, купюра ставит сумму, в чеке видно «Получено» и «Сдача»', async ({ page, request }) => {
  await kassa(page)
  await scan(page, ALFA)
  const recv = page.locator('#kassa-received')
  const pay = page.getByRole('button', { name: /Провести продажу/ })

  await recv.fill('150')
  await expect(page.locator('.kp-sdacha')).toContainText('Не хватает')
  await expect(page.locator('.kp-sdacha')).toContainText('50')
  await expect(pay, 'продажу дали провести, хотя денег не хватает').toBeDisabled()

  // Купюры считаются от суммы чека: для 200 — пятьсот и тысяча
  await page.locator('.kp-bills button', { hasText: /^500$/ }).click()
  await expect(recv).toHaveValue('500')
  await expect(page.locator('.kp-sdacha')).toContainText('Сдача')
  await expect(page.locator('.kp-sdacha')).toContainText('300')
  await expect(pay).toBeEnabled()

  await page.locator('.kp-bills button', { hasText: 'Без сдачи' }).click()
  await expect(recv).toHaveValue('200')
  // Ровно ноль, а не «−0»
  await expect(page.locator('.kp-sdacha b')).toHaveText(/^0\s/)

  // В поле денег прилетел штрихкод — это не сумма, и продажу он провести не должен
  await recv.fill('')
  await recv.focus()
  await page.keyboard.type(BETA.barcode + '\n')
  await expect(page.locator('.toast.err')).toContainText('похоже на штрихкод')
  await expect(page.locator('.modal'), 'штрихкод в поле «Получено» провёл продажу').toHaveCount(0)
  await expect(recv).toHaveValue('')

  // F9 — к оплате: курсор встаёт в «Получено», Enter проводит
  await scanInput(page).focus()
  await page.waitForTimeout(500) // остаток «выстрела» сканера касса глушит треть секунды
  await page.keyboard.press('F9')
  await expect(recv).toBeFocused()
  await page.keyboard.type('500', { delay: 120 })
  const sent = page.waitForResponse((r) => r.url().includes('/sales') && r.request().method() === 'POST', { timeout: 30_000 })
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')

  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await expect(receipt.locator('.total-row', { hasText: 'Получено' })).toContainText('500')
  await expect(receipt.locator('.total-row', { hasText: 'Сдача' })).toContainText('300')
  const res = await sent
  expect(res.ok(), 'сервер не принял продажу').toBe(true)
  // На сервер ушла сумма чека, а не полученная купюра
  expect(Number((await res.json()).total)).toBe(200)

  await receipt.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()
  await expect(recv, '«Получено» осталось от прошлого покупателя').toHaveValue('')

  const после = (await api(request, 'GET', '/products')).find((p) => p.id === ALFA.id)
  expect(после.stock, 'остаток не уменьшился ровно на одну упаковку').toBe(ALFA.stock - 1)
  ALFA.stock = после.stock
})

test('картой сдачу не спрашивают: F9 проводит продажу сразу', async ({ page }) => {
  await kassa(page)
  await scan(page, BETA)
  await page.locator('.pay-methods button', { hasText: 'Карта' }).click()
  await expect(page.locator('#kassa-received'), 'при оплате картой осталось поле «Получено»').toHaveCount(0)
  // После выбора способа оплаты курсор снова в сканере
  await expect(scanInput(page)).toBeFocused()

  const sent = page.waitForResponse((r) => r.url().includes('/sales') && r.request().method() === 'POST', { timeout: 30_000 })
  await page.keyboard.press('F9')
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await expect(receipt.locator('.total-row', { hasText: 'Получено' })).toHaveCount(0)
  expect((await sent).ok()).toBe(true)
  BETA.stock -= 1
  await receipt.getByRole('button', { name: 'Готово' }).click()
})

// ═════════ Открытые чеки ═════════

test('чеки: отложить, вернуться, пережить уход из кассы и перезагрузку, закрыть', async ({ page }) => {
  test.setTimeout(180_000)
  await kassa(page)
  await expect(tabs(page)).toHaveCount(1)

  // Пустой чек откладывать незачем
  await page.keyboard.press('F8')
  await expect(page.locator('.toast.err')).toContainText('пуст')
  await expect(tabs(page)).toHaveCount(1)

  await scan(page, ALFA)
  await page.keyboard.press('F8')
  await expect(tabs(page)).toHaveCount(2)
  await expect(tabs(page).nth(1)).toHaveClass(/active/)
  await expect(page.getByText('Корзина пуста')).toBeVisible()
  await expect(tabs(page).nth(0).locator('.chek-count')).toHaveText('1')

  await scan(page, BETA)
  await scan(page, BETA)
  await page.locator('.pay-methods button', { hasText: 'Карта' }).click()

  // Возвращаемся к первому покупателю: его чек цел, способ оплаты свой
  await tabs(page).nth(0).locator('.chek-tab-main').click()
  await expect(row(page, ALFA)).toBeVisible()
  await expect(row(page, BETA)).toHaveCount(0)
  await expect(page.locator('.pay-methods button.active')).toContainText('Наличные')
  await expect(tabs(page), 'непустой второй чек пропал при переходе').toHaveCount(2)

  // Ушли в другой раздел и вернулись — раньше набранное пропадало
  await goTo(page, 'Товары')
  await goTo(page, 'Касса')
  await expect(tabs(page)).toHaveCount(2)
  await expect(row(page, ALFA)).toBeVisible()

  // Перезагрузка страницы
  await page.reload()
  await expect(tabs(page)).toHaveCount(2, { timeout: 30_000 })
  await expect(row(page, ALFA)).toBeVisible()
  await tabs(page).nth(1).locator('.chek-tab-main').click()
  await expect(row(page, BETA).locator('.qty-ctrl b')).toHaveText('2')
  await expect(page.locator('.pay-methods button.active'), 'способ оплаты второго чека не сохранился').toContainText('Карта')

  // Продали второй чек — вкладка остаётся, пустая и готовая к следующему
  const sent = page.waitForResponse((r) => r.url().includes('/sales') && r.request().method() === 'POST', { timeout: 30_000 })
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  expect((await sent).ok()).toBe(true)
  BETA.stock -= 2
  await receipt.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()
  await expect(tabs(page)).toHaveCount(2)

  // Ушли с пустого чека — он вкладкой не остаётся
  await tabs(page).nth(0).locator('.chek-tab-main').click()
  await expect(tabs(page)).toHaveCount(1)
  await expect(row(page, ALFA)).toBeVisible()

  // Закрыть чек с товаром — только с подтверждением
  await page.keyboard.press('F8')
  await expect(tabs(page)).toHaveCount(2)
  await tabs(page).nth(0).locator('.chek-x').click()
  const ask = page.locator('.overlay .modal', { hasText: 'Закрыть чек' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Закрыть чек', exact: true }).click()
  await expect(tabs(page)).toHaveCount(1)
  await expect(page.getByText('Корзина пуста')).toBeVisible()
})

test('чеков одновременно не больше пяти', async ({ page }) => {
  test.setTimeout(120_000)
  await kassa(page)
  for (let i = 1; i <= 4; i++) {
    await scan(page, BETA)
    await page.keyboard.press('F8')
    await expect(tabs(page)).toHaveCount(i + 1)
  }
  await scan(page, BETA)
  await page.keyboard.press('F8')
  await expect(page.locator('.toast.err')).toContainText('Открыто чеков')
  await expect(tabs(page)).toHaveCount(5)
  // Номера идут подряд
  await expect(tabs(page).last()).toContainText('Чек 5')
})

test('пока чек лежал, цена и остаток изменились — касса говорит об этом сама', async ({ page, request }) => {
  test.setTimeout(180_000)
  await kassa(page)
  await scan(page, ALFA)
  await row(page, ALFA).locator('.qty-ctrl button').last().click()
  await expect(row(page, ALFA).locator('.qty-ctrl b')).toHaveText('2')
  expect(await total(page)).toBe(400)
  await page.keyboard.press('F8')
  await scan(page, BETA)

  // Владелец тем временем поднял цену
  await api(request, 'PATCH', `/products/${ALFA.id}`, { price: 250 })
  await tabs(page).nth(0).locator('.chek-tab-main').click()
  // Сигнал с сервера может запоздать — возвращение в окно заставляет кассу свериться сразу
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  const note = page.locator('.kassa-izm')
  await expect(note, 'касса промолчала о новой цене').toContainText('цена изменилась', { timeout: 30_000 })
  await expect(note).toContainText('250')
  expect(await total(page), 'в чеке осталась старая цена — сервер записал бы другую сумму').toBe(500)

  // Записка закрывается и не возвращается сама
  await note.locator('.chek-x').click()
  await expect(note).toHaveCount(0)

  // Теперь на складе осталась одна упаковка, а в чеке две
  await api(request, 'PATCH', `/products/${ALFA.id}`, { stock: 1, looseUnits: 0 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(note).toContainText('количество уменьшено', { timeout: 30_000 })
  await expect(row(page, ALFA).locator('.qty-ctrl b')).toHaveText('1')
  expect(await total(page)).toBe(250)

  // Товар закончился совсем — строка уходит из чека
  await api(request, 'PATCH', `/products/${ALFA.id}`, { stock: 0, looseUnits: 0 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(note).toContainText('закончился', { timeout: 30_000 })
  await expect(row(page, ALFA)).toHaveCount(0)

  // Возвращаем как было — следующим проверкам нужен товар
  await api(request, 'PATCH', `/products/${ALFA.id}`, { price: ALFA.price, stock: ALFA.stock })
})

// ═════════ Язык ═════════

test('касса на таджикском: новые надписи переведены', async ({ page }) => {
  test.setTimeout(120_000)
  await kassa(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Тоҷикӣ' }).click()
  try {
    await page.goto('/pos')
    await expect(page.locator('.chek-new')).toContainText('Чекро ба таъхир гузоштан')
    await expect(page.locator('.kp-line label')).toHaveText('Гирифта шуд')
    await expect(page.locator('.kc-cats .chip').first()).toHaveText('Ҳама')
    await scanInput(page).fill(ALFA.barcode)
    await scanInput(page).press('Enter')
    await expect(page.locator('.kassa-table thead')).toContainText('Тахфиф')
    await page.locator('#kassa-received').fill('500')
    await expect(page.locator('.kp-sdacha')).toContainText('Бақияи пул')
    await page.locator('#kassa-received').fill('1')
    await expect(page.locator('.kp-sdacha')).toContainText('Намерасад')
  } finally {
    // Возвращаем русский, чтобы следующие проверки шли с чистого
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Русский' }).click()
  }
})

// ═════════ Телефон ═════════

test.describe('Телефон', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true })

  // Ничего не должно вылезать за край экрана: листать кассу вбок кассиру некогда
  async function неВылезает(page, где) {
    const r = await page.evaluate(() => {
      const vw = window.innerWidth
      const лишние = [...document.querySelectorAll('.kassa *')]
        .filter((el) => {
          const b = el.getBoundingClientRect()
          // Плашки категорий листаются вбок внутри своего ряда — это задумано
          return b.width > 0 && b.right > vw + 1 && !el.closest('.kc-cats')
        })
        .slice(0, 3)
        .map((el) => el.className || el.tagName)
      return { ширина: document.documentElement.scrollWidth, vw, лишние }
    })
    expect(r.ширина, `${где}: страница листается вбок`).toBeLessThanOrEqual(r.vw)
    expect(r.лишние, `${где}: элементы вылезли за край экрана`).toEqual([])
  }

  test('чек и каталог по очереди, набор названия сам открывает каталог', async ({ page }) => {
    test.setTimeout(180_000)
    await login(page)
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('apteka_cheki_')) localStorage.removeItem(k)
    })
    await page.goto('/pos')
    const sw = page.locator('.kassa-switch')
    await expect(sw).toBeVisible()
    await expect(page.locator('.kassa-receipt')).toBeVisible()
    await expect(page.locator('.kassa-catalog'), 'на телефоне чек и каталог показаны разом').toBeHidden()
    // Подсказки по клавишам на телефоне ни к чему
    await expect(page.locator('.kassa-keys')).toBeHidden()

    // Набрали название — каталог открылся сам
    await scanInput(page).fill(`${TAG} Альфа`)
    await expect(page.locator('.kassa-catalog')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.kc-row').first()).toContainText(ALFA.name, { timeout: 30_000 })
    await неВылезает(page, 'каталог')
    await page.locator('.kc-row', { hasText: ALFA.name }).click()
    // …и сам закрылся: товар выбран, кассиру нужен чек
    await expect(page.locator('.kassa-receipt')).toBeVisible()
    await expect(row(page, ALFA)).toBeVisible()

    // Набрали название, но захотели взглянуть на чек — каталог не выскакивает обратно
    await scanInput(page).fill(`${TAG} Гамма`)
    await expect(page.locator('.kassa-catalog')).toBeVisible()
    await sw.getByRole('tab', { name: /Чек/ }).click()
    await page.waitForTimeout(700)
    await expect(page.locator('.kassa-receipt'), 'каталог сам вернулся поверх чека').toBeVisible()
    await scanInput(page).fill('')

    // Каталог открыли кнопкой — он остаётся открытым, пока в нём выбирают
    await sw.getByRole('tab', { name: 'Каталог' }).click()
    await scanInput(page).fill(`${TAG} Бета`)
    await page.locator('.kc-row', { hasText: BETA.name }).click()
    await expect(page.locator('.toast')).toContainText('добавлен в корзину')
    await expect(page.locator('.kassa-catalog')).toBeVisible()
    await expect(sw.locator('.chek-count'), 'на вкладке «Чек» не видно, сколько товаров набрано').toHaveText('2')

    await sw.getByRole('tab', { name: /Чек/ }).click()
    await expect(rows(page)).toHaveCount(2)
    await page.locator('#kassa-received').fill('1000')
    await expect(page.locator('.kp-sdacha')).toContainText('Сдача')

    for (const w of [320, 360, 425]) {
      await page.setViewportSize({ width: w, height: 740 })
      await page.waitForTimeout(250)
      await неВылезает(page, `чек на ${w}`)
      // Строка чека — карточка: поля не уезжают за её край
      const вКарточке = await rows(page).first().evaluate((tr) => {
        const k = tr.getBoundingClientRect()
        return [...tr.querySelectorAll('input, button')].every((el) => {
          const b = el.getBoundingClientRect()
          return b.left >= k.left - 1 && b.right <= k.right + 1
        })
      })
      expect(вКарточке, `на ${w} поля строки вылезли за карточку`).toBe(true)
    }

    // Убираем за собой: чек с товаром не должен остаться на устройстве
    await page.locator('[data-tour="pos.clear"]').click()
    await expect(page.getByText('Корзина пуста')).toBeVisible()
  })
})
