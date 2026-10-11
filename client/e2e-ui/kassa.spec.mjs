// ── Рабочий день кассира ──
// Проверяется то, что человек действительно делает руками: сканирует товар,
// правит количество, даёт скидку, проводит продажу и печатает чек.
import { test, expect } from '@playwright/test'
import { login, goTo, addProduct, removeProducts, waitForProducts, scan, withServer, tag, barcode, moneyValue } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Парацетамол'
const CODE = barcode()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  // Последовательные сценарии при повторе прогоняются с самого начала, вместе с
  // подготовкой. Товар с тем же штрихкодом второй раз не заведётся, поэтому
  // сначала убираем следы прошлой попытки — иначе дальше работали бы с пустотой.
  await removeProducts(page, TAG)
  await addProduct(page, { name: NAME, code: CODE, price: '200', cost: '120', stock: '10', unitsPerPack: '20' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await page.close()
})

test('касса открывается и ждёт сканер', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  const scan = page.locator('.scan-input')
  await expect(scan).toBeVisible()
  // Поле сканера должно быть в фокусе само: кассир не должен щёлкать по нему мышью
  await expect(scan).toBeFocused()
  await expect(page.getByText('Корзина пуста')).toBeVisible()
})

test('сканирование штрихкода кладёт товар в корзину', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  const row = page.locator('.panel', { hasText: 'Корзина' }).locator('tbody tr').first()
  await expect(row).toContainText(NAME)
  await expect(page.locator('.cart-panel')).toContainText('200')
})

test('неизвестный штрихкод предлагает завести товар', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, '2770000000999')
  const modal = page.locator('.modal', { hasText: 'Новый товар по штрихкоду' })
  await expect(modal).toBeVisible()
  // «Добавить позже» — штрихкод уходит в отложенные, приёмка не прерывается
  await expect(modal.getByRole('button', { name: /Добавить позже/ })).toBeVisible()
  await modal.getByRole('button', { name: 'Отмена' }).click()
  await expect(modal).toBeHidden()
})

test('поштучная продажа считает цену за штуку', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  const cart = page.locator('.panel', { hasText: 'Корзина' })
  const row = cart.locator('tbody tr').first()

  // Упаковка 200 за 20 таблеток. Добавляем 5 таблеток: 200 + 200/20 × 5 = 250
  await row.locator('input.disc-input').first().fill('5')
  await expect(page.locator('.cart-panel .total-row.big')).toContainText('250')

  // Теперь убираем целую упаковку — остаются только 5 таблеток на 50.
  // Строка при этом обязана остаться: пустой её делает лишь ноль и упаковок, и штук.
  await row.locator('.qty-ctrl button').first().click()
  await expect(row).toBeVisible()
  await expect(page.locator('.cart-panel .total-row.big')).toContainText('50')
})

test('скидка не может превысить сумму позиции', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  const row = page.locator('.panel', { hasText: 'Корзина' }).locator('tbody tr').first()
  // Вторая ячейка с числом — скидка
  await row.locator('input.disc-input').last().fill('99999')

  const total = await page.locator('.cart-panel .total-row.big span').last().textContent()
  expect(moneyValue(total)).toBe(0)
  await expect(page.locator('.toast')).toContainText(/Скидка не больше/)
})

test('продажа проходит и печатается чек', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  // Чек печатается сразу, а запись уходит следом — дожидаемся именно записи
  await withServer(page, '/sales', () => page.getByRole('button', { name: /Провести продажу/ }).click())

  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText(NAME)
  await expect(receipt).toContainText('200')
  await expect(receipt.getByRole('button', { name: /Печать/ })).toBeVisible()

  await receipt.getByRole('button', { name: 'Готово' }).click()
  await expect(receipt).toBeHidden()
  // Корзина очищена — касса готова к следующему покупателю
  await expect(page.getByText('Корзина пуста')).toBeVisible()
})

test('продажа в долг без клиента не проходит', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)

  await page.locator('.pay-methods button', { hasText: 'В долг' }).click()
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  await expect(page.locator('.toast')).toContainText(/Выберите клиента/)
})

test('остаток на складе уменьшился после продажи', async ({ page }) => {
  await login(page)
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(TAG)
  const row = page.locator('tbody tr', { hasText: TAG }).first()
  // Было 10 упаковок, продали одну целиком — осталось 9
  await expect(row).toContainText('9')
})


// ── Переход в раздел не должен ждать загрузки его кода ──
// Код каждого раздела лежит отдельным куском. Первый переход туда скачивал его —
// 230 мс на пустом месте, и так по разу для каждого раздела, всегда в тот момент,
// когда человек уже нажал. Теперь всё докачивается заранее, пока человек смотрит
// на первый экран.
//
// Порог намеренно с большим запасом: без докачки выходило 230 мс, с ней — 35.
// Между этими числами можно поставить черту, не боясь случайной медленной машины.
test('переход в раздел мгновенный — код разделов уже скачан', async ({ page }) => {
  await login(page)
  // Даём браузеру дойти до свободной минуты и докачать остальное
  await page.waitForTimeout(6000)

  for (const name of ['Товары', 'Приход товара', 'Срок годности']) {
    const at = Date.now()
    await page.locator('.sidebar').getByRole('link', { name, exact: false }).first().click()
    await page.locator('.topbar h1').first().waitFor()
    const ms = Date.now() - at
    expect(ms, `раздел «${name}» открывался ${ms} мс — код раздела качается в момент нажатия`).toBeLessThan(150)
  }
})

// ── Завёл товар и тут же продал ──
// Так и делают в жизни: привезли новинку, кассир завёл карточку и сразу пробил
// первому покупателю. Ни секунды паузы.
//
// Программа показывает новый товар мгновенно, ещё до ответа сервера, — под временным
// номером. Корзина этот номер запоминала, сервер присылал настоящий, и продажа
// срывалась с «Товар не найден» на товар, который прямо на экране.
//
// Пряталось это за медлительностью: пока переход между разделами занимал вчетверо
// больше времени, чем ответ сервера, подмена всегда успевала пройти раньше. Стоило
// программе стать быстрой — и ошибка вылезла. Поэтому здесь НИ ОДНОЙ паузы: любая
// пауза прячет ровно ту беду, ради которой проверка написана.
test('товар, заведённый секунду назад, продаётся сразу', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)

  const name = TAG + ' Новинка'
  const code = barcode()

  await goTo(page, 'Товары')
  await page.getByRole('button', { name: /Добавить товар/ }).click()
  const modal = page.locator('.modal').first()
  await expect(modal).toBeVisible()
  await modal.locator('.field', { hasText: 'Название' }).locator('input').first().fill(name)
  await modal.locator('input[placeholder="487…"]').fill(code)
  await modal.locator('select').first().selectOption('Таблетки')
  const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
  await num('Закупочная цена').fill('60')
  await num('Цена продажи').fill('100')
  await num('Остаток').fill('10')
  await modal.getByRole('button', { name: /^Сохранить$/ }).click()
  await expect(modal).toBeHidden()

  // Сразу на кассу, без единой паузы
  await goTo(page, 'Касса')
  await page.locator('.scan-input').fill(code)
  await page.locator('.scan-input').press('Enter')
  const pay = page.getByRole('button', { name: /Провести продажу/ })
  await expect(pay).toBeEnabled()
  await pay.click()

  // Чек, а не отказ. Ошибку ловим отдельно и говорим прямо, в чём она.
  const err = page.locator('.toast.err')
  await expect(async () => {
    if (await err.count()) throw new Error('касса отказала: ' + (await err.first().innerText()))
    await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 2000 })
  }).toPass({ timeout: 40_000 })

  // Чек накрывает экран целиком — пока он открыт, до меню не добраться
  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay.printable')).toBeHidden()
  await removeProducts(page, name)
})

// ── Последнюю упаковку надо уметь вскрыть ──
// Настоящий случай из аптеки: остаток пять таблеток, в упаковке тоже пять. Касса
// при сканировании кладёт одну упаковку — те же самые пять штук. Покупателю нужны
// три таблетки, кассир набирает «3» в поле «Штук» — и получает отказ: программа
// считает, что он хочет упаковку И ЕЩЁ три штуки сверху.
//
// Выхода не было вовсе: убрать упаковку кнопкой «−» тоже было нельзя — при нуле
// строка исчезала из корзины. Последнюю пачку в системе нельзя было вскрыть.
test('из последней упаковки продаётся несколько штук', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)

  const name = TAG + ' Мексилейд'
  const code = barcode()
  // Ровно как у владельца на снимке: пять в упаковке, одна упаковка на складе
  await addProduct(page, { name, code, price: '280', cost: '150', stock: '1', unitsPerPack: '5' })
  await goTo(page, 'Касса')
  // Ждём, пока касса увидит новый товар в своём списке, и только потом сканируем
  await waitForProducts(page, name)
  await scan(page, code)
  const row = page.locator('.cart tbody tr, tbody tr', { hasText: name }).first()
  await expect(row).toBeVisible()

  // Пока упаковка в корзине, штуки не помещаются — и программа объясняет, что делать
  const pieces = row.locator('input').nth(0)
  await pieces.fill('3')
  await expect(page.locator('.toast.err')).toContainText(/Уберите упаковку/, { timeout: 10_000 })

  // Убираем упаковку. Строка обязана остаться — раньше она исчезала, и дальше идти
  // было некуда
  await row.getByRole('button').first().click()
  await expect(row, 'строка пропала после «−» — вскрыть последнюю пачку снова нельзя').toBeVisible()

  // Теперь три штуки помещаются
  await pieces.fill('3')
  await expect(row).toContainText('168', { timeout: 10_000 }) // 280 / 5 × 3

  const payBtn = page.getByRole('button', { name: /Провести продажу/ })
  await expect(payBtn).toBeEnabled()
  await payBtn.click()
  await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 40_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay.printable')).toBeHidden()

  // На складе должно остаться две штуки, а не ноль и не пять
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(name)
  const stock = page.locator('tbody tr', { hasText: name }).first()
  await expect(stock, 'списалось не три штуки, а что-то другое').toContainText(/\b2\b/, { timeout: 15_000 })

  await removeProducts(page, name)
})

// ── Форма товара в кассе и в «Товарах» — одна и та же ──
// Заводить товар можно двумя путями, и когда-то это были два отдельных куска кода.
// Они разъехались молча: в «Товары» добавили дозировку, срок годности, минимальный
// остаток, вскрытые штуки и аналоги, а кассовую форму не тронули. Владелец заводил
// товар с кассы и половину карточки не заполнял — потому что не знал, что она есть.
//
// Теперь форма общая. Эта проверка стережёт именно это: не «поля на месте»,
// а «списки полей совпадают». Добавит кто-нибудь поле в одну — увидит здесь.
test('форма товара в кассе и в «Товарах» совпадает поле в поле', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)

  const labels = () =>
    page.locator('.modal').first().evaluate((m) =>
      [...m.querySelectorAll('.field')].map((f) => (f.querySelector('label')?.innerText || '').trim()),
    )

  await goTo(page, 'Товары')
  await page.getByRole('button', { name: /Добавить товар/ }).click()
  await expect(page.locator('.modal').first()).toBeVisible()
  const vTovarah = await labels()
  await page.keyboard.press('Escape')

  await goTo(page, 'Касса')
  // Проверка доходит до кассы за четверть секунды после входа — быстрее, чем с
  // сервера приезжает список товаров. Пока его нет, касса незнакомый код не
  // принимает (иначе завели бы второй раз товар, который в базе уже есть) и просит
  // отсканировать ещё раз. Поэтому сначала дожидаемся списка
  await waitForProducts(page, TAG)
  await page.locator('.scan-input').fill(barcode())
  await page.locator('.scan-input').press('Enter')
  await expect(page.locator('.modal', { hasText: 'Новый товар по штрихкоду' })).toBeVisible()
  const vKasse = await labels()

  expect(vKasse, 'формы разъехались — в кассе не те поля').toEqual(vTovarah)
  expect(vTovarah.length, 'форма подозрительно короткая — что-то потерялось').toBeGreaterThan(9)
  // Единицы измерения владелец сервиса убрал: поле заполнялось всегда,
  // а значение почти всегда одно
  expect(vTovarah.join('|'), 'поле «Ед.» вернулось').not.toMatch(/Ед\./)
})

// ── Числа в чеке обязаны сходиться ──
// Покупатель умножает то, что видит. Раньше в строке стояло количество упаковок,
// а рядом цена одной ШТУКИ: «1 уп × 7,5 сомони», итог 150. Для неделимых товаров
// это совпадало и не всплывало — стоило завести пачку из двадцати таблеток,
// и чек начал врать.
test('в чеке количество и цена перемножаются в итог строки', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)

  const name = TAG + ' Пачка20'
  const code = barcode()
  await addProduct(page, { name, code, price: '150', cost: '80', stock: '2', unitsPerPack: '20' })

  await goTo(page, 'Касса')
  await waitForProducts(page, name)
  await scan(page, code)
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 40_000 })

  // Целая упаковка — по цене упаковки, а не по цене таблетки
  const line = (await page.locator('.modal tbody').first().innerText()).replace(/\s+/g, ' ')
  expect(line, `в строке чека не та цена: ${line}`).toMatch(/1 уп × 150/)
  await expect(page.locator('.modal .total-row.big')).toContainText('150')

  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay.printable')).toBeHidden()
  await removeProducts(page, name)
})

// ── Курсор в форме незнакомого штрихкода ──
// Форма открывается посреди продажи, покупатель стоит у прилавка. Куда встал
// курсор — решает, наберёт кассир код руками или переснимет сканером. Владелец
// сервиса выбрал штрихкод: сканер уже вписал код, но помятая упаковка или блик
// дают мусор, и переснять надо там же, не ища поле мышью.
//
// Проверяем три вещи разом, потому что порознь они бесполезны:
// курсор в штрихкоде, код в нём выделен целиком (повторный скан ЗАМЕНИТ, а не
// допишет в конец), и Enter уводит в название — сканер дожимает Enter сам,
// и без этого товар ушёл бы в базу без названия и цены.
test('в форме незнакомого штрихкода курсор стоит в штрихкоде', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)
  await goTo(page, 'Касса')

  // Пока список товаров не скачался, касса не знает, знакомый код или нет,
  // и молча глотает скан. Дожидаемся готовности, иначе проверка мигает
  await waitForProducts(page, TAG)

  const code = barcode()
  await scan(page, code)
  const modal = page.locator('.modal', { hasText: 'Новый товар по штрихкоду' })
  await expect(modal).toBeVisible()

  const where = await page.evaluate(() => {
    const el = document.activeElement
    const label = el?.closest('.field')?.querySelector('label')?.innerText?.trim() || ''
    return { label, value: el?.value ?? '', from: el?.selectionStart, to: el?.selectionEnd }
  })
  expect(where.label, `курсор ушёл в поле «${where.label}»`).toMatch(/Штрихкод/)
  expect(where.value, 'сканированный код не попал в поле').toBe(code)
  expect(
    where.to - where.from,
    'код не выделен — повторный скан допишется в конец и получится мусор',
  ).toBe(code.length)

  // Сканер дожимает Enter — товар не должен сохраниться полупустым
  await page.keyboard.press('Enter')
  await expect(modal, 'Enter сохранил товар без названия').toBeVisible()
  const after = await page.evaluate(
    () => document.activeElement?.closest('.field')?.querySelector('label')?.innerText?.trim() || '',
  )
  expect(after, 'Enter не увёл курсор в название').toMatch(/Название/)

  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
})
