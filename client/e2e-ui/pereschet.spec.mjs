// ── Пересчёт остатков: что уходит на сервер и чем кончается «Применить» ──
// Сотрудник весь день считает товар, вносит числа и нажимает «Применить». Лист при
// этом лежит на сервере, и считать его могут с двух устройств сразу. Здесь проверяется
// то, что видит и получает человек:
//   • насчитанное уходит вместе с просьбой применить, одним запросом, и только строки,
//     изменённые на этом устройстве, — чужие числа вкладка не стирает;
//   • введённое не пропадает, если сохранить или применить не вышло, — оно лежит на
//     устройстве и переживает перезагрузку страницы;
//   • страница не пугает отказом, когда применение прошло, а потерялся только ответ;
//   • и не молчит, когда лист применён с другими числами, чем были на экране;
//   • с сервером прежней версии (он обновляется на минуты позже сайта) числа уходят
//     по-старому, отдельным запросом, а не теряются.
import { test, expect } from '@playwright/test'
import { login, goTo, tag, barcode, toast } from './helpers.mjs'

const TAG = tag()
const CAT = TAG + '-kat'
const NAME = TAG + ' Считаный'
const NAME2 = TAG + ' Второй'

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
let second
let category

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  category = await call('POST', '/categories', { name: CAT, noExpiry: true })
  product = await call('POST', '/products', { name: NAME, barcode: barcode(), category: CAT, cost: 10, price: 20, stock: 10, minStock: 0, unitsPerPack: 1, unit: 'уп' })
  second = await call('POST', '/products', { name: NAME2, barcode: '278' + String(Date.now()).slice(-10), category: CAT, cost: 10, price: 20, stock: 5, minStock: 0, unitsPerPack: 1, unit: 'уп' })
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  const call = await server(page)
  for (const s of (await call('GET', '/inventory')).filter((x) => x.scope === CAT && x.status !== 'applied')) await call('DELETE', '/inventory/' + s.id).catch(() => {})
  for (const p of [product, second]) if (p) await call('DELETE', '/products/' + p.id).catch(() => {})
  if (category) await call('DELETE', '/categories/' + category.id).catch(() => {})
  await page.close()
})

const rowOf = (page, name) => page.locator('tbody tr', { hasText: name })
const isApply = (r) => r.url().endsWith('/apply') && r.request().method() === 'POST'
// Запрос «чем кончилось применение» и перечитывание списка листов
const isLook = (r) => /\/api\/inventory\/[^/?]+\?wait=1$/.test(r.url())
const isList = (r) => /\/api\/inventory$/.test(r.url()) && r.request().method() === 'GET'

// Новый лист по своей категории: в нём две строки — наши товары
async function newSheet(page) {
  await goTo(page, 'Инвентаризация')
  await page.locator('[data-tour="inv.scope"] select').selectOption(CAT)
  const created = page.waitForResponse((r) => /\/api\/inventory$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 })
  await page.locator('[data-tour="inv.create"]').click()
  const sheet = await (await created).json()
  const row = rowOf(page, NAME)
  await expect(row).toBeVisible()
  return { sheet, row, line: (p) => sheet.items.find((i) => i.productId === p.id) }
}
const stockOf = async (call, p = product) => (await call('GET', '/products')).find((x) => x.id === p.id).stock
const sheetNow = async (call, id) => (await call('GET', '/inventory')).find((x) => x.id === id)

const confirmApply = async (page) => {
  await page.locator('[data-tour="inv.apply"]').click()
  await page.locator('.overlay .modal').getByRole('button', { name: 'Применить', exact: true }).click()
}
const failure = (page) => page.locator('.modal', { hasText: 'Пересчёт не применён' })
const other = (page) => page.locator('.modal', { hasText: 'Пересчёт применён с другими числами' })
// Любое сообщение о том, что применение кончилось не так, как ждали
const anyNotice = (page) => page.locator('.modal', { hasText: /Пересчёт не применён|Не удалось узнать|с другими числами/ })
// Строка нашего листа в списке пересчётов
const listed = (page, status) => page.locator('tbody tr', { hasText: CAT }).filter({ hasText: status })

test('ввели число и сразу нажали «Применить»: насчитанное уходит вместе с применением — и применено именно оно', async ({ page }) => {
  const call = await server(page)
  const { row, line } = await newSheet(page)
  const input = row.locator('input')

  // Штрихкод, считанный сканером не в то поле, числом на миллиарды не становится
  await input.pressSequentially('4780012345678')
  await expect(input).toHaveValue('478001234')
  await input.fill('7')

  // Какие запросы к листу ушли
  const sent = []
  page.on('request', (r) => /\/inventory\/[^/]+/.test(r.url()) && r.method() !== 'GET' && sent.push(r.method() + (r.url().endsWith('/apply') ? ' apply' : '')))

  const applied = page.waitForResponse(isApply, { timeout: 30000 })
  await confirmApply(page)
  const res = await applied
  expect(res.ok()).toBe(true)

  expect(sent, 'один запрос: отдельного сохранения перед применением быть не должно').toEqual(['POST apply'])
  expect(res.request().postDataJSON().items, 'в запросе — строка, изменённая на экране, и только она').toEqual([{ id: line(product).id, actualUnits: 7 }])
  expect(await stockOf(call), 'остаток — как насчитали').toBe(7)
  expect(await stockOf(call, second), 'товар, который не считали, не тронут').toBe(5)
  const sheet = (await res.json())
  expect(sheet.status).toBe('applied')
  const got = sheet.items.find((i) => i.productId === product.id)
  expect(got.actualUnits).toBe(7)
  expect(got.expectedUnits).toBe(10)
  expect(sheet.items.find((i) => i.productId === second.id).actualUnits).toBe(null)
  // Недостача оформлена списанием
  const lost = (await call('GET', '/writeoffs')).filter((w) => w.source === 'inventory' && w.items.some((i) => i.productId === product.id))
  expect(lost.length).toBe(1)
  expect(lost[0].items.reduce((n, i) => n + i.units, 0)).toBe(3)
  // На устройстве по применённому листу ничего не осталось
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), 'apteka_inv_' + sheet.id)).toBeNull()
})

test('запрос не дошёл до сервера — лист не применён, а введённое остаётся в листе, как бы его ни открыли', async ({ page }) => {
  const call = await server(page)
  const before = await stockOf(call)
  const { row } = await newSheet(page)
  await row.locator('input').fill('4')

  // Связь пропала ровно на применении
  await page.route('**/api/inventory/*/apply', (route) => route.abort())
  await confirmApply(page)
  // Страница сначала спрашивает сервер, что с листом (и переспрашивает), — отказ
  // появляется через несколько секунд
  await expect(failure(page)).toBeVisible({ timeout: 30000 })
  await expect(failure(page)).toContainText('Введённые числа остались на этом устройстве')
  expect(await stockOf(call), 'остаток не тронут').toBe(before)

  // Сообщение закрыли не кнопкой «Открыть лист», а клавишей — и открыли лист из списка.
  // Раньше в списке оставался лист без введённого: насчитанное пропадало
  await page.keyboard.press('Escape')
  await expect(failure(page)).toBeHidden()
  await expect(listed(page, 'не закончен')).toHaveCount(1)
  await listed(page, 'не закончен').getByRole('button', { name: 'Продолжить' }).click()
  const input = rowOf(page, NAME).locator('input')
  await expect(input).toHaveValue('4')

  // Связь вернулась — тот же лист применяется, и именно с этим числом
  await page.unroute('**/api/inventory/*/apply')
  const applied = page.waitForResponse(isApply, { timeout: 30000 })
  await confirmApply(page)
  expect((await applied).ok()).toBe(true)
  expect(await stockOf(call)).toBe(4)
})

test('применение прошло, а ответ потерялся — страница узнаёт это у сервера и не сообщает об отказе', async ({ page }) => {
  const call = await server(page)
  const { row } = await newSheet(page)
  await row.locator('input').fill('9')

  // Сервер запрос получил и выполнил, а ответ до страницы не дошёл
  let reached = false
  await page.route('**/api/inventory/*/apply', async (route) => {
    await route.fetch()
    reached = true
    await route.abort()
  })
  // Страница спрашивает сервер, чем кончилось, и, узнав, что лист применён,
  // перечитывает список. Оба ожидания — только о запросах ПОСЛЕ потерянного ответа:
  // список перечитывается и при создании листа, и тот запрос сюда попасть не должен
  let looked = false
  const look = page.waitForResponse((r) => reached && isLook(r), { timeout: 30000 }).then((r) => {
    looked = true
    return r
  })
  const reload = page.waitForResponse((r) => looked && isList(r), { timeout: 30000 })
  await confirmApply(page)
  expect((await (await look).json()).status, 'сервер ответил: лист применён').toBe('applied')
  await reload

  await expect(listed(page, 'применён').first()).toBeVisible()
  await expect(listed(page, 'не закончен')).toHaveCount(0)
  await expect(anyNotice(page)).toHaveCount(0)
  expect(await stockOf(call), 'лист применён — остаток как насчитали').toBe(9)
  // И остаток на экране не откатился к прежнему
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(NAME)
  await expect(rowOf(page, NAME).locator('td.num .badge')).toHaveText('9 уп')
  await expect(anyNotice(page)).toHaveCount(0)
})

test('связь пропала совсем — страница честно говорит, что не знает, чем кончилось, а со связью показывает как есть', async ({ page }) => {
  const call = await server(page)
  const { row } = await newSheet(page)
  await row.locator('input').fill('8')

  // Сервер запрос получил и выполнил, но ответ не дошёл — и с этой секунды связи нет
  // вовсе: спросить, что с листом, тоже не у кого. (Пропади связь раньше, до нажатия
  // «Применить», страница сказала бы «нет связи» и ничего не отправляла.)
  await page.route('**/api/inventory/*/apply', async (route) => {
    await route.fetch()
    await page.route('**/api/inventory/*', (r) => (r.request().method() === 'GET' ? r.abort() : r.continue()))
    await route.abort()
  })
  await confirmApply(page)
  const unknown = page.locator('.modal', { hasText: 'Не удалось узнать, применён ли пересчёт' })
  await expect(unknown).toBeVisible({ timeout: 30000 })
  // «Не применён» страница не говорит: она этого не знает
  await expect(failure(page)).toHaveCount(0)
  expect(await stockOf(call), 'на сервере лист применён').toBe(8)

  // Связь вернулась. Лист открывается таким, какой он на самом деле: применённым, с
  // тем самым числом — и без сообщений: применено ровно то, что вводили
  await page.unroute('**/api/inventory/*/apply')
  await page.unroute('**/api/inventory/*')
  await unknown.getByRole('button', { name: 'Открыть лист' }).click()
  await expect(page.locator('.note.info', { hasText: 'Этот пересчёт уже применён' })).toBeVisible()
  const input = rowOf(page, NAME).locator('input')
  await expect(input).toHaveValue('8')
  await expect(input).toBeDisabled()
  await expect(anyNotice(page)).toHaveCount(0)
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(NAME)
  await expect(rowOf(page, NAME).locator('td.num .badge')).toHaveText('8 уп')
})

test('пока страница отправляла своё, лист применили с другими числами — страница об этом говорит, а не молчит', async ({ page }) => {
  const call = await server(page)
  const { sheet, row, line } = await newSheet(page)
  await row.locator('input').fill('7')

  // «Другое устройство» успело раньше: внесло своё число и применило лист. Запрос
  // страницы приходит следом и получает отказ «уже применён»
  await page.route('**/api/inventory/*/apply', async (route) => {
    await call('POST', `/inventory/${sheet.id}/apply`, { items: [{ id: line(product).id, actualUnits: 70 }] })
    await route.continue()
  })
  const refused = page.waitForResponse(isApply, { timeout: 30000 })
  await confirmApply(page)
  expect((await refused).status(), 'сервер отказал: лист уже применён').toBe(400)

  // Раньше такой отказ принимался за успех: человеку показали «остатки обновлены», и
  // он остался в уверенности, что на складе семь
  await expect(other(page)).toBeVisible({ timeout: 30000 })
  await expect(failure(page)).toHaveCount(0)
  expect(await stockOf(call), 'остаток стоит по применённому листу').toBe(70)

  // Лист открывается применённым — с тем числом, которое применено на самом деле
  await other(page).getByRole('button', { name: 'Открыть лист' }).click()
  await expect(other(page)).toBeHidden()
  const input = rowOf(page, NAME).locator('input')
  await expect(input).toHaveValue('70')
  await expect(input).toBeDisabled()
  // И остаток на экране — настоящий, а не тот, что показали заранее
  await goTo(page, 'Товары')
  await page.locator('input.search').fill(NAME)
  await expect(rowOf(page, NAME).locator('td.num .badge')).toHaveText('70 уп')
})

test('лист применили с другого устройства до нажатия «Применить» — страница узнаёт это сама и ничего не отправляет', async ({ page }) => {
  const call = await server(page)
  const { sheet, row, line } = await newSheet(page)
  await row.locator('input').fill('7')
  await call('POST', `/inventory/${sheet.id}/apply`, { items: [{ id: line(product).id, actualUnits: 30 }] })

  const sent = []
  page.on('request', (r) => /\/inventory\/[^/]+/.test(r.url()) && r.method() !== 'GET' && sent.push(r.method()))
  await page.locator('[data-tour="inv.apply"]').click()
  // Вопроса «применить?» нет: применять нечего. Есть сообщение — введённое здесь в
  // применённый лист не попало
  await expect(other(page)).toBeVisible()
  expect(sent, 'ни сохранение, ни применение не отправлялись').toEqual([])
  await page.keyboard.press('Escape')
  // На экране — применённый лист с числом, которое применено
  await expect(page.locator('.note.info', { hasText: 'Этот пересчёт уже применён' })).toBeVisible()
  await expect(rowOf(page, NAME).locator('input')).toHaveValue('30')
  expect(await stockOf(call)).toBe(30)

  // А если применено ровно то, что введено и здесь, — сообщать не о чем
  await page.getByRole('button', { name: 'Назад к списку' }).click()
  const next = await newSheet(page)
  await next.row.locator('input').fill('12')
  await call('POST', `/inventory/${next.sheet.id}/apply`, { items: [{ id: next.line(product).id, actualUnits: 12 }] })
  await page.locator('[data-tour="inv.apply"]').click()
  await expect(toast(page).filter({ hasText: 'Этот пересчёт уже применён' })).toBeVisible()
  await expect(anyNotice(page)).toHaveCount(0)
  await expect(page.locator('.note.info', { hasText: 'Этот пересчёт уже применён' })).toBeVisible()
})

test('числа, внесённые с другого устройства, вкладка не стирает: уходят только строки, изменённые в ней', async ({ page }) => {
  const call = await server(page)
  const stock = await stockOf(call)
  const { sheet, row, line } = await newSheet(page)

  // Лист открыт на экране. Тем временем с телефона посчитали второй товар и сохранили
  await call('PATCH', `/inventory/${sheet.id}`, { items: [{ id: line(second).id, actualUnits: 3 }] })

  // Здесь считают первый
  await row.locator('input').fill(String(stock - 1))
  const applied = page.waitForResponse(isApply, { timeout: 30000 })
  await page.locator('[data-tour="inv.apply"]').click()
  // Вопрос «применить?» задаётся по свежему листу: недостача в двух позициях, а не в одной
  const ask = page.locator('.overlay .modal', { hasText: 'Применить пересчёт?' })
  await expect(ask).toContainText('Недостача: 2 поз.')
  await ask.getByRole('button', { name: 'Применить', exact: true }).click()
  const res = await applied
  expect(res.ok()).toBe(true)

  // Раньше вкладка отправляла лист целиком — таким, каким видела: с пустой второй
  // строкой. Число с телефона стиралось, и товар оставался непересчитанным
  expect(res.request().postDataJSON().items).toEqual([{ id: line(product).id, actualUnits: stock - 1 }])
  const done = await sheetNow(call, sheet.id)
  expect(done.items.find((i) => i.productId === second.id).actualUnits, 'число с телефона на месте').toBe(3)
  expect(await stockOf(call)).toBe(stock - 1)
  expect(await stockOf(call, second), 'второй товар пересчитан по числу с телефона').toBe(3)
  await expect(anyNotice(page)).toHaveCount(0)
})

test('сохранение не дошло до сервера — введённое остаётся на устройстве и после перезагрузки страницы', async ({ page }) => {
  const call = await server(page)
  const { sheet, row } = await newSheet(page)
  await row.locator('input').fill('6')

  // Связи нет: черновик до сервера не дошёл
  await page.route('**/api/inventory/*', (route) => (route.request().method() === 'PATCH' ? route.abort() : route.continue()))
  await page.locator('[data-tour="inv.draft"]').click()
  await expect(toast(page).filter({ hasText: 'На сервере пересчёт не сохранён' })).toBeVisible()
  expect((await sheetNow(call, sheet.id)).items.find((i) => i.productId === product.id).actualUnits, 'на сервере числа нет').toBe(null)

  // Ушли к списку, страницу перезагрузили — как после закрытой вкладки
  await page.getByRole('button', { name: 'Назад к списку' }).click()
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await goTo(page, 'Инвентаризация')
  await listed(page, 'не закончен').first().getByRole('button', { name: 'Продолжить' }).click()
  const input = rowOf(page, NAME).locator('input')
  await expect(input).toHaveValue('6')

  // Связь вернулась — число сохраняется на сервере, и на устройстве его больше не держат
  await page.unroute('**/api/inventory/*')
  const saved = page.waitForResponse((r) => r.url().endsWith('/inventory/' + sheet.id) && r.request().method() === 'PATCH', { timeout: 30000 })
  await page.locator('[data-tour="inv.draft"]').click()
  const res = await saved
  expect(res.ok()).toBe(true)
  expect(res.request().postDataJSON().items).toEqual([{ id: sheet.items.find((i) => i.productId === product.id).id, actualUnits: 6 }])
  expect((await sheetNow(call, sheet.id)).items.find((i) => i.productId === product.id).actualUnits).toBe(6)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), 'apteka_inv_' + sheet.id)).toBeNull()
  await expect(input).toHaveValue('6')
})

test('сервер прежней версии: числа уходят отдельным запросом до «применить», а не теряются', async ({ page }) => {
  const call = await server(page)
  const { sheet, row, line } = await newSheet(page)
  await row.locator('input').fill('5')

  // Сервер, который ещё не обновился, запроса «один лист» не знает. А числа в запросе
  // «применить» он бы молча пропустил и применил лист без них
  await page.route('**/api/inventory/*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ statusCode: 404, message: 'Cannot GET /api/inventory/' + sheet.id, error: 'Not Found' }) })
      : route.continue(),
  )
  const sent = []
  page.on('request', (r) => {
    if (!/\/inventory\/[^/]+/.test(r.url()) || r.method() === 'GET') return
    sent.push({ what: r.method() + (r.url().endsWith('/apply') ? ' apply' : ''), body: r.postDataJSON() })
  })
  const applied = page.waitForResponse(isApply, { timeout: 30000 })
  await confirmApply(page)
  expect((await applied).ok()).toBe(true)

  expect(sent.map((r) => r.what), 'сначала числа, потом «применить»').toEqual(['PATCH', 'POST apply'])
  expect(sent[0].body.items).toEqual([{ id: line(product).id, actualUnits: 5 }])
  expect(sent[1].body?.items, 'в «применить» чисел нет — прежний сервер их всё равно не читает').toBeUndefined()
  expect(await stockOf(call), 'остаток — как насчитали').toBe(5)
  await expect(anyNotice(page)).toHaveCount(0)
})
