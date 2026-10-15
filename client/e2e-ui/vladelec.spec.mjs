// ── День владельца ──
// Возврат товара, деньги в отчётах и поиск по журналам — то, ради чего владелец
// вообще открывает программу.
import { test, expect } from '@playwright/test'
import { login, goTo, addProduct, removeProducts, waitForProducts, scan, withServer, tag, barcode, moneyValue } from './helpers.mjs'

const TAG = tag()
const NAME = TAG + ' Нурофен'
const CODE = barcode()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await addProduct(page, { name: NAME, code: CODE, price: '150', cost: '100', stock: '10', unitsPerPack: '1' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await login(page)
  await removeProducts(page, TAG)
  await page.close()
})

test('панель управления показывает деньги за сегодня', async ({ page }) => {
  await login(page)
  await goTo(page, 'Панель управления')
  const cards = page.locator('.cards .metric')
  await expect(cards.filter({ hasText: 'Продажи за сегодня' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Прибыль за сегодня' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Остаток на складе' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Долги клиентов' })).toBeVisible()
})

test('продаём две упаковки — чек уходит в базу', async ({ page }) => {
  await login(page)
  await goTo(page, 'Касса')
  await waitForProducts(page, TAG)
  await scan(page, CODE)
  await scan(page, CODE)
  await expect(page.locator('.cart-panel .total-row.big')).toContainText('300')

  await withServer(page, '/sales', () => page.getByRole('button', { name: /Провести продажу/ }).click())
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await receipt.getByRole('button', { name: 'Готово' }).click()
})

test('возврат по чеку возвращает товар на склад', async ({ page }) => {
  await login(page)
  await goTo(page, 'Возврат товара')

  // На странице теперь два поиска: по чекам и по журналу возвратов.
  // Различаем по подписи в поле, а не по классу.
  await page.getByPlaceholder('Поиск чека по товару или сумме…').fill(TAG)
  const saleRow = page.locator('tbody tr', { hasText: TAG }).first()
  await expect(saleRow).toBeVisible()
  await saleRow.getByRole('button', { name: /Выбрать/ }).click()

  const form = page.locator('.panel', { hasText: 'Что возвращают' })
  await expect(form).toBeVisible()
  // Возвращаем одну упаковку из двух, товар годен — обратно в продажу
  await form.locator('input.disc-input').first().fill('1')
  await expect(form.locator('.total-row.big')).toContainText('150')

  await withServer(page, '/returns', () => form.getByRole('button', { name: /Оформить возврат/ }).click())
  const done = page.locator('.modal', { hasText: 'Возврат оформлен' })
  await expect(done).toBeVisible()
  await expect(done).toContainText('в продажу')
  await done.getByRole('button', { name: 'Готово' }).click()
})

test('остаток вернулся: продали две, вернули одну', async ({ page }) => {
  await login(page)
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(TAG)
  // Было 10, продали 2, вернули 1 → 9
  await expect(page.locator('tbody tr', { hasText: TAG }).first()).toContainText('9')
})

test('в разбивке прибыли слагаемые сходятся с итогом', async ({ page }) => {
  await login(page)
  await goTo(page, 'Панель управления')
  await page.locator('.metric', { hasText: 'Прибыль за сегодня' }).click()

  const modal = page.locator('.modal', { hasText: 'Прибыль за сегодня' })
  await expect(modal).toBeVisible()

  // Читаем всю разбивку одним снимком: цифры обновляются в фоне, и строки,
  // прочитанные по очереди, могли оказаться из разных мгновений
  const readAll = async () => {
    // Берём подпись и значение из своих ячеек. Выкусывать число из общего текста
    // строки нельзя: у «Возвращено покупателям» и «Списано» рядом с подписью
    // стоит счётчик операций, и он попадал в сумму.
    const rows = await modal.locator('.total-row').evaluateAll((els) =>
      els.map((el) => {
        const cells = el.querySelectorAll(':scope > span')
        return { label: cells[0] ? cells[0].textContent : '', value: cells.length ? cells[cells.length - 1].textContent : '' }
      }),
    )
    const pick = (label) => {
      const row = rows.find((r) => r.label.includes(label))
      return row ? moneyValue(row.value) : 0
    }
    return {
      gross: pick('Продано на'),
      cost: pick('Себестоимость проданного'),
      refunds: pick('Возвращено покупателям'),
      back: pick('Товар вернулся на склад'),
      written: pick('Списано'),
      left: pick('Осталось прибыли'),
    }
  }

  // Ровно та формула, что и на сервере. Раньше себестоимость вернувшегося товара
  // на экране не показывалась, и слагаемые не сходились с итогом.
  await expect
    .poll(async () => {
      const v = await readAll()
      return Math.abs(v.gross - v.cost - v.refunds + v.back - v.written - v.left)
    }, { timeout: 20000 })
    .toBeLessThan(0.02)
})

test('журнал возвратов ищет по товару', async ({ page }) => {
  await login(page)
  await goTo(page, 'Возврат товара')

  const journal = page.locator('.panel', { hasText: 'История возвратов' })
  const search = page.getByPlaceholder('Поиск по товару или кассиру…')
  await expect(search).toBeVisible()

  await search.fill(TAG)
  await expect(journal.locator('tbody tr', { hasText: TAG }).first()).toBeVisible()

  await search.fill('такого-товара-нет-ниоткуда')
  await expect(journal.getByText(/ничего не найдено/i)).toBeVisible()
})

test('журнал приходов ищет и фильтрует по периоду', async ({ page }) => {
  await login(page)
  await goTo(page, 'Приход товара')

  const search = page.getByPlaceholder('Поиск по поставщику или товару…')
  await search.fill('такого-поставщика-нет')
  await expect(page.getByText(/ничего не найдено/i)).toBeVisible()
  await search.fill('')

  // Период переключается и подпись о числе найденного обновляется
  await page.getByRole('button', { name: '7 дней', exact: true }).click()
  await expect(page.getByText(/Найдено записей/)).toBeVisible()
  await page.getByRole('button', { name: 'Всё время', exact: true }).click()
  await expect(page.getByText(/Найдено записей/)).toBeVisible()
})

test('в списаниях есть фильтр по причине и убыток за период', async ({ page }) => {
  await login(page)
  await goTo(page, 'Списание')

  const journal = page.locator('.panel', { hasText: 'История списаний' })
  await expect(journal).toContainText(/убыток за период/i)

  const reason = journal.locator('select')
  await reason.selectOption({ label: 'Просрочен' })
  await expect(page.getByText(/Найдено записей/)).toBeVisible()
})

test('отчёты считают выручку и прибыль за период', async ({ page }) => {
  await login(page)
  await goTo(page, 'Отчёты')

  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  const cards = page.locator('.cards .metric')
  await expect(cards.filter({ hasText: 'Выручка' })).toBeVisible()
  // По точной подписи: рядом стоит ещё и «Чистая прибыль»
  await expect(cards.filter({ has: page.locator('.label', { hasText: /^Прибыль$/ }) })).toBeVisible()
  await expect(cards.filter({ has: page.locator('.label', { hasText: /^Чистая прибыль$/ }) })).toBeVisible()

  // «Всё время» уходит глубже кэша — данные догружаются с сервера
  await page.getByRole('button', { name: 'Всё время', exact: true }).click()
  await expect(cards.filter({ hasText: 'Чеков' })).toBeVisible()
  await expect(page.locator('.note.info', { hasText: 'Загружаем историю' })).toBeHidden({ timeout: 30000 })
})

test('кассиру хозяйские разделы не показывают', async ({ page }) => {
  await login(page)
  const nav = page.locator('.sidebar nav')
  // У владельца они есть
  await expect(nav.getByRole('link', { name: 'Отчёты' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Списание' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Сотрудники' })).toBeVisible()
})

// ── Две цены одного склада ──
//
// Владелец завёл первый товар — закупка 10, продажа 20, 50 упаковок — и прочитал
// в панели «Остаток на складе — 1000», решив, что столько у него добра. Вложил он
// 500. Вторые 500 это прибыль, которой ещё нет: она появится, только когда всё
// продастся. Одно число на два разных вопроса вводило в заблуждение, поэтому
// теперь их два, и у каждого подписано, по какой цене оно считается.
//
// Проверка стережёт не наличие ячейки, а саму арифметику: что одно считается
// по закупочной, другое по продажной, и что после продажи каждое уменьшается
// на свою цену. Перепутать их местами — ровно та ошибка, которую здесь ловят.
test('«вложено» считается по закупке, «остаток» по продаже', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)

  // Свой товар с круглыми числами: закупка 10, продажа 20, 4 упаковки
  const name = TAG + ' Склад'
  const code = barcode()
  await addProduct(page, { name, code, price: '20', cost: '10', stock: '4', unitsPerPack: '1' })

  // Числа снимаем текстом, а разбираем общим moneyValue: он знает про пробелы
  // между тысячами И про запятую в копейках. Своя «вырежем всё, кроме цифр»
  // превращала 9 990,4 в 99904 — и проверка ловила несуществующие расхождения
  const снимок = async () => {
    const пары = await page.evaluate(() =>
      [...document.querySelectorAll('.cards .metric')].map((el) => [
        el.querySelector('.label').innerText.trim(),
        el.querySelector('.value').innerText || '',
      ]),
    )
    return Object.fromEntries(пары.map(([k, v]) => [k, moneyValue(v)]))
  }

  // Список товаров едет с сервера и достраивается на ходу. Прочитать панель
  // в этот момент — значит сравнить недогруженное с догруженным и списать
  // расхождение на расчёт. Поэтому ждём, пока два чтения подряд совпадут
  const карточки = async () => {
    await goTo(page, 'Панель управления')
    await expect(page.locator('.cards .metric').first()).toBeVisible({ timeout: 30_000 })
    let было = null
    await expect
      .poll(
        async () => {
          const стало = await снимок()
          const одинаково = было && JSON.stringify(было) === JSON.stringify(стало)
          было = стало
          return одинаково && стало['Вложено в товар'] !== undefined
        },
        { timeout: 60_000, intervals: [700, 700, 700, 1000] },
      )
      .toBe(true)
    return было
  }

  const до = await карточки()
  expect(до['Вложено в товар'], 'ячейки «Вложено в товар» нет в панели').not.toBeUndefined()
  // Оба числа считаются по всему складу, поэтому сравниваем разницу, а не суммы:
  // в магазине уже лежит товар из подготовки прогона
  const вложеноДо = до['Вложено в товар']
  const остатокДо = до['Остаток на складе']
  // Сравнивать сами суммы между собой нельзя: «вложено меньше выручки» верно
  // не всегда — товар распродают и дешевле закупки. Смысл проверки в том,
  // как эти числа МЕНЯЮТСЯ, и это ниже

  // Продаём две упаковки: вложено падает на 2×10, остаток на 2×20
  await goTo(page, 'Касса')
  // Корзина живёт на устройстве и переживает переходы между проверками.
  // Чужая позиция в ней увела бы обе суммы, и провал списали бы на расчёт
  const clear = page.getByRole('button', { name: /Очистить корзину/ })
  if (await clear.isVisible().catch(() => false)) await clear.click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()

  await waitForProducts(page, name)
  await scan(page, code)
  await scan(page, code)
  await expect(page.locator('tbody tr', { hasText: name })).toHaveCount(1)
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 40_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay.printable')).toBeHidden()

  const после = await карточки()
  // toBeCloseTo, а не toBe: суммы дробные, и разность двух дробных чисел
  // в двоичной арифметике даёт хвост вроде 20.000000000000909
  expect(
    вложеноДо - после['Вложено в товар'],
    'вложено уменьшилось не по закупочной цене',
  ).toBeCloseTo(20, 2)
  expect(
    остатокДо - после['Остаток на складе'],
    'остаток уменьшился не по цене продажи',
  ).toBeCloseTo(40, 2)

  // Разбивка обязана сходиться с самой ячейкой: иначе владелец увидит
  // одно число в панели и другое, когда откроет её
  await page.locator('.cards .metric', { hasText: 'Вложено в товар' }).click()
  const modal = page.locator('.modal', { hasText: 'Вложено в товар' })
  await expect(modal).toBeVisible({ timeout: 15_000 })
  const итого = moneyValue(await modal.locator('.mini-card').first().innerText())
  expect(итого, 'итог в разбивке не совпал с ячейкой').toBeCloseTo(после['Вложено в товар'], 2)
  await page.keyboard.press('Escape')

  await removeProducts(page, name)
})
