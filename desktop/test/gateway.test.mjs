// ── Кто отвечает окну: локальная база или сервер ──
//
// Главное обещание программы — касса работает и без интернета. Здесь оно проверяется
// целиком, от запроса окна до записи на диск: настоящая локальная база, настоящие
// правила входа, а вместо сервера — заглушка, у которой можно «выдернуть провод».
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGateway, MESSAGES } from '../src/gateway.mjs'
import { accountByLogin } from '../src/local/accounts.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA, PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { DESKTOP_TOKEN } from '../src/net.mjs'
import { NO_OPEN_SHIFT } from '../src/local/ops/expense.mjs'
import { CATEGORIES, customer, EXPENSE_CATEGORIES, NOW, PAY_SERVICES, product, SUPPLIERS } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'

const PASS = 'sekret-1'

// permissions — права роли сотрудника; без них кассир получает минимум (см. CASHIER_DEFAULT)
function setup({ role = 'founder', permissions } = {}) {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('kassir', PASS, role, undefined, permissions ? { permissions } : {})
  srv.state.data.categories = CATEGORIES
  srv.state.data.expenseCategories = EXPENSE_CATEGORIES
  srv.state.data.suppliers = SUPPLIERS.map((s) => ({ ...s }))
  srv.state.data.payServices = PAY_SERVICES
  srv.state.data.products = [
    product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 }),
    product({ id: 'par', name: 'Парацетамол', unitsPerPack: 20, price: 200, cost: 120, stock: 9 }),
  ]
  srv.state.data.customers = [customer({ id: 'ivan', name: 'Иван', debt: 10 })]

  const core = openDb(':memory:', CORE_SCHEMA)
  const session = memorySession()
  const timers = manualTimers()
  const events = []
  const errors = []
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-gw-'))
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: srv.fetchImpl,
    session,
    core,
    cipher: fakeSeal,
    // lic — время срока работы без связи. Обычно то же, что время часов; на компьютере
    // со сбитыми часами оно уходит вперёд (time.licAhead)
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now + (time.licAhead || 0), floor: () => time.now },
    dataDir,
    timers,
    emit: (type, payload) => events.push({ type, payload }),
    log: { info() {}, warn() {}, error: (...a) => errors.push(a) },
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = (name = 'kassir', password = PASS) => req('POST', '/auth/login', { name, password })
  return { gw, srv, core, session, timers, events, errors, time, req, login, dataDir }
}

// Войти с интернетом и дождаться, пока данные лягут в локальную базу
async function loggedIn(opts) {
  const t = setup(opts)
  const r = await t.login()
  assert.equal(r.status, 201)
  await t.gw.syncNow()
  return t
}

// ── Вход ──

test('вход с интернетом: ключ остаётся в основной части, окно получает пометку', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  const r = await t.login()
  assert.equal(r.status, 201)
  assert.equal(r.data.token, DESKTOP_TOKEN)
  assert.equal(r.data.user.name, 'kassir')
  assert.equal(JSON.stringify(r).includes('ключ-kassir'), false, 'настоящий ключ утёк в окно')
  assert.match(t.session.get(), /^ключ-kassir-/)
  assert.equal(t.session.activeId(), 'acc-kassir')

  // Сотрудник запомнен для входа без интернета: отпечаток пароля, а не сам пароль
  const acc = accountByLogin(t.core, 'kassir')
  assert.equal(acc.role, 'founder')
  assert.equal(acc.pharmacyCode, 'apteka-1')
  assert.ok(acc.verifier.startsWith('dpapi:'), 'отпечаток пароля должен лежать зашифрованным')
  assert.equal(JSON.stringify(acc).includes(PASS), false, 'пароль записан как есть')
  assert.match(fakeSeal.open(acc.verifier), /^s3\$16384\$8\$4\$/, 'стойкость отпечатка — как на сервере')
})

test('неверный пароль с интернетом — отказ сервера как есть, входа нет', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  const r = await t.login('kassir', 'не-тот')
  assert.equal(r.status, 401)
  assert.equal(r.data.message, 'Неверное имя или пароль')
  assert.equal(t.session.has(), false)
  assert.equal(accountByLogin(t.core, 'kassir'), null)
  assert.equal((await t.req('GET', '/products')).status, 401)
})

test('владельцу сервиса программа не хранит ни ключ, ни вход', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  t.srv.addUser('admin', 'admin-pass-1', 'superadmin')
  const r = await t.login('admin', 'admin-pass-1')
  // Окно само покажет объяснение по роли (client/src/db/auth.js)
  assert.equal(r.data.user.role, 'superadmin')
  assert.equal(r.data.token, DESKTOP_TOKEN)
  assert.equal(t.session.has(), false)
  assert.equal(t.session.tokenOf('acc-admin'), '')
  assert.equal(accountByLogin(t.core, 'admin'), null)
  assert.equal((await t.req('GET', '/admin/pharmacies')).status, 401)
})

// ── Касса без интернета ──

test('списки отдаются из локальной базы — к серверу за ними окно не ходит', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.reset()
  const r = await t.req('GET', '/products')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.map((p) => [p.name, p.stock]), [['Нурофен', 5], ['Парацетамол', 9]])
  assert.ok(r.date, 'ответ несёт время программы — по нему окно сверяет свои часы')
  for (const path of ['/categories', '/customers', '/deferred', '/shifts', '/sales?days=60', '/returns?days=180', '/arrivals?days=180', '/writeoffs?days=180', '/payments?days=180']) {
    const x = await t.req('GET', path)
    assert.equal(x.status, 200, path)
    assert.ok(Array.isArray(x.data), path)
  }
  assert.equal(t.srv.state.calls.length, 0, 'чтение списков ушло на сервер')
})

test('продажа без интернета: чек записан, остаток уменьшен, сервер не нужен', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.online = false
  t.srv.reset()

  const sale = await t.req('POST', '/sales', { payment: 'cash', clientId: 'tmp_1', items: [{ productId: 'nur', qty: 2 }] })
  assert.equal(sale.status, 201)
  assert.equal(sale.data.total, 300)
  assert.deepEqual(sale.data.user.name, 'kassir')

  const products = await t.req('GET', '/products')
  assert.equal(products.data.find((p) => p.id === 'nur').stock, 3)
  const sales = await t.req('GET', '/sales?days=60')
  assert.deepEqual(sales.data.map((s) => s.id), [sale.data.id])

  // Отказ по существу — тем же кодом и текстом, что дал бы сервер
  const no = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 9 }] })
  assert.equal(no.status, 400)
  assert.equal(no.data.message, 'Недостаточно «Нурофен» на складе (есть 3 шт)')
  // Список нарушений в запросе приходит списком, как у сервера
  const bad = await t.req('POST', '/sales', { payment: 'cash', items: [] })
  assert.deepEqual(bad.data.message, ['Позиции: нужна хотя бы 1 позиция'])

  // Весь рабочий день кассы — без единого обращения к серверу за операциями
  for (const [method, path, body] of [
    ['POST', '/shifts/open', { openingCash: 50 }],
    ['POST', '/customers', { name: 'Новый' }],
    ['POST', '/customers/ivan/pay', { amount: 5 }],
    ['POST', '/returns', { saleId: sale.data.id, items: [{ productId: 'nur', units: 1 }] }],
    ['POST', '/arrivals', { items: [{ productId: 'nur', qty: 1, cost: 90, expiryDate: '2028-01-01' }] }],
    ['POST', '/writeoffs', { items: [{ productId: 'nur', units: 1 }] }],
    ['POST', '/deferred', { barcode: '4600000000017' }],
    ['POST', '/shifts/close', { countedCash: 55 }],
  ]) {
    const r = await t.req(method, path, body)
    assert.equal(r.status, 201, `${method} ${path}: ${JSON.stringify(r.data)}`)
  }
  assert.equal(t.srv.state.calls.filter((c) => c.method !== 'GET').length, 0)
  assert.equal(t.gw.pharmacyDb().prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n, 9)
  assert.equal(t.errors.length, 0)
})

test('программу закрыли и открыли без интернета — вход и данные на месте', async (tt) => {
  const t = await loggedIn()
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  t.gw.close()

  // «Перезапуск»: новая основная часть на тех же файлах, сервера нет
  t.srv.state.online = false
  const again = createGateway({
    apiUrl: API,
    fetchImpl: t.srv.fetchImpl,
    session: t.session,
    core: t.core,
    cipher: fakeSeal,
    clock: { now: () => t.time.now, serverTime: () => {} },
    dataDir: t.dataDir,
    timers: t.timers,
  })
  tt.after(() => again.close())
  assert.equal(again.resume(), true)

  const me = await again.request({ method: 'GET', path: '/auth/me' })
  assert.equal(me.status, 200)
  assert.equal(me.data.name, 'kassir')
  assert.equal(me.data.pharmacy.code, 'apteka-1')
  assert.equal(me.data.subscription.status, 'active')
  assert.equal(me.data.subscription.canWrite, true)

  const products = await again.request({ method: 'GET', path: '/products' })
  assert.equal(products.status, 200)
  assert.equal(products.data.find((p) => p.id === 'nur').stock, 4, 'продажа до перезапуска потерялась')
  const sale = await again.request({ method: 'POST', path: '/sales', body: { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] } })
  assert.equal(sale.status, 201)
})

test('пока данные ни разу не загрузились, касса честно говорит «нет связи»', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  // Вход прошёл, и тут связь оборвалась — каталог скачаться не успел
  t.srv.state.override = (method, route) => (route === '/auth/login' ? null : { status: 502, body: null })
  assert.equal((await t.login()).status, 201)
  const r = await t.req('GET', '/products')
  assert.equal(r.status, 0, 'пустой каталог выдан за настоящий')
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })).status, 0)

  // Связь вернулась — следующий же запрос дожидается загрузки и отвечает
  t.srv.state.override = null
  const ok = await t.req('GET', '/products')
  assert.equal(ok.status, 200)
  assert.equal(ok.data.length, 2)
})

// ── Вход без интернета ──

test('вход без интернета: тем же паролем, что и с интернетом', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  t.srv.state.online = false

  const wrong = await t.login('kassir', 'не-тот')
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.message, 'Неверное имя или пароль')
  assert.equal(t.session.has(), false)

  const r = await t.login()
  assert.equal(r.status, 201)
  assert.equal(r.data.token, DESKTOP_TOKEN)
  assert.equal(r.data.user.name, 'kassir')
  assert.equal(r.data.user.subscription.status, 'active')
  assert.equal(t.session.activeId(), 'acc-kassir')
  // И касса сразу работает
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })).status, 201)
})

test('вход без интернета: сервер лежит (502) — это тоже «нет связи»', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  t.srv.state.override = () => ({ status: 502, body: null })
  assert.equal((await t.login()).status, 201)
})

test('вход без интернета: чужая сеть со страницей входа вместо сервера — тоже «нет связи»', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  // Гостиничный или гостевой Wi-Fi: на любой запрос отвечает своей страницей с кодом 200
  const portal = async () => ({ status: 200, ok: true, headers: { get: () => 'Mon, 01 Jan 2001 00:00:00 GMT' }, text: async () => '<html>Войдите в сеть</html>' })
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: portal,
    session: t.session,
    core: t.core,
    cipher: fakeSeal,
    clock: { now: () => t.time.now, serverTime: () => assert.fail('часы перевёл посторонний ответ') },
    dataDir: t.dataDir,
    timers: t.timers,
  })
  t.gw.close()
  tt.after(() => gw.close())
  const r = await gw.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })
  assert.equal(r.status, 201, 'страницу чужой сети приняли за ответ сервера')
  assert.equal(r.data.user.name, 'kassir')
  assert.equal((await gw.request({ method: 'GET', path: '/auth/me' })).status, 200)
  assert.equal((await gw.request({ method: 'GET', path: '/products' })).status, 200)
  const users = await gw.request({ method: 'GET', path: '/users' })
  assert.equal(users.status, 0)
  assert.equal(users.data.message, MESSAGES.onlineOnly)
})

test('вход без интернета: кто здесь не входил — тому нужен интернет', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  t.srv.state.online = false
  const r = await t.login('vladelec', 'любой-пароль')
  assert.equal(r.status, 0, 'окно должно понять это как «нет связи», а не как неверный пароль')
  assert.equal(r.data.message, MESSAGES.noOfflineLogin)
  assert.equal(t.session.has(), false)
})

test('вход без интернета: пять промахов — вход закрыт, и перезапуск его не открывает', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  t.srv.state.online = false
  for (let i = 0; i < 5; i++) assert.equal((await t.login('kassir', 'промах-' + i)).status, 401)
  const closed = await t.login()
  assert.equal(closed.status, 429)
  assert.equal(closed.data.message, 'Слишком много неудачных попыток. Вход с этого устройства закрыт на 1 мин.')
  // Счёт лежит в базе: «перезапуск» (те же файлы) его не обнуляет
  assert.equal(t.core.prepare('SELECT COUNT(*) AS n FROM login_fails').get().n, 2)

  // Минута прошла — верный пароль проходит и снимает подозрения
  t.time.now += 61_000
  assert.equal((await t.login()).status, 201)
  assert.equal(t.core.prepare('SELECT COUNT(*) AS n FROM login_fails').get().n, 0)
})

test('сервер отказал во входе с прежним паролем — без интернета под ним тоже не войти', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  // Владелец сменил кассиру пароль с другого устройства
  t.srv.state.users.get('kassir').password = 'novyj-parol-9'
  assert.equal((await t.login()).status, 401)
  assert.equal(accountByLogin(t.core, 'kassir').verifier, null, 'старый пароль продолжил бы работать без интернета')

  t.srv.state.online = false
  const r = await t.login()
  assert.equal(r.status, 0)
  assert.equal(r.data.message, MESSAGES.noOfflineLogin)

  // Новый пароль через сервер — и вход без интернета снова есть, уже по новому
  t.srv.state.online = true
  assert.equal((await t.login('kassir', 'novyj-parol-9')).status, 201)
  t.gw.logout()
  t.srv.state.online = false
  assert.equal((await t.login('kassir', 'novyj-parol-9')).status, 201)
  t.gw.logout()
  assert.equal((await t.login()).status, 401)
})

test('чужая опечатка в пароле вход без интернета не отзывает', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  assert.equal((await t.login('kassir', 'опечатка')).status, 401)
  assert.ok(accountByLogin(t.core, 'kassir').verifier, 'отпечаток стёрт из-за неверно набранного пароля')
})

// ── Выход ──

test('после выхода окно не получает ничего — ни из базы, ни с сервера', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.logout()
  for (const [method, path] of [['GET', '/products'], ['GET', '/auth/me'], ['POST', '/sales'], ['GET', '/users'], ['POST', '/auth/change-password']]) {
    const r = await t.req(method, path, {})
    assert.equal(r.status, 401, `${method} ${path}`)
    assert.equal(r.data.message, MESSAGES.needLogin)
  }
  // Ключ при этом цел: им уйдёт на сервер сделанное без связи
  assert.match(t.session.tokenOf('acc-kassir'), /^ключ-kassir-/)
})

// ── «Кто я» и подписка ──

test('«кто я» с интернетом — ответ сервера; без него — по сохранённому, без выхода из системы', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  assert.equal((await t.req('GET', '/auth/me')).data.impersonatedBy, null)

  for (const broken of [() => (t.srv.state.online = false), () => ((t.srv.state.online = true), (t.srv.state.override = () => ({ status: 503, body: null })))]) {
    broken()
    const me = await t.req('GET', '/auth/me')
    assert.equal(me.status, 200, 'сбой связи выкинул бы человека из программы посреди смены')
    assert.equal(me.data.name, 'kassir')
    assert.equal(me.data.role, 'founder')
    assert.deepEqual(me.data.pharmacy, { code: 'apteka-1', name: 'Аптека №1' })
    assert.equal(me.data.subscription.paidUntil, '2026-11-01T12:00:00.000Z')
  }
})

test('подписка закончилась, пока интернета не было, — касса закрывается в назначенный час', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Накануне касса ещё была на связи: без связи она работает не дольше недели,
  // и здесь проверяется другое — срок самой подписки
  t.time.now = Date.parse('2026-10-31T10:00:00.000Z')
  await t.gw.syncNow()
  t.srv.state.online = false

  // За час до срока всё работает и предупреждает
  t.time.now = Date.parse('2026-11-01T11:00:00.000Z')
  const before = await t.req('GET', '/auth/me')
  assert.equal(before.status, 200)
  assert.equal(before.data.subscription.status, 'active')
  assert.equal(before.data.subscription.warn, true)
  assert.equal(before.data.subscription.daysLeft, 1)
  assert.equal(before.data.subscription.message, 'Подписка заканчивается 01.11.2026 в 17:00.')
  assert.equal((await t.req('GET', '/products')).status, 200)

  // Срок вышел
  t.time.now = Date.parse('2026-11-01T12:00:01.000Z')
  const text = 'Подписка закончилась 01.11.2026 в 17:00. Данные аптеки сохранены — работа продолжится сразу после оплаты. Обратитесь к поставщику программы.'
  const me = await t.req('GET', '/auth/me')
  assert.equal(me.status, 403)
  assert.equal(me.data.message, text)
  for (const [method, path] of [['GET', '/products'], ['POST', '/sales']]) {
    const r = await t.req(method, path, { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal(r.data.message, text)
  }
  // И войти заново без интернета нельзя — с объяснением, а не «неверный пароль»
  t.gw.logout()
  const again = await t.login()
  assert.equal(again.status, 401)
  assert.equal(again.data.message, text)
})

test('сервер приостановил аптеку — без интернета она тоже не работает', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.pharmacy.status = 'suspended'
  // Сервер отказывает на любой запрос — программа это запоминает
  assert.equal((await t.req('GET', '/auth/me')).status, 403)
  t.srv.state.online = false
  const r = await t.req('GET', '/products')
  assert.equal(r.status, 403)
  assert.equal(r.data.message, MESSAGES.suspended)

  // Работу вернули: первый же ответ сервера снимает запрет
  t.srv.state.online = true
  t.srv.state.pharmacy.status = 'active'
  assert.equal((await t.req('GET', '/auth/me')).status, 200)
  assert.equal((await t.req('GET', '/products')).status, 200)
})

test('сервер отозвал ключ — человек перестаёт быть «за кассой»; закрытая учётная запись теряет и вход без связи', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Просто вышел срок ключа: пароль прежний, вход без интернета остаётся
  t.srv.state.tokens.clear()
  const me = await t.req('GET', '/auth/me')
  assert.equal(me.status, 401)
  assert.equal(t.session.has(), false)
  assert.equal(t.session.tokenOf('acc-kassir'), '')
  assert.ok(accountByLogin(t.core, 'kassir').verifier)

  // Учётную запись закрыли: сервер отвечает другим отказом — и вход без интернета отзывается
  assert.equal((await t.login()).status, 201)
  t.srv.state.users.get('kassir').active = false
  assert.equal((await t.req('GET', '/auth/me')).status, 401)
  assert.equal(accountByLogin(t.core, 'kassir').verifier, null)
})

test('ключ отозван, пока программа сама обменивалась с сервером, — окно узнаёт об этом на следующем запросе', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.tokens.clear()
  await t.gw.syncNow()
  assert.equal(t.session.has(), false)
  const r = await t.req('GET', '/products')
  assert.equal(r.status, 401, 'окно продолжило бы работать под отозванным входом')
})

// ── Разделы, которым нужен сервер ──

test('раздел «только с интернетом» без связи отвечает объяснением, а не общим «проверьте интернет»', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  assert.equal((await t.req('GET', '/users')).status, 200)
  t.srv.state.online = false
  for (const [method, path] of [['GET', '/users'], ['POST', '/products'], ['GET', '/inventory'], ['POST', '/auth/change-password']]) {
    const r = await t.req(method, path, {})
    assert.equal(r.status, 0, `${method} ${path}`)
    assert.equal(r.data.message, MESSAGES.onlineOnly)
  }
})

test('запись на сервере сразу видна в локальной базе — товар не пропадает с экрана', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const created = await t.req('POST', '/products', { name: 'Анальгин', barcode: '4600000000024', price: 30, cost: 20, stock: 4 })
  assert.equal(created.status, 201)
  // Окно сразу перечитывает список — и обязано найти в нём новый товар
  const list = await t.req('GET', '/products')
  // (по алфавиту: касса расставляет товары сама)
  assert.deepEqual(list.data.map((p) => p.name), ['Анальгин', 'Нурофен', 'Парацетамол'])
  // И продать его можно тут же
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: created.data.id, qty: 1 }] })
  assert.equal(sale.status, 201)
})

test('приход, оформленный без связи, нельзя править «на сервере» — он туда ещё не ушёл', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const arrival = await t.req('POST', '/arrivals', { items: [{ productId: 'nur', qty: 1, cost: 90, expiryDate: '2028-01-01' }] })
  t.srv.reset()
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const r = await t.req(method, '/arrivals/' + arrival.data.id, { items: [] })
    assert.equal(r.status, 409, method)
    assert.equal(r.data.message, MESSAGES.notSent)
  }
  const pending = await t.req('POST', '/customers', { name: 'Новый' })
  assert.equal((await t.req('DELETE', '/customers/' + pending.data.id)).status, 409)
  assert.equal(t.srv.state.calls.length, 0)
  // Запись, которую сервер знает, уходит к нему как обычно
  assert.equal((await t.req('DELETE', '/arrivals/server-1')).status, 200)
})

test('кассир: журнал списаний и списание закрыты, как на сервере', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  for (const [method, path] of [['GET', '/writeoffs?days=180'], ['POST', '/writeoffs']]) {
    const r = await t.req(method, path, { items: [{ productId: 'nur', units: 1 }] })
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal(r.data.message, 'Недостаточно прав')
  }
  // И программа сама не спрашивает у сервера то, что кассиру не положено
  assert.equal(t.srv.count('GET', '/writeoffs'), 0)
  // Всё остальное кассиру доступно
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })).status, 201)
})

test('отчёт за давний период: с интернетом — с сервера плюс своё неотправленное; без него — честное «нет связи»', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const mine = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const old = { id: 'old-1', date: '2026-01-15T10:00:00.000Z', total: 1, cost: 0, profit: 1, payment: 'cash', items: [], customer: null, user: null }
  t.srv.state.data.sales = [old]

  const from = encodeURIComponent('2026-01-01T00:00:00.000Z')
  const deep = await t.req('GET', `/sales?from=${from}`)
  assert.equal(deep.status, 200)
  assert.deepEqual(deep.data.map((s) => s.id), [mine.data.id, 'old-1'], 'чек, которого сервер ещё не видел, выпал из отчёта')
  for (const path of ['/sales?days=0', '/sales?days=365']) {
    assert.deepEqual((await t.req('GET', path)).data.map((s) => s.id), [mine.data.id, 'old-1'], path)
  }

  t.srv.state.online = false
  assert.equal((await t.req('GET', `/sales?from=${from}`)).status, 0)
  // А недавнее — по-прежнему из локальной базы
  assert.equal((await t.req('GET', '/sales?days=60')).status, 200)
})

test('возврат по давнему чеку, которого на кассе нет: касса берёт чек с сервера и оформляет возврат у себя, в своей смене', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Чеку полгода: в журнале кассы его нет, а на сервере он есть — с одним прежним возвратом
  const old = {
    id: 'chek-polgoda-nazad', clientId: null, date: '2026-04-01T09:00:00.000Z', total: 450, cost: 300, profit: 150, payment: 'cash',
    customerId: null, shiftId: null, userId: 'u1', user: { id: 'u1', name: 'kassir' }, customer: null,
    items: [{ id: 'si1', saleId: 'chek-polgoda-nazad', productId: 'nur', name: 'Нурофен', qty: 3, pieces: 0, unitsPerPack: 1, price: 150, cost: 100, discount: 0 }],
  }
  t.srv.state.oldSales.set(old.id, old)
  t.srv.put('returns', {
    id: 'r-prezhnij', date: '2026-04-02T09:00:00.000Z', saleId: old.id, total: 150, refund: 'cash', note: '', user: null,
    items: [{ id: 'ri1', returnId: 'r-prezhnij', productId: 'nur', name: 'Нурофен', units: 1, unitsPerPack: 1, price: 150, cost: 100, amount: 150, restock: true }],
  })
  await t.gw.syncNow()

  const shift = await t.req('POST', '/shifts/open', { openingCash: 100 })
  t.srv.reset()
  const body = { saleId: old.id, items: [{ productId: 'nur', units: 1 }] }
  const r = await t.req('POST', '/returns', body)
  assert.equal(r.status, 201)
  assert.equal(r.data.saleId, old.id)
  assert.equal(r.data.total, 150, 'сумма возврата — по цене из чека')
  assert.equal(r.data.shiftId, shift.data.id, 'возврат лёг в смену ЭТОЙ кассы: деньги выданы из её ящика')
  assert.equal(t.srv.count('POST', '/returns'), 0, 'возврат оформляет касса, а не сервер от её имени')
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 6, 'товар вернулся на полку')
  // И уходит на сервер обычной операцией
  await t.gw.syncNow()
  const sent = t.srv.state.received.find((o) => o.type === 'return')
  assert.equal(sent.payload.ret.saleId, old.id)
  assert.equal(sent.payload.ret.shiftId, shift.data.id)

  // Прежний возврат учтён: продано три, одну вернули раньше, одну сейчас — осталась одна
  const over = await t.req('POST', '/returns', { saleId: old.id, items: [{ productId: 'nur', units: 2 }] })
  assert.equal(over.status, 400)
  assert.match(over.data.message, /уже возвращено 2 из 3/)

  // Чека с таким номером нет и на сервере
  const none = await t.req('POST', '/returns', { saleId: 'net-takogo', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(none.status, 400)
  assert.match(none.data.message, /Чек не найден/)

  t.srv.state.online = false
  const off = await t.req('POST', '/returns', { saleId: 'drugoj-davnij', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(off.status, 0)
  assert.equal(off.data.message, MESSAGES.oldSale)
  // А возврат по чеку, который касса помнит, без интернета проходит как обычно
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal((await t.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: 'nur', units: 1 }] })).status, 201)
})

// ── Смена пароля ──

test('смена пароля: новый ключ спрятан, вход без интернета — уже по новому паролю', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const old = t.session.get()
  const r = await t.req('POST', '/auth/change-password', { oldPassword: PASS, newPassword: 'novyj-parol-9' })
  assert.equal(r.status, 201)
  assert.equal(r.data.token, DESKTOP_TOKEN)
  assert.notEqual(t.session.get(), old)
  assert.equal(JSON.stringify(r).includes('ключ-kassir'), false)

  t.gw.logout()
  t.srv.state.online = false
  assert.equal((await t.login()).status, 401, 'старый пароль продолжил работать без интернета')
  assert.equal((await t.login('kassir', 'novyj-parol-9')).status, 201)
})

// ── События ──

test('сервер сообщил об изменении — локальная база забирает его и говорит окну', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  assert.deepEqual(t.events, [{ type: 'connect', payload: undefined }], 'локальная база на связи всегда — окно узнаёт об этом сразу')
  t.events.length = 0

  // На другой кассе продали упаковку
  t.srv.put('products', { ...t.srv.state.data.products.find((p) => p.id === 'nur'), stock: 4 })
  t.gw.serverEvent('changed', ['products', 'sales'])
  await [...t.timers.pending].find((x) => x.ms === 1000).fn()
  await t.gw.syncNow()
  const changes = () => t.events.filter((e) => e.type !== 'status')
  assert.deepEqual(changes(), [{ type: 'changed', payload: ['products'] }], 'окну сообщается только то, что на самом деле изменилось')
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 4)

  // Окно перестало слушать (вышли) — событий больше нет
  t.gw.listen(false)
  assert.equal(t.events.at(-1).type, 'disconnect')
  t.events.length = 0
  t.srv.remove('products', 'par')
  await t.gw.syncNow()
  assert.deepEqual(t.events, [])
  assert.equal((await t.req('GET', '/products')).data.length, 1, 'удалённый на сервере товар должен исчезнуть и здесь')
})

test('разделы, которых касса у себя не держит, окно узнаёт сразу — ему спрашивать их у сервера', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.events.length = 0
  // Сотрудники и расхождения в локальной базе не лежат: ждать обмена незачем.
  // А про товары окно узнает только после обмена — раньше в базе нового нет
  t.gw.serverEvent('changed', ['products', 'users', 'discrepancies'])
  assert.deepEqual(t.events.filter((e) => e.type !== 'status'), [{ type: 'changed', payload: ['users', 'discrepancies'] }])
  t.events.length = 0
  t.gw.serverEvent('changed', ['sales', 'products'])
  t.gw.serverEvent('changed', 'discrepancies')
  assert.deepEqual(t.events.filter((e) => e.type !== 'status'), [{ type: 'changed', payload: ['discrepancies'] }])
})

test('события подписки доходят до окна, а приостановка запоминается', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.events.length = 0
  t.gw.serverEvent('subscription', { note: 'Подписка продлена' })
  t.gw.serverEvent('suspended', { message: 'Работа приостановлена' })
  assert.deepEqual(t.events.filter((e) => e.type !== 'status').map((e) => e.type), ['subscription', 'suspended'])
  t.srv.state.online = false
  assert.equal((await t.req('GET', '/products')).status, 403)
})

// ── Отправка на сервер ──

// Сработать отложенному обмену (он ставится после каждой записи) и дождаться его
async function settle(t) {
  for (const timer of [...t.timers.pending].filter((x) => x.ms === 1000)) {
    t.timers.pending.delete(timer)
    await timer.fn()
  }
  await t.gw.syncNow()
}
const local = (t, sql, ...args) => t.gw.pharmacyDb().prepare(sql).all(...args)
const sell = (t, qty = 1, extra = {}) => t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty }], ...extra })

test('чек уходит на сервер сам: один раз, с номером кассы и автором', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const sale = await sell(t, 2)
  assert.equal(local(t, "SELECT sync FROM docs WHERE kind = 'sale'")[0].sync, 'pending', 'до ответа сервера чек «ждёт отправки»')
  assert.equal(t.gw.status().pending, 1)
  await settle(t)

  const got = t.srv.state.received.filter((o) => o.type === 'sale')
  assert.equal(got.length, 1)
  assert.equal(got[0].payload.sale.id, sale.data.id, 'номер чека на сервере — тот же, что на кассе')
  assert.equal(got[0].accountId, 'acc-kassir')
  assert.equal(got[0].deviceId, t.gw.deviceId)
  assert.match(got[0].id, /^[0-9a-f]{8}-/, 'у операции свой номер — по нему сервер узнаёт повтор')

  // Сервер принял: очередь пуста, чек больше не «ждёт», остаток не задвоился
  assert.equal(t.gw.status().pending, 0)
  assert.deepEqual(local(t, 'SELECT state FROM outbox'), [{ state: 'done' }])
  assert.equal(local(t, "SELECT sync FROM docs WHERE kind = 'sale'")[0].sync, 'synced')
  assert.equal(local(t, 'SELECT COUNT(*) AS n FROM stock_moves WHERE synced = 0')[0].n, 0)
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3, 'проданное вычтено дважды или не вычтено вовсе')
  // Чек в журнале — уже серверная копия, и он один
  const sales = (await t.req('GET', '/sales?days=60')).data
  assert.equal(sales.length, 1)
  assert.equal(sales[0].server, true)

  // Повторные обмены ничего не отправляют заново
  await t.gw.syncNow()
  await t.gw.syncNow()
  assert.equal(t.srv.state.received.length, 1)
})

test('накопленное без интернета уходит по порядку, когда связь вернулась', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.online = false
  await t.req('POST', '/shifts/open', { openingCash: 50 })
  const sale = await sell(t, 1)
  await t.req('POST', '/customers', { name: 'Новый' })
  await t.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: 'nur', units: 1 }] })
  await sell(t, 2)
  await t.req('POST', '/shifts/close', { countedCash: 350 })
  await settle(t)
  assert.equal(t.gw.status().pending, 6)
  assert.equal(t.gw.status().online, false)
  assert.equal(t.srv.state.received.length, 0)

  // Связь вернулась — сервер сообщает о себе, и касса отправляет всё сама
  t.srv.state.online = true
  t.gw.serverEvent('connect')
  await t.gw.syncNow()
  assert.deepEqual(
    t.srv.state.received.map((o) => o.type),
    ['shift.open', 'sale', 'customer.create', 'return', 'sale', 'shift.close'],
    'возврат не может уйти раньше чека, закрытие смены — раньше её чеков',
  )
  assert.equal(t.gw.status().pending, 0)
  assert.equal(t.gw.status().online, true)
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE sync <> 'synced'")[0].n, 0)
  // 5 было − 1 + 1 (возврат) − 2 = 3. Заглушка сервера возврат на полку не кладёт,
  // поэтому у неё 2 — и касса показывает то, что сказал сервер, а не своё
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 2)
})

test('обрыв связи посреди отправки: сервер принял, ответ не дошёл — повтор ничего не задваивает', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Сервер принимает пачку, но ответ теряется по дороге
  t.srv.state.loseResponse = (route) => route === '/sync/push'
  await sell(t, 2)
  await settle(t)
  assert.equal(t.srv.state.ops.size, 1, 'сервер операцию принял')
  assert.equal(t.gw.status().pending, 1, 'а касса об этом не знает')
  const pullsBefore = t.srv.count('GET', '/sync/pull')

  // Пока судьба операции неизвестна, свежие данные не спрашиваем: сервер прислал бы
  // остаток 3, касса вычла бы свои 2 ещё раз — и показала бы 1
  await t.gw.syncNow()
  assert.equal(t.srv.count('GET', '/sync/pull'), pullsBefore, 'касса спросила свежие данные, не выяснив судьбу отправленного')
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3)

  // Связь наладилась: та же операция уходит снова, сервер узнаёт её по номеру
  t.srv.state.loseResponse = null
  await t.gw.syncNow()
  assert.equal(t.srv.state.ops.size, 1, 'операция записана дважды')
  assert.equal(t.srv.state.data.sales.length, 1, 'чек задвоился')
  assert.equal(t.srv.state.data.products.find((p) => p.id === 'nur').stock, 3, 'товар списан дважды')
  assert.equal(t.gw.status().pending, 0)
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3)
  const ids = t.srv.state.received.map((o) => o.id)
  assert.equal(new Set(ids).size, 1, 'повтор должен идти с тем же номером операции')
  assert.ok(ids.length >= 2)
})

test('программу закрыли посреди отправки — после запуска она сначала выясняет судьбу отправленного', async (tt) => {
  const t = await loggedIn()
  t.srv.state.loseResponse = (route) => route === '/sync/push'
  await sell(t, 1)
  await settle(t)
  t.gw.close()

  t.srv.state.loseResponse = null
  t.srv.reset()
  const again = createGateway({
    apiUrl: API,
    fetchImpl: t.srv.fetchImpl,
    session: t.session,
    core: t.core,
    cipher: fakeSeal,
    clock: { now: () => t.time.now, serverTime: () => {} },
    dataDir: t.dataDir,
    timers: t.timers,
  })
  tt.after(() => again.close())
  again.resume()
  await again.syncNow()
  const order = t.srv.state.calls.filter((c) => c.route.startsWith('/sync/')).map((c) => c.route)
  assert.equal(order[0], '/sync/push', 'после перезапуска касса сначала спросила свежие данные')
  assert.ok(order.includes('/sync/pull'))
  assert.equal(t.srv.state.data.sales.length, 1)
  assert.equal(again.status().pending, 0)
  assert.equal((await again.request({ method: 'GET', path: '/products' })).data.find((p) => p.id === 'nur').stock, 4)
})

test('сервер отверг операцию: товар возвращается на полку, а владелец видит, что не принято', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.rejectIf = (op) => (op.type === 'sale' ? 'Суммы чека не сходятся с его позициями' : null)
  const sale = await sell(t, 2)
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3)
  await settle(t)

  const st = t.gw.status()
  assert.equal(st.pending, 0, 'отвергнутое не шлётся по кругу')
  assert.equal(st.rejected, 1)
  assert.equal(local(t, 'SELECT error FROM outbox')[0].error, 'Суммы чека не сходятся с его позициями')
  assert.equal(local(t, 'SELECT sync FROM docs WHERE id = ?', sale.data.id)[0].sync, 'rejected')
  // Сервер продажу не учёл — и касса больше не вычитает её из остатка
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 5)
  // Повторные обмены отвергнутое не трогают
  const n = t.srv.state.received.length
  await t.gw.syncNow()
  assert.equal(t.srv.state.received.length, n)
})

test('сервер не смог записать операцию — она остаётся в очереди и уходит позже', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.retryIf = () => true
  await sell(t, 1)
  await settle(t)
  assert.equal(t.gw.status().pending, 1)
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 4)
  t.srv.state.retryIf = null
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  assert.equal(t.srv.state.data.sales.length, 1)
})

test('кассир ушёл, его вход отозван — его чеки уходят ключом владельца и остаются за ним', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.addUser('vladelec', 'vladelec-parol-1', 'founder')
  // Кассир продал без интернета и вышел
  t.srv.state.online = false
  await sell(t, 1)
  t.gw.logout()

  // Пока его не было, пароль сменили: его ключ больше не действует
  t.srv.state.online = true
  t.srv.state.tokens.clear()
  // Владелец входит на этом же компьютере
  assert.equal((await t.login('vladelec', 'vladelec-parol-1')).status, 201)
  await t.gw.syncNow()
  await t.gw.syncNow()

  const ok = t.srv.state.received.filter((o) => o.type === 'sale' && t.srv.state.ops.get(o.id)?.status === 'ok')
  assert.equal(ok.length, 1, 'чек кассира так и не ушёл')
  assert.equal(ok[0].by, 'vladelec', 'отправлен ключом владельца')
  assert.equal(ok[0].accountId, 'acc-kassir', 'но записан на кассира, который его пробил')
  assert.equal(t.gw.status().pending, 0)
  assert.equal(t.session.tokenOf('acc-kassir'), '', 'отозванный ключ кассира стёрт')
  assert.equal(t.session.activeId(), 'acc-vladelec', 'владельца при этом из программы не выкинуло')
})

test('владелец после кассира получает журнал списаний целиком', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.addUser('vladelec', 'vladelec-parol-1', 'founder')
  t.srv.put('writeoffs', { id: 'w-old', date: '2026-10-01T00:00:00.000Z', reason: 'expired', note: '', totalCost: 5, source: 'manual', items: [], user: null })
  await t.gw.syncNow()
  // Кассиру сервер списания не отдаёт — и касса их не хранит
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'writeoff'")[0].n, 0)

  t.gw.logout()
  assert.equal((await t.login('vladelec', 'vladelec-parol-1')).status, 201)
  await t.gw.syncNow()
  const list = await t.req('GET', '/writeoffs?days=180')
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.map((w) => w.id), ['w-old'], 'списания, сделанные до входа владельца, потерялись')
  // Полный обмен нужен один раз, дальше — снова только изменения
  t.srv.reset()
  await t.gw.syncNow()
  assert.match(t.srv.state.calls.find((c) => c.route === '/sync/pull').path, /cursor=\d+/)
})

test('списания, сделанные, пока за кассой работал кассир, владелец получает при входе — без полной загрузки', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.addUser('smena', 'smena-parol-1', 'cashier')
  const wo = (id) => ({ id, date: '2026-10-04T09:00:00.000Z', reason: 'expired', note: '', totalCost: 5, source: 'manual', items: [], user: null })
  t.srv.put('writeoffs', wo('w-1'))
  await t.gw.syncNow()
  const seen = async () => (await t.req('GET', '/writeoffs?days=180')).data.map((w) => w.id).sort()
  assert.deepEqual(await seen(), ['w-1'])

  // Владельца сменил кассир. Пока он работает, на сайте оформили ещё одно списание
  // и удалили прежнее; касса при этом обменивается с сервером как обычно
  t.gw.logout()
  assert.equal((await t.login('smena', 'smena-parol-1')).status, 201)
  t.srv.put('writeoffs', wo('w-2'))
  t.srv.remove('writeoffs', 'w-1')
  t.srv.put('products', { ...t.srv.state.data.products.find((p) => p.id === 'nur'), stock: 4 })
  await t.gw.syncNow()
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'writeoff' AND id = 'w-2'")[0].n, 0, 'кассиру сервер списания не отдаёт')

  // Владелец вернулся: пропущенное приходит ему частичным обменом
  t.gw.logout()
  assert.equal((await t.login()).status, 201)
  t.srv.reset()
  await t.gw.syncNow()
  const pull = t.srv.state.calls.find((c) => c.route === '/sync/pull').path
  assert.match(pull, /[?&]cursor=\d+/, 'владельцу незачем грузить всю аптеку заново')
  assert.match(pull, /[?&]wcursor=\d+/)
  assert.deepEqual(await seen(), ['w-2'], 'списание, оформленное при кассире, до владельца не дошло (или удалённое осталось)')
})

test('обмен сообщает, под каким номером записывать документы сотрудника, и проверяет подписку', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const sale = await sell(t, 1)
  assert.equal(sale.data.userId, 'tenant-kassir', 'номер сотрудника в базе аптеки сообщил сервер')

  // Подписку продлили — касса узнаёт об этом при первом же обмене, без «кто я»
  t.srv.state.pharmacy.paidUntil = '2027-01-01T00:00:00.000Z'
  await t.gw.syncNow()
  t.srv.state.online = false
  assert.equal((await t.req('GET', '/auth/me')).data.subscription.paidUntil, '2027-01-01T00:00:00.000Z')
})

test('окно узнаёт о состоянии обмена: сколько ждёт, есть ли связь', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.events.length = 0
  t.srv.state.online = false
  await sell(t, 1)
  const last = () => t.events.filter((e) => e.type === 'status').at(-1)?.payload
  assert.equal(last().pending, 1, 'кассир должен видеть, что чек сохранён и ждёт отправки')
  await settle(t)
  assert.equal(last().online, false)
  assert.equal(last().pending, 1)

  t.srv.state.online = true
  await t.gw.syncNow()
  assert.equal(last().online, true)
  assert.equal(t.gw.status().pending, 0)
  assert.ok(t.gw.status().syncedAt)
})

// ── Граница ──

test('недопустимая просьба окна не выполняется ни локально, ни на сервере', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.reset()
  for (const path of ['https://evil.example/x', '/../admin', '//evil.example']) {
    assert.equal((await t.req('GET', path)).status, 400, path)
  }
  assert.equal((await t.req('PUT', '/products')).status, 400)
  assert.equal(t.srv.state.calls.length, 0)
})

test('аптеки не смешиваются: у каждой свой файл базы', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.deepEqual(fs.readdirSync(t.dataDir).filter((f) => f.endsWith('.db')), ['pharmacy-apteka-1.db'])

  // На том же компьютере вошёл сотрудник другой аптеки
  t.gw.logout()
  t.srv.state.pharmacy = { code: 'apteka-2', name: 'Вторая', paidUntil: '2026-12-01T00:00:00.000Z', status: 'active' }
  t.srv.addUser('drugoj', 'drugoj-parol-1')
  t.srv.state.data.products = [product({ id: 'x', name: 'Чужой товар' })]
  t.srv.state.data.sales = []
  assert.equal((await t.login('drugoj', 'drugoj-parol-1')).status, 201)
  await t.gw.syncNow()
  assert.deepEqual((await t.req('GET', '/products')).data.map((p) => p.name), ['Чужой товар'])
  assert.deepEqual((await t.req('GET', '/sales?days=60')).data, [], 'чек первой аптеки виден во второй')
  assert.deepEqual(fs.readdirSync(t.dataDir).filter((f) => f.endsWith('.db')).sort(), ['pharmacy-apteka-1.db', 'pharmacy-apteka-2.db'])
})

// ── Расходы аптеки ──

test('расход из кассы, внесённый без связи: сразу уменьшает наличные в смене, доходит до сервера и не считается дважды', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const shift = await t.req('POST', '/shifts/open', { openingCash: 100 })
  await t.gw.syncNow()
  const cashOut = async () => (await t.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id).expenseCash

  // Интернета нет. Статьи расходов и касса, из которой берут деньги, — из локальной базы
  t.srv.state.online = false
  t.srv.reset()
  assert.deepEqual((await t.req('GET', '/expense-categories')).data.map((c) => c.name), ['Аренда', 'Другое', 'Зарплата', 'Налоги', 'Транспорт'])
  assert.deepEqual((await t.req('GET', '/expenses/cash-sources')).data.map((s) => s.shiftId), [shift.data.id])
  const taxi = await t.req('POST', '/expenses', { category: 'Транспорт', amount: 40, note: 'такси', fromCash: true, shiftId: shift.data.id, clientId: 'exp_1' })
  assert.equal(taxi.status, 201)
  assert.equal(taxi.data.shiftId, shift.data.id)
  const rent = await t.req('POST', '/expenses', { category: 'Аренда', amount: 1500, date: '2026-10-01' })
  assert.equal(rent.data.date, '2026-10-01T07:00:00.000Z')
  assert.equal(await cashOut(), 40, 'расход из кассы не уменьшил наличные, которые ждут в смене')
  assert.deepEqual((await t.req('GET', '/expenses?days=180')).data.map((e) => e.id), [taxi.data.id, rent.data.id])
  await settle(t)
  assert.equal(t.gw.status().pending, 2)
  assert.equal(t.srv.state.received.filter((o) => o.type === 'expense').length, 0)

  // Связь вернулась: расходы уходят сами, по одному разу
  t.srv.state.online = true
  await t.gw.syncNow()
  const sent = t.srv.state.received.filter((o) => o.type === 'expense')
  assert.deepEqual(sent.map((o) => o.payload.expense.id), [taxi.data.id, rent.data.id])
  assert.deepEqual(sent[0].payload.expense, { id: taxi.data.id, date: taxi.data.date, category: 'Транспорт', amount: 40, note: 'такси', fromCash: true, shiftId: shift.data.id })
  assert.equal(sent[0].accountId, 'acc-kassir')
  assert.equal(t.gw.status().pending, 0)
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense' AND sync <> 'synced'")[0].n, 0)
  // Сервер посчитал расход в смене — и у кассы та же сумма, а не двойная
  assert.equal(t.srv.state.data.shifts.find((s) => s.id === shift.data.id).expenseCash, 40)
  assert.equal(await cashOut(), 40, 'принятый расход посчитан дважды или потерян')

  // При закрытии смена сходится: 100 на начало − 40 на такси
  const closed = await t.req('POST', '/shifts/close', { countedCash: 60 })
  assert.deepEqual([closed.data.expenseCash, closed.data.expectedCash, closed.data.difference], [40, 60, 0])
})

test('сервер принял расход из кассы, а связь тут же оборвалась: сумма в смене остаётся верной', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const shift = await t.req('POST', '/shifts/open', { openingCash: 100 })
  await t.gw.syncNow()
  const cashOut = async () => (await t.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id).expenseCash

  // Отправка прошла, а ответ на «что изменилось» уже не дошёл
  t.srv.state.override = (method, route) => (route === '/sync/pull' ? { throw: true } : null)
  await t.req('POST', '/expenses', { category: 'Транспорт', amount: 40, fromCash: true })
  await settle(t)
  assert.equal(t.srv.state.received.filter((o) => o.type === 'expense').length, 1)
  assert.equal(local(t, "SELECT sync FROM docs WHERE kind = 'expense'")[0].sync, 'synced')
  assert.equal(await cashOut(), 40, 'расход принят сервером, а из смены пропал')

  // Связь вернулась — свежая смена с сервера ничего не меняет
  t.srv.state.override = null
  await t.gw.syncNow()
  assert.equal(await cashOut(), 40)
})

test('править и удалять расход умеет только сервер: неотправленный — нельзя, без связи — честное объяснение, со связью — сразу видно здесь', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const list = async () => (await t.req('GET', '/expenses?days=180')).data.map((e) => [e.category, e.amount])

  // Внесён без связи и на сервер ещё не ушёл — править там нечего
  t.srv.state.online = false
  const e = await t.req('POST', '/expenses', { category: 'Аренда', amount: 100 })
  t.srv.reset()
  for (const method of ['PATCH', 'DELETE']) {
    const r = await t.req(method, '/expenses/' + e.data.id, { amount: 5 })
    assert.equal(r.status, 409, method)
    assert.equal(r.data.message, MESSAGES.notSent)
  }
  assert.equal(t.srv.state.calls.length, 0)

  // Ушёл на сервер — правка идёт через него и сразу видна в локальной базе
  t.srv.state.online = true
  await t.gw.syncNow()
  const patched = await t.req('PATCH', '/expenses/' + e.data.id, { amount: 120, category: 'Налоги' })
  assert.equal(patched.status, 200)
  assert.deepEqual(await list(), [['Налоги', 120]])

  // Без связи — объяснение про расходы, а не общее «раздел работает только с интернетом»:
  // вносить-то расход можно и без неё
  t.srv.state.online = false
  for (const method of ['PATCH', 'DELETE']) {
    const r = await t.req(method, '/expenses/' + e.data.id, { amount: 1 })
    assert.equal(r.status, 0, method)
    assert.equal(r.data.message, MESSAGES.expenseOnline)
  }
  for (const [method, path] of [['POST', '/expense-categories'], ['DELETE', '/expense-categories/expcat-1']]) {
    const r = await t.req(method, path, { name: 'Охрана' })
    assert.equal(r.status, 0, `${method} ${path}`)
    assert.equal(r.data.message, MESSAGES.expenseCatsOnline)
  }
  assert.deepEqual(await list(), [['Налоги', 120]], 'без связи ничего не изменилось')

  // Статьи меняет сервер — и касса тут же знает новую: по ней можно внести расход без связи
  t.srv.state.online = true
  const cat = await t.req('POST', '/expense-categories', { name: 'Охрана' })
  assert.equal(cat.status, 201)
  assert.ok((await t.req('GET', '/expense-categories')).data.some((c) => c.name === 'Охрана'))
  t.srv.state.online = false
  assert.equal((await t.req('POST', '/expenses', { category: 'Охрана', amount: 30 })).status, 201)
  t.srv.state.online = true
  await t.gw.syncNow()
  assert.equal((await t.req('DELETE', '/expense-categories/' + cat.data.id)).status, 200)
  assert.ok(!(await t.req('GET', '/expense-categories')).data.some((c) => c.name === 'Охрана'))
  // Убранная статья остаётся в прежнем расходе, а новый по ней уже не внести
  assert.deepEqual((await list()).map((x) => x[0]).sort(), ['Налоги', 'Охрана'])
  assert.equal((await t.req('POST', '/expenses', { category: 'Охрана', amount: 30 })).status, 400)

  // Удаление — тоже через сервер, и из локальной базы расход уходит сразу
  assert.equal((await t.req('DELETE', '/expenses/' + e.data.id)).status, 200)
  assert.deepEqual((await list()).map((x) => x[0]), ['Охрана'])
})

test('расход из кассы поправили и удалили через сервер: наличные в смене идут следом', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const shift = await t.req('POST', '/shifts/open', { openingCash: 100 })
  const e = await t.req('POST', '/expenses', { category: 'Транспорт', amount: 40, fromCash: true })
  await t.gw.syncNow()
  const cashOut = async () => (await t.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id).expenseCash
  assert.equal(await cashOut(), 40)
  assert.equal((await t.req('PATCH', '/expenses/' + e.data.id, { amount: 25 })).status, 200)
  assert.equal(await cashOut(), 25)
  assert.equal((await t.req('DELETE', '/expenses/' + e.data.id)).status, 200)
  assert.equal(await cashOut(), 0)
})

test('кассир: расходы закрыты, как на сервере, — ни прочитать, ни внести; а сумму «из кассы» в своей смене он видит', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  for (const [method, path] of [['GET', '/expenses?days=180'], ['GET', '/expenses/cash-sources'], ['GET', '/expense-categories'], ['POST', '/expenses']]) {
    const r = await t.req(method, path, { category: 'Аренда', amount: 10 })
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal(r.data.message, 'Недостаточно прав')
  }
  // Кассиру сервер расходы и статьи не отдаёт — касса их и не хранит
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense'")[0].n, 0)
  assert.equal(local(t, 'SELECT COUNT(*) AS n FROM expense_categories')[0].n, 0)

  // Владелец на сайте взял из ящика этой кассы 25 — кассир видит это в своей смене
  const shift = await t.req('POST', '/shifts/open', { openingCash: 200 })
  await t.gw.syncNow()
  t.srv.put('expenses', { id: 'e-site', date: '2026-10-04T09:00:00.000Z', category: 'Другое', amount: 25, note: '', fromCash: true, shiftId: shift.data.id, user: null })
  t.srv.put('shifts', { ...t.srv.state.data.shifts.find((s) => s.id === shift.data.id), expenseCash: 25 })
  await t.gw.syncNow()
  assert.equal((await t.req('GET', '/shifts')).data[0].expenseCash, 25)
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense'")[0].n, 0)
  const closed = await t.req('POST', '/shifts/close', { countedCash: 175 })
  assert.deepEqual([closed.data.expenseCash, closed.data.expectedCash, closed.data.difference], [25, 175, 0])
})

test('расходы, внесённые, пока за кассой работал кассир, владелец получает при входе — без полной загрузки', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.addUser('smena', 'smena-parol-1', 'cashier')
  const exp = (id, amount) => ({ id, date: '2026-10-04T09:00:00.000Z', category: 'Аренда', amount, note: '', fromCash: false, shiftId: null, user: null })
  t.srv.put('expenses', exp('e-1', 10))
  await t.gw.syncNow()
  const seen = async () => (await t.req('GET', '/expenses?days=180')).data.map((e) => e.id).sort()
  assert.deepEqual(await seen(), ['e-1'])

  // Владельца сменил кассир. Пока он работает, на сайте внесли ещё расход, удалили
  // прежний и завели свою статью
  t.gw.logout()
  assert.equal((await t.login('smena', 'smena-parol-1')).status, 201)
  t.srv.put('expenses', exp('e-2', 20))
  t.srv.remove('expenses', 'e-1')
  t.srv.put('expenseCategories', { id: 'c-own', name: 'Охрана', createdAt: '2026-10-04T09:00:00.000Z' })
  await t.gw.syncNow()
  assert.equal(local(t, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense' AND id = 'e-2'")[0].n, 0, 'кассиру сервер расходы не отдаёт')

  // Владелец вернулся: пропущенное приходит ему частичным обменом
  t.gw.logout()
  assert.equal((await t.login()).status, 201)
  t.srv.reset()
  await t.gw.syncNow()
  const pull = t.srv.state.calls.find((c) => c.route === '/sync/pull').path
  assert.match(pull, /[?&]cursor=\d+/, 'владельцу незачем грузить всю аптеку заново')
  assert.match(pull, /[?&]wcursor=\d+/)
  assert.deepEqual(await seen(), ['e-2'], 'расход, внесённый при кассире, до владельца не дошёл (или удалённый остался)')
  assert.ok((await t.req('GET', '/expense-categories')).data.some((c) => c.name === 'Охрана'), 'статья, заведённая при кассире, не дошла')
})

test('сервер отверг расход: владелец видит его в списке «не принято» целиком', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Окно открыто и слушает события программы
  t.gw.listen(true)
  t.srv.state.rejectIf = (op) => (op.type === 'expense' ? 'Сумма расхода должна быть больше нуля' : null)
  const e = await t.req('POST', '/expenses', { category: 'Аренда', amount: 100, note: 'за октябрь', date: '2026-10-01' })
  await settle(t)
  assert.deepEqual((await t.req('GET', '/expenses?days=180')).data, [], 'отвергнутый расход в журнале и в отчётах не числится')
  const [bad] = t.gw.rejected()
  assert.equal(bad.type, 'expense')
  assert.equal(bad.error, 'Сумма расхода должна быть больше нуля')
  assert.deepEqual([bad.sum, bad.title, bad.detail], [100, 'Аренда', { category: 'Аренда', note: 'за октябрь', date: e.data.date, fromCash: false }])
  // Окно узнало, что расходы надо перечитать
  assert.ok(t.events.some((x) => x.type === 'changed' && [].concat(x.payload).includes('expenses')))
})

// ── Объяснения для человека переведены ──

test('у каждого объяснения программы есть таджикский перевод в интерфейсе', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const dict = fs.readFileSync(join(here, '..', '..', 'client', 'src', 'lib', 'i18n.js'), 'utf8')
  for (const [key, text] of Object.entries(MESSAGES)) {
    if (key === 'needLogin' || key === 'suspended') continue // тексты самого сервера, окно их не переводит
    assert.ok(dict.includes(`'${text}':`), `нет перевода для «${text}»`)
  }
})

// ── Срок работы без связи ──

const DAY_MS = 86400000
const stops = (t) => t.events.filter((e) => e.type === 'suspended' || e.type === 'resumed')

test('семь дней без связи касса работает, потом закрывается до проверки — и объясняет почему', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.srv.state.online = false

  t.time.now += 6 * DAY_MS
  assert.equal((await sell(t, 1)).status, 201, 'на шестой день без связи касса продаёт')
  t.gw.tick()
  const lic = t.gw.status().licence
  assert.deepEqual([lic.offlineDays, lic.expired, lic.warn], [7, false, true], 'за два дня до остановки касса предупреждает')
  assert.deepEqual(stops(t), [])

  // Срок вышел, пока программа просто стояла открытой
  t.time.now += DAY_MS + 1000
  t.gw.tick()
  assert.deepEqual(stops(t), [{ type: 'suspended', payload: { message: MESSAGES.offlineLimit, title: MESSAGES.offlineTitle } }])
  t.gw.tick()
  assert.equal(stops(t).length, 1, 'объявление показывается один раз, а не каждую минуту')

  const sale = await sell(t, 1)
  assert.deepEqual([sale.status, sale.data.message], [403, MESSAGES.offlineLimit])
  assert.equal((await t.req('GET', '/products')).status, 403, 'закрыта вся работа, а не только продажа — как при истёкшей подписке')
  assert.equal((await t.req('GET', '/auth/me')).status, 403)
  // Сделанное до остановки цело и ждёт отправки
  assert.equal(t.gw.status().pending, 1)

  // Выйти и войти без связи не получится: пароль верный, но нужна проверка
  t.gw.logout()
  const again = await t.login()
  assert.deepEqual([again.status, again.data.message], [401, MESSAGES.offlineLimit])
  assert.equal((await t.req('GET', '/products')).status, 401, 'отказ во входе не должен оставлять вход открытым')

  // Интернет появился: вход идёт через сервер — это и есть проверка
  t.srv.state.online = true
  assert.equal((await t.login()).status, 201)
  await settle(t)
  assert.equal(t.gw.status().pending, 0, 'чек шестого дня ушёл на сервер')
  assert.equal((await sell(t, 1)).status, 201)
  assert.equal(t.gw.status().licence.expired, false)
})

test('срок вышел при открытой кассе: связь вернулась — работа продолжается сама, без выхода и входа', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.srv.state.online = false
  t.time.now += 8 * DAY_MS
  t.gw.tick()
  assert.equal((await sell(t, 1)).status, 403)

  t.srv.state.online = true
  t.events.length = 0
  await t.gw.syncNow()
  assert.deepEqual(stops(t).map((e) => e.type), ['resumed'], 'объявление об остановке должно сняться само')
  assert.equal((await sell(t, 1)).status, 201)
})

test('сколько дней работать без связи, назначает сервер — и может передумать', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  t.srv.state.pharmacy.offlineDays = 14
  assert.equal((await t.login()).status, 201)
  await t.gw.syncNow()
  assert.equal(t.gw.status().licence.offlineDays, 14)

  t.srv.state.online = false
  t.time.now += 10 * DAY_MS
  assert.equal((await sell(t, 1)).status, 201, 'этой аптеке дано две недели')

  // Владелец сервиса сократил срок — касса узнаёт при первом же обмене
  t.srv.state.online = true
  t.srv.state.pharmacy.offlineDays = 2
  await t.gw.syncNow()
  assert.equal(t.gw.status().licence.offlineDays, 2)
  t.srv.state.online = false
  t.time.now += 2 * DAY_MS + 1000
  assert.equal((await sell(t, 1)).status, 403)
})

test('подписка закончилась раньше срока без связи — касса называет настоящую причину', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.srv.state.online = false
  // Оплачено до 1 ноября; прошло 30 дней без связи — вышло и то, и другое
  t.time.now += 30 * DAY_MS
  t.gw.tick()
  const sale = await sell(t, 1)
  assert.equal(sale.status, 403)
  assert.match(sale.data.message, /Подписка закончилась/)
  assert.deepEqual(stops(t), [], 'объявление про связь тут только запутало бы: дело в оплате')
})

test('постоянное соединение оборвалось — касса сразу выясняет, есть ли интернет, а не ждёт пяти минут', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  assert.equal(t.gw.status().online, true)
  t.srv.state.online = false
  t.gw.serverEvent('disconnect')
  const kicks = () => [...t.timers.pending].filter((x) => x.ms === 1000)
  assert.equal(kicks().length, 1, 'обрыв соединения должен назначить скорую сверку')
  await settle(t)
  assert.equal(t.gw.status().online, false, 'значок должен показать «нет интернета»')
  // Пока связи нет, соединение рвётся при каждой попытке восстановиться — это уже
  // не новость, и дёргать сервер на каждую незачем: дальше попытки идут с паузами
  t.gw.serverEvent('disconnect')
  t.gw.serverEvent('disconnect')
  assert.equal(kicks().length, 0)
})

// ── База аптеки не открывается ──

// Основная часть, у которой файл базы аптеки «занят другой программой», пока busy.on
function withBusyFile(t, busy) {
  return createGateway({
    apiUrl: API,
    fetchImpl: t.srv.fetchImpl,
    session: t.session,
    core: t.core,
    cipher: fakeSeal,
    clock: { now: () => t.time.now, serverTime: () => {} },
    dataDir: t.dataDir,
    timers: t.timers,
    log: { info() {}, warn() {}, error() {} },
    openFile: (file) => {
      if (busy.on) throw Object.assign(new Error(MESSAGES.dbBusy), { busy: true })
      return { db: openDb(file, PHARMACY_SCHEMA), restored: null }
    },
  })
}

test('файл базы аптеки занят: программа запускается, входа нет, человек видит объяснение — а потом входит', async (tt) => {
  const t = await loggedIn()
  t.gw.close()

  // «Перезапуск»: человек был за кассой, но базу его аптеки открыть не удаётся
  const busy = { on: true }
  const again = withBusyFile(t, busy)
  tt.after(() => again.close())
  assert.equal(again.resume(), false, 'запуск не должен сорваться — программа открывается на экране входа')
  assert.equal((await again.request({ method: 'GET', path: '/products' })).status, 401, 'без базы человек не «за кассой»')

  // Вход: пароль верный, но работать не с чем — так и говорим
  const refused = await again.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })
  assert.equal(refused.status, 500)
  assert.equal(refused.data.message, MESSAGES.dbBusy)
  assert.equal((await again.request({ method: 'GET', path: '/products' })).status, 401, 'несостоявшийся вход не оставляет человека «за кассой»')

  // Файл освободился — вход проходит, данные на месте
  busy.on = false
  const ok = await again.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })
  assert.equal(ok.status, 201)
  const products = await again.request({ method: 'GET', path: '/products' })
  assert.equal(products.status, 200)
  assert.equal(products.data.length, 2)
})

test('файл базы занят и интернета нет: вход паролем на месте тоже отвечает объяснением, а не «за кассой без базы»', async (tt) => {
  const t = await loggedIn()
  t.gw.close()
  t.srv.state.online = false
  const busy = { on: true }
  const again = withBusyFile(t, busy)
  tt.after(() => again.close())
  again.resume()

  const refused = await again.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })
  assert.equal(refused.status, 500)
  assert.equal(refused.data.message, MESSAGES.dbBusy)
  assert.equal((await again.request({ method: 'GET', path: '/products' })).status, 401)

  busy.on = false
  assert.equal((await again.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })).status, 201)
  assert.equal((await again.request({ method: 'GET', path: '/products' })).data.length, 2)
})

// ── Судьба отправленного ──

const revoke = (t, name) => {
  for (const [token, owner] of t.srv.state.tokens) if (owner === name) t.srv.state.tokens.delete(token)
}
const loginAs = (t, name, password) => t.req('POST', '/auth/login', { name, password })

test('ответ на чек потерялся, а кассиру сменили пароль: чек не считается дважды', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.addUser('smenshik', 'parol-2', 'cashier')
  await t.gw.syncNow()

  // Две упаковки в долг Ивану: остаток 5 → 3, долг 10 → 310. Сервер чек принял, а ответ потерялся
  t.srv.state.loseResponse = (route) => route === '/sync/push'
  assert.equal((await t.req('POST', '/sales', { payment: 'debt', customerId: 'ivan', items: [{ productId: 'nur', qty: 2 }] })).status, 201)
  await t.gw.syncNow()
  t.srv.state.loseResponse = null
  assert.equal(t.gw.status().pending, 1, 'ответа не было — чек по-прежнему в очереди')

  // Кассиру сменили пароль: его ключ больше не действует. За кассу встаёт сменщик
  t.srv.state.users.get('kassir').password = 'novyj-parol'
  revoke(t, 'kassir')
  t.gw.logout()
  assert.equal((await loginAs(t, 'smenshik', 'parol-2')).status, 201)
  await t.gw.syncNow()
  await t.gw.syncNow()

  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3, 'проданное вычтено дважды')
  assert.equal((await t.req('GET', '/customers')).data.find((c) => c.id === 'ivan').debt, 310, 'долг прибавлен дважды')
  assert.equal(t.gw.status().pending, 0, 'судьба чека выяснилась при обмене: сервер его принял')
  assert.equal(t.srv.state.data.sales.length, 1, 'и на сервере он один')
})

test('ключ автора отозван, владельца на кассе не было: обмен не замирает, а значок говорит как есть', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.addUser('smenshik', 'parol-2', 'cashier')
  t.gw.listen(true)
  await t.gw.syncNow()
  t.srv.state.loseResponse = (route) => route === '/sync/push'
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  await t.gw.syncNow()
  t.srv.state.loseResponse = null
  // Окно спросило «кто я» — сервер ответил отказом, ключ кассира выброшен
  revoke(t, 'kassir')
  assert.equal((await t.req('GET', '/auth/me')).status, 401)

  assert.equal((await loginAs(t, 'smenshik', 'parol-2')).status, 201)
  // Пока сменщик работает, владелец на сайте поднял цену
  t.srv.put('products', { ...t.srv.state.data.products.find((p) => p.id === 'par'), price: 250 })
  await t.gw.syncNow()
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'par').price, 250, 'изменения с сервера должны приходить')
  const st = t.gw.status()
  assert.equal(st.online, true, 'связь есть — значок не должен говорить «нет интернета»')
  assert.equal(st.pending, 0, 'а чек, как выяснилось, сервер принял')
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 4)
})

test('сотрудника удалили и завели заново под тем же именем: его прежние чеки не застревают навсегда', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.addUser('hozyain', 'parol-h', 'founder')
  await t.gw.syncNow()
  t.srv.state.online = false
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  t.gw.logout()

  // Владелец удалил сотрудника и завёл снова: имя то же, учётная запись новая
  revoke(t, 'kassir')
  t.srv.state.users.delete('kassir')
  t.srv.addUser('kassir', PASS, 'cashier', 'acc-kassir-novyj')
  t.srv.state.online = true
  t.srv.reset()
  assert.equal((await t.login()).status, 201)
  for (let i = 0; i < 4; i++) await t.gw.syncNow()

  // Прежний ключ сервер не принял — программа выбросила его и больше им не стучится
  assert.equal(t.srv.count('POST', '/sync/push'), 1, 'негодным ключом чек уходил бы при каждом обмене, вечно')
  const st = t.gw.status()
  assert.deepEqual([st.online, st.blocked, st.pending], [true, true, 1], 'чек ждёт владельца — и это видно')

  // Вошёл владелец — чек ушёл его ключом и остался за тем, кто его пробил
  t.gw.logout()
  assert.equal((await loginAs(t, 'hozyain', 'parol-h')).status, 201)
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  const got = t.srv.state.received.filter((o) => o.type === 'sale').at(-1)
  assert.deepEqual([got.by, got.accountId], ['hozyain', 'acc-kassir'])
})

test('обмен называет серверу ключ кассы — заголовком, а не в адресе', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  await t.gw.syncNow()
  const calls = t.srv.state.calls.filter((c) => c.route.startsWith('/sync/'))
  const keys = new Set(calls.map((c) => c.deviceKey))
  assert.equal(keys.size, 1, 'ключ один и тот же при отправке и получении')
  const [key] = keys
  assert.match(key, /^[A-Za-z0-9_-]{40,}$/)
  assert.ok(calls.every((c) => !c.path.includes(key)), 'в адресе запроса ключа быть не должно: адреса пишутся в журналы')
  // Остальным запросам ключ ни к чему
  await t.req('GET', '/users')
  assert.equal(t.srv.state.calls.find((c) => c.route === '/users').deviceKey, '')
  // И окну его не получить: запрос окна своих заголовков не несёт
  const sly = await t.gw.request({ method: 'GET', path: '/users', headers: { 'X-Device-Key': 'podlog' } })
  assert.equal(sly.status, 200)
  assert.equal(t.srv.state.calls.filter((c) => c.route === '/users').at(-1).deviceKey, '')
})

// ── Сервер отверг операцию: хвостов не остаётся ──

test('сервер отверг открытие смены: касса не остаётся с «открытой» сменой, которой на сервере нет', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.rejectIf = (op) => (op.type === 'shift.open' ? 'На этой кассе уже открыта другая смена' : null)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 100 })).status, 201)
  await t.gw.syncNow()
  assert.equal(t.gw.status().rejected, 1)
  // Окно берёт «открытую смену» из списка смен. Отвергнутой в нём быть не должно:
  // иначе на экране «смена открыта», закрыть её нельзя («нет открытой смены»), а
  // открыть новую — негде
  assert.deepEqual((await t.req('GET', '/shifts')).data.filter((s) => !s.closedAt), [])

  t.srv.state.rejectIf = null
  const again = await t.req('POST', '/shifts/open', { openingCash: 100 })
  assert.equal(again.status, 201, 'раньше касса отвечала «Смена уже открыта» — и так навсегда')
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.data.shiftId, again.data.id, 'чек идёт в новую смену, а не в отвергнутую')
})

test('сервер отверг клиента: у кассы его тоже больше нет; клиента без имени касса не заводит вовсе', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const blank = await t.req('POST', '/customers', { name: '   ' })
  assert.equal(blank.status, 400)
  assert.match(blank.data.message, /Укажите имя клиента/)

  t.srv.state.rejectIf = (op) => (op.type === 'customer.create' ? 'У клиента нет имени' : null)
  const made = await t.req('POST', '/customers', { name: 'Пётр', debt: 50 })
  assert.equal(made.status, 201)
  await t.gw.syncNow()
  const list = (await t.req('GET', '/customers')).data
  assert.equal(list.some((c) => c.id === made.data.id), false, 'отвергнутый клиент оставался бы у кассы навсегда: ни продать ему, ни удалить')
})

test('сервер отверг возврат: по чеку можно вернуть снова; по чеку, который сервер не принял, вернуть нельзя', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 2 }] })
  await t.gw.syncNow()

  t.srv.state.rejectIf = (op) => (op.type === 'return' ? 'Чек не найден' : null)
  assert.equal((await t.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: 'nur', units: 2 }] })).status, 201)
  await t.gw.syncNow()
  assert.equal((await t.req('GET', '/products')).data.find((p) => p.id === 'nur').stock, 3, 'отвергнутый возврат товар на полку не вернул')
  // И в журнале возвратов его нет: окно считает «уже возвращено» по этому списку
  assert.deepEqual((await t.req('GET', '/returns?days=180')).data, [])

  t.srv.state.rejectIf = null
  const again = await t.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: 'nur', units: 2 }] })
  assert.equal(again.status, 201, 'раньше касса отвечала «уже возвращено 2 из 2», хотя сервер не вернул ничего')

  // Чек, который сервер отверг
  t.srv.state.rejectIf = (op) => (op.type === 'sale' ? 'Суммы чека не сходятся с его позициями' : null)
  const bad = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'par', qty: 1 }] })
  await t.gw.syncNow()
  const ret = await t.req('POST', '/returns', { saleId: bad.data.id, items: [{ productId: 'par', units: 20 }] })
  assert.equal(ret.status, 400)
  assert.equal(ret.data.message, MESSAGES.rejectedSale)
})

test('сервер принял списание, но документа не завёл — в журнале кассы его тоже нет', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  // Остаток пересчитали раньше, чем списание дошло: списывать серверу нечего
  t.srv.state.noDoc = (op) => op.type === 'writeoff'
  const w = await t.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(w.status, 201)
  assert.equal((await t.req('GET', '/writeoffs')).data.length, 1, 'пока не отправлено — списание в журнале')
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  assert.deepEqual((await t.req('GET', '/writeoffs')).data, [], 'документа нет на сервере — не должно быть и здесь')
})

test('«загрузить всё заново», нажатое посреди обмена, всё равно загружает всё', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  await t.gw.syncNow()
  // Обмен идёт: получение задержано
  let release
  const gate = new Promise((r) => (release = r))
  t.srv.state.override = async (method, route) => {
    if (route === '/sync/pull') await gate
    return null
  }
  const running = t.gw.syncNow()
  await new Promise((r) => setTimeout(r, 20))
  t.srv.reset()
  const reload = t.gw.resync()
  t.srv.state.override = null
  release()
  await Promise.all([running, reload])
  const pulls = t.srv.state.calls.filter((c) => c.route === '/sync/pull')
  assert.ok(pulls.length >= 1)
  assert.equal(new URLSearchParams(pulls.at(-1).path.split('?')[1]).has('cursor'), false, 'идущий обмен вернул прежнюю отметку, и вместо всей аптеки пришли бы одни изменения')
  // Дальше — снова только изменения
  t.srv.reset()
  await t.gw.syncNow()
  assert.equal(new URLSearchParams(t.srv.state.calls.find((c) => c.route === '/sync/pull').path.split('?')[1]).has('cursor'), true)
})

// ── После отказа: касса сходится с сервером, а владелец видит, что именно не принято ──

const pullsOf = (t) => t.srv.state.calls.filter((c) => c.route === '/sync/pull').map((c) => new URLSearchParams(c.path.split('?')[1]))
const changedOf = (t) => new Set(t.events.filter((e) => e.type === 'changed').flatMap((e) => e.payload))

test('сервер отверг закрытие смены: касса берёт смену у сервера — открытой — и её можно закрыть снова', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const opened = await t.req('POST', '/shifts/open', { openingCash: 100 })
  await sell(t, 1)
  await t.gw.syncNow()

  t.srv.state.rejectIf = (op) => (op.type === 'shift.close' ? 'Недопустимая дата: закрытие смены' : null)
  assert.equal((await t.req('POST', '/shifts/close', { countedCash: 250 })).status, 201)
  t.srv.reset()
  t.gw.listen(true)
  t.events.length = 0
  await t.gw.syncNow()
  assert.equal(t.gw.status().rejected, 1)
  // Тем же обменом касса забрала аптеку целиком — без отметки «докуда получили»
  assert.equal(pullsOf(t).at(-1).has('cursor'), false)
  // На сервере смена открыта — и на кассе она снова открыта. Раньше её не было вовсе:
  // касса открывала новую, сервер отвергал и её («уже открыта другая») — и так по кругу
  const open = (await t.req('GET', '/shifts')).data.filter((x) => !x.closedAt)
  assert.deepEqual(open.map((x) => x.id), [opened.data.id])
  assert.ok(changedOf(t).has('shifts'), 'окно должно перечитать смены сразу, а не через минуту')

  // Владелец видит, что именно не принято: сколько было в кассе и что насчитали
  const [rej] = t.gw.rejected()
  assert.equal(rej.type, 'shift.close')
  assert.equal(rej.sum, 150)
  assert.deepEqual(rej.detail, { openingCash: 100, countedCash: 250, expectedCash: 250, difference: 0, count: 1 })

  t.srv.state.rejectIf = null
  assert.equal((await t.req('POST', '/shifts/close', { countedCash: 250 })).status, 201, 'смену можно закрыть снова')
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  assert.equal(t.srv.state.data.shifts.find((x) => x.id === opened.data.id).countedCash, 250)
  // Дальше — снова только изменения
  t.srv.reset()
  await t.gw.syncNow()
  assert.equal(pullsOf(t).at(-1).has('cursor'), true)
})

test('отвергнутый чек в долг: владелец видит его целиком — все позиции, количество, оплату и клиента', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.rejectIf = (op) => (op.type === 'sale' ? 'Клиент не найден' : null)
  const sale = await t.req('POST', '/sales', {
    payment: 'debt',
    customerId: 'ivan',
    items: [
      { productId: 'nur', qty: 2 },
      { productId: 'par', qty: 1, pieces: 5, discount: 10 },
    ],
  })
  assert.equal(sale.status, 201)
  assert.equal((await t.req('GET', '/customers')).data.find((c) => c.id === 'ivan').debt, 10 + sale.data.total)
  t.gw.listen(true)
  t.events.length = 0
  await t.gw.syncNow()

  // Чека в журнале кассы больше нет, долг клиента — как на сервере
  assert.deepEqual((await t.req('GET', '/sales')).data, [])
  assert.equal((await t.req('GET', '/customers')).data.find((c) => c.id === 'ivan').debt, 10)
  const changed = changedOf(t)
  for (const key of ['sales', 'products', 'customers']) assert.ok(changed.has(key), 'окно не узнало, что изменился раздел ' + key)

  const [rej] = t.gw.rejected()
  assert.equal(rej.sum, sale.data.total)
  assert.equal(rej.error, 'Клиент не найден')
  assert.equal(rej.detail.payment, 'debt')
  assert.equal(rej.detail.customer, 'Иван')
  assert.deepEqual(rej.detail.lines, [
    { name: 'Нурофен', qty: 2, pieces: 0, unitsPerPack: 1, price: 150, discount: 0 },
    { name: 'Парацетамол', qty: 1, pieces: 5, unitsPerPack: 20, price: 200, discount: 10 },
  ])
})

test('отвергнутые приход, списание, возврат, погашение долга и клиент: у каждого видно, что в нём было', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const sale = await sell(t, 2)
  await t.gw.syncNow()

  t.srv.state.rejectIf = (op) => (op.type === 'sale' ? null : 'Отказ для проверки')
  const done = [
    await t.req('POST', '/arrivals', {
      items: [
        { productId: 'nur', qty: 3, cost: 90, expiryDate: '2028-01-01' },
        { productId: 'par', qty: 1, cost: 110, expiryDate: '2028-01-01' },
      ],
    }),
    await t.req('POST', '/writeoffs', { reason: 'damaged', note: 'разбили', items: [{ productId: 'par', units: 3 }] }),
    await t.req('POST', '/returns', { saleId: sale.data.id, refund: 'cash', note: 'передумал', items: [{ productId: 'nur', units: 1, restock: false }] }),
    await t.req('POST', '/customers/ivan/pay', { amount: 4 }),
    await t.req('POST', '/customers', { name: 'Пётр', phone: '900112233', debt: 50 }),
  ]
  assert.deepEqual(done.map((r) => r.status), [201, 201, 201, 201, 201], JSON.stringify(done.map((r) => r.data?.message)))
  await t.gw.syncNow()

  const by = Object.fromEntries(t.gw.rejected().map((r) => [r.type, r]))
  assert.deepEqual(Object.keys(by).sort(), ['arrival', 'customer.create', 'debt.pay', 'return', 'writeoff'])

  // Приход без поставщика: в заголовке товары, а не прочерк
  assert.equal(by.arrival.title, 'Нурофен, Парацетамол')
  assert.equal(by.arrival.sum, 380)
  // Вместе со сроком годности: без него приход заново не оформить
  assert.deepEqual(by.arrival.detail.lines, [
    { name: 'Нурофен', qty: 3, cost: 90, expiry: '2028-01-01T00:00:00.000Z' },
    { name: 'Парацетамол', qty: 1, cost: 110, expiry: '2028-01-01T00:00:00.000Z' },
  ])

  assert.equal(by.writeoff.detail.reason, 'damaged')
  assert.equal(by.writeoff.detail.note, 'разбили')
  assert.deepEqual(by.writeoff.detail.lines, [{ name: 'Парацетамол', units: 3 }])

  assert.equal(by.return.detail.refund, 'cash')
  assert.equal(by.return.detail.note, 'передумал')
  assert.deepEqual(by.return.detail.sale, { date: sale.data.date, total: 300 }, 'возврат называет свой чек: по какому из них оформлять заново')
  assert.deepEqual(by.return.detail.lines, [{ name: 'Нурофен', units: 1, amount: 150, restock: false }])

  assert.equal(by['debt.pay'].sum, 4)
  assert.equal(by['debt.pay'].title, 'Иван', 'погашение без имени клиента владельцу ни о чём не говорит')
  assert.deepEqual(by['customer.create'].detail, { phone: '900112233', debt: 50 })

  // Владелец разобрался — запись уходит из списка, но остаётся в базе кассы
  const id = by.arrival.id
  assert.equal(t.gw.dismissRejected(id), true)
  assert.equal(t.gw.rejected().some((r) => r.id === id), false)
  assert.equal(local(t, 'SELECT state FROM outbox WHERE id = ?', id)[0].state, 'dismissed')
})

test('отказ пришёл, а забрать аптеку целиком не успели (связь пропала, программу закрыли) — после запуска касса делает это первым делом', async (tt) => {
  const t = await loggedIn()
  t.srv.state.rejectIf = (op) => (op.type === 'sale' ? 'Суммы чека не сходятся с его позициями' : null)
  await sell(t, 1)
  // Отправка дошла, а получение оборвалось
  t.srv.state.override = async (method, route) => (route === '/sync/pull' ? { throw: true } : null)
  await settle(t)
  assert.equal(t.gw.status().rejected, 1)
  t.gw.close()

  t.srv.state.override = null
  t.srv.reset()
  const again = createGateway({
    apiUrl: API,
    fetchImpl: t.srv.fetchImpl,
    session: t.session,
    core: t.core,
    cipher: fakeSeal,
    clock: { now: () => t.time.now, serverTime: () => {} },
    dataDir: t.dataDir,
    timers: t.timers,
  })
  tt.after(() => again.close())
  again.resume()
  await again.syncNow()
  assert.equal(pullsOf(t)[0].has('cursor'), false, 'пометка «нужно всё заново» должна пережить перезапуск')
  t.srv.reset()
  await again.syncNow()
  assert.equal(pullsOf(t)[0].has('cursor'), true, 'а после полной загрузки — снова только изменения')
})

test('сервер отверг закрытие смены, а связь тут же пропала: смена на кассе сразу снова открыта — вторую не открыть, чеки идут в неё', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const opened = await t.req('POST', '/shifts/open', { openingCash: 100 })
  await sell(t, 1)
  await t.gw.syncNow()

  t.srv.state.rejectIf = (op) => (op.type === 'shift.close' ? 'Недопустимая дата: закрытие смены' : null)
  assert.equal((await t.req('POST', '/shifts/close', { countedCash: 250 })).status, 201)
  // Отказ дошёл, а забрать аптеку заново не вышло: связь пропала
  t.srv.state.override = async (method, route) => (route === '/sync/pull' ? { throw: true } : null)
  await t.gw.syncNow()
  t.srv.state.online = false
  assert.equal(t.gw.status().rejected, 1)

  // Раньше смены на кассе в эту минуту не было вовсе: кассир открывал вторую, сервер
  // потом отвергал и её, а чеки оставались без смены
  const now = (await t.req('GET', '/shifts')).data
  assert.deepEqual(now.filter((x) => !x.closedAt).map((x) => x.id), [opened.data.id], 'смена снова открыта')
  const again = now.find((x) => x.id === opened.data.id)
  assert.deepEqual([again.countedCash, again.totalSales, again.count], [null, 0, 0], 'итоги несостоявшегося закрытия стёрты')
  const second = await t.req('POST', '/shifts/open', { openingCash: 100 })
  assert.equal(second.status, 400)
  assert.match(second.data.message, /Смена уже открыта/)
  const sale = await sell(t, 1)
  assert.equal(sale.data.shiftId, opened.data.id, 'чек идёт в ту же смену')

  // Связь вернулась: смену закрывают снова — уже с новым чеком
  t.srv.state.online = true
  t.srv.state.override = null
  t.srv.state.rejectIf = null
  await t.gw.syncNow()
  const closed = await t.req('POST', '/shifts/close', { countedCash: 400 })
  assert.equal(closed.status, 201)
  assert.equal(closed.data.count, 2)
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  assert.equal(t.srv.state.data.shifts.find((x) => x.id === opened.data.id).countedCash, 400)
})

test('сервер ответил, что такой смены у него нет: заново она не открывается — кассир открывает новую, и её сервер принимает', async (tt) => {
  for (const reason of ['Смена не найдена', 'Эта смена открыта на другой кассе']) {
    const t = await loggedIn()
    tt.after(() => t.gw.close())
    const opened = await t.req('POST', '/shifts/open', { openingCash: 100 })
    await sell(t, 1)
    await t.gw.syncNow()

    // Базу сервера вернули из старой копии (или базу кассы перенесли с другого
    // компьютера): этой смены для этой кассы у сервера нет
    t.srv.state.data.shifts = t.srv.state.data.shifts.filter((x) => x.id !== opened.data.id)
    t.srv.state.rejectIf = (op) => (op.type === 'shift.close' && op.payload.shift.id === opened.data.id ? reason : null)
    assert.equal((await t.req('POST', '/shifts/close', { countedCash: 250 })).status, 201)
    // Отказ дошёл, а забрать аптеку заново не вышло: связь пропала
    t.srv.state.override = async (method, route) => (route === '/sync/pull' ? { throw: true } : null)
    await t.gw.syncNow()
    t.srv.state.online = false
    assert.equal(t.gw.status().rejected, 1, reason)

    // Открытой заново смена не стала. Иначе в неё шли бы чеки, которые сервер запишет
    // без смены, а закрыть её не вышло бы никогда: сервер отвергал бы закрытие снова
    assert.deepEqual((await t.req('GET', '/shifts')).data.filter((x) => !x.closedAt), [], reason)
    const [rej] = t.gw.rejected()
    assert.equal(rej.type, 'shift.close')
    assert.equal(rej.error, reason)

    // Кассир открывает новую смену — и работает в ней
    const second = await t.req('POST', '/shifts/open', { openingCash: 100 })
    assert.equal(second.status, 201, reason)
    const sale = await sell(t, 1)
    assert.equal(sale.data.shiftId, second.data.id)

    // Связь вернулась: новую смену сервер принимает, чек лежит в ней
    t.srv.state.online = true
    t.srv.state.override = null
    await t.gw.syncNow()
    await t.gw.syncNow()
    assert.equal(t.gw.status().pending, 0, reason)
    assert.equal(t.gw.status().rejected, 1, 'новых отказов нет')
    assert.deepEqual(t.srv.state.data.shifts.filter((x) => !x.closedAt).map((x) => x.id), [second.data.id], reason)
    assert.deepEqual((await t.req('GET', '/shifts')).data.filter((x) => !x.closedAt).map((x) => x.id), [second.data.id], reason)
  }
})

test('срок работы без связи считается по своему времени, а чеки датируются временем часов', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  t.srv.state.online = false
  // Компьютер со сбитыми часами: время чеков стоит на месте, а срок за шесть ночей
  // уменьшился на шесть раз по полсуток — и ещё три дня работы
  t.time.licAhead = 6 * DAY_MS
  t.gw.tick()
  const st = t.gw.status()
  assert.equal(st.licence.expired, false)
  assert.equal(st.licence.warn, true, 'до остановки меньше двух дней — по времени срока')
  assert.ok(Math.abs(st.licence.leftMs - DAY_MS) < 60_000)
  const sale = await sell(t, 1)
  assert.equal(sale.status, 201)
  assert.equal(sale.data.date, new Date(t.time.now).toISOString(), 'в чеке — время часов, без выдуманных суток')

  // Срок вышел — по своему времени
  t.time.licAhead = 8 * DAY_MS
  t.gw.tick()
  assert.equal(t.gw.status().licence.expired, true)
  assert.ok(stops(t).some((e) => e.type === 'suspended'), 'касса останавливается до проверки')
})

// ── Поставщики, наличные в смене и переводы (версия 1.0.2) ──

test('внесение и изъятие без связи: в смене кассы сразу, после связи — на сервере в той же смене; отмена — только через сервер', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const shift = await t.req('POST', '/shifts/open', { openingCash: 100 })
  await t.gw.syncNow()
  const tillNow = async () => {
    const s = (await t.req('GET', '/shifts')).data.find((x) => x.id === shift.data.id)
    return [s.cashIn, s.cashOut]
  }
  t.srv.state.online = false
  const put = await t.req('POST', '/shifts/cash', { kind: 'in', amount: 200, note: 'размен' })
  assert.equal(put.status, 201)
  assert.deepEqual([put.data.kind, put.data.amount, put.data.shiftId, put.data.user.name], ['in', 200, shift.data.id, 'kassir'])
  assert.equal((await t.req('POST', '/shifts/cash', { kind: 'out', amount: 50, note: 'владельцу' })).status, 201)
  assert.equal((await t.req('POST', '/shifts/cash', { kind: 'out', amount: 0 })).status, 400)
  assert.deepEqual(await tillNow(), [200, 50])
  assert.equal(t.gw.status().pending, 2)
  // Отменить неотправленное нельзя: сервер о нём ещё не знает
  const gone = await t.req('DELETE', '/cash-moves/' + put.data.id)
  assert.equal(gone.status, 409)
  assert.equal(gone.data.message, MESSAGES.notSent)
  assert.deepEqual(await tillNow(), [200, 50])

  // Связь вернулась — обе записи на сервере, в смене этой кассы, по одному разу
  t.srv.state.online = true
  await t.gw.syncNow()
  assert.equal(t.gw.status().pending, 0)
  const onServer = t.srv.state.data.cashMoves.filter((m) => m.shiftId === shift.data.id)
  assert.deepEqual(onServer.map((m) => [m.kind, m.amount]).sort(), [['in', 200], ['out', 50]])
  const srvShift = t.srv.state.data.shifts.find((s) => s.id === shift.data.id)
  assert.deepEqual([srvShift.cashIn, srvShift.cashOut], [200, 50])
  assert.deepEqual(await tillNow(), [200, 50], 'после обмена внесённое потерялось или задвоилось')
  const list = (await t.req('GET', '/cash-moves?days=180')).data
  assert.equal(list.length, 2)
  assert.ok(list.every((m) => m.server), 'в журнале должны быть копии сервера')

  // Отмена — через сервер; без связи — объяснение. Из локальной базы запись уходит сразу
  t.srv.state.online = false
  const off = await t.req('DELETE', '/cash-moves/' + put.data.id)
  assert.equal(off.status, 0)
  assert.equal(off.data.message, MESSAGES.cashMoveOnline)
  assert.deepEqual(await tillNow(), [200, 50])
  t.srv.state.online = true
  assert.equal((await t.req('DELETE', '/cash-moves/' + put.data.id)).status, 200)
  assert.deepEqual(await tillNow(), [0, 50])
  assert.equal((await t.req('GET', '/cash-moves?days=180')).data.length, 1)
})

test('продажа переводом без связи: сервис — из локальной базы, чек доходит до сервера с ним; сервисы меняет только сервер', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.online = false
  assert.deepEqual((await t.req('GET', '/pay-services')).data.map((s) => s.name), ['Alif', 'DC', 'Эсхата'])
  const no = await t.req('POST', '/sales', { payment: 'transfer', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(no.status, 400)
  assert.equal(no.data.message, 'Укажите сервис перевода')
  const sale = await t.req('POST', '/sales', { payment: 'transfer', payVia: 'DC', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201)
  assert.deepEqual([sale.data.payment, sale.data.payVia], ['transfer', 'DC'])
  for (const [method, path] of [['POST', '/pay-services'], ['DELETE', '/pay-services/paysvc-1']]) {
    const r = await t.req(method, path, { name: 'Humo' })
    assert.equal(r.status, 0, `${method} ${path}`)
    assert.equal(r.data.message, MESSAGES.payServicesOnline)
  }
  t.srv.state.online = true
  await t.gw.syncNow()
  const onServer = t.srv.state.data.sales.find((s) => s.id === sale.data.id)
  assert.deepEqual([onServer.payment, onServer.payVia], ['transfer', 'DC'])
  // Сервис завёл сервер — касса тут же знает его: по нему можно продать и без связи
  assert.equal((await t.req('POST', '/pay-services', { name: 'Humo' })).status, 201)
  assert.ok((await t.req('GET', '/pay-services')).data.some((s) => s.name === 'Humo'))
  t.srv.state.online = false
  assert.equal((await t.req('POST', '/sales', { payment: 'transfer', payVia: 'Humo', items: [{ productId: 'nur', qty: 1 }] })).status, 201)
})

test('приход в долг без связи: долг поставщика на кассе растёт сразу, на сервере — после связи; оплата из кассы называет серверу смену кассы', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  const debt = async () => (await t.req('GET', '/suppliers')).data.find((s) => s.id === 'sup-1').debt
  t.srv.state.online = false
  assert.equal(await debt(), 500)
  const arrival = await t.req('POST', '/arrivals', { supplierId: 'sup-1', debt: 120, items: [{ productId: 'nur', qty: 2, cost: 100, expiryDate: '2028-01-31' }] })
  assert.equal(arrival.status, 201)
  assert.deepEqual([arrival.data.supplier, arrival.data.debt], ['Фарм-опт', 120])
  assert.equal(await debt(), 620)
  // Завести поставщика, открыть карточку, заплатить — только с интернетом
  for (const [method, path, body] of [['POST', '/suppliers', { name: 'Новый' }], ['GET', '/suppliers/sup-1'], ['POST', '/suppliers/sup-1/pay', { amount: 1 }]]) {
    const r = await t.req(method, path, body)
    assert.equal(r.status, 0, `${method} ${path}`)
    assert.equal(r.data.message, MESSAGES.supplierOnline)
  }
  t.srv.state.online = true
  await t.gw.syncNow()
  assert.equal(t.srv.state.data.suppliers.find((s) => s.id === 'sup-1').debt, 620)
  assert.equal(await debt(), 620, 'после обмена долг прихода потерялся или задвоился')

  // Оплата из кассы: смену сервер должен знать по имени — касса подставляет свою
  t.srv.reset()
  const noShift = await t.req('POST', '/suppliers/sup-1/pay', { amount: 100, fromCash: true })
  assert.equal(noShift.status, 400)
  assert.equal(noShift.data.message, NO_OPEN_SHIFT)
  assert.equal(t.srv.count('POST', '/suppliers/sup-1/pay'), 0, 'без смены запрос до сервера доходить не должен')
  // Смена открыта без связи — перед оплатой она сначала уходит на сервер
  t.srv.state.online = false
  const shift = await t.req('POST', '/shifts/open', { openingCash: 300 })
  t.srv.state.online = true
  const paid = await t.req('POST', '/suppliers/sup-1/pay', { amount: 100, fromCash: true, note: 'из ящика' })
  assert.equal(paid.status, 201)
  const call = t.srv.state.calls.find((c) => c.method === 'POST' && c.route === '/suppliers/sup-1/pay')
  assert.equal(call.body.shiftId, shift.data.id, 'сервер должен получить смену этой кассы')
  assert.equal(await debt(), 520)
  const here = (await t.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id)
  assert.equal(here.supplierCash, 100, 'сумма оплат из кассы должна прийти в смену')
  assert.deepEqual((await t.req('GET', '/supplier-payments')).data.map((p) => [p.amount, p.fromCash, p.shiftId]), [[100, true, shift.data.id]])
  // Закрытие: 300 на начало − 100 поставщику
  const closed = await t.req('POST', '/shifts/close', { countedCash: 200 })
  assert.deepEqual([closed.data.supplierCash, closed.data.expectedCash, closed.data.difference], [100, 200, 0])
})

test('кассир по умолчанию: приход закрыт — у минимальной роли нет такого права', async (tt) => {
  const t = await loggedIn({ role: 'cashier' })
  tt.after(() => t.gw.close())
  t.srv.state.online = false
  const r = await t.req('POST', '/arrivals', { supplierId: 'sup-1', items: [{ productId: 'nur', qty: 1, cost: 100, expiryDate: '2028-01-31' }] })
  assert.equal(r.status, 403)
  assert.equal(r.data.message, 'Недостаточно прав')
  assert.equal((await t.req('GET', '/arrivals')).status, 403)
})

test('кассир с правом прихода: поставщики без долгов, оплаты поставщикам и история товара закрыты, как на сервере; приход в долг оформить может', async (tt) => {
  // Владелец выдал кассиру приход и приход в долг, но не поставщиков — долги и оплаты остаются закрытыми
  const t = await loggedIn({ role: 'cashier', permissions: ['pos.sell', 'shift.open', 'arrivals.view', 'arrivals.create', 'arrivals.debt'] })
  tt.after(() => t.gw.close())
  const sup = (await t.req('GET', '/suppliers')).data.find((s) => s.id === 'sup-1')
  assert.ok(sup && !('debt' in sup), 'кассиру долг поставщика не показывают')
  assert.equal(local(t, "SELECT sDebtC FROM suppliers WHERE id = 'sup-1'")[0].sDebtC, null)
  assert.equal((await t.req('GET', '/supplier-payments')).status, 403)
  assert.equal((await t.req('POST', '/suppliers/sup-1/pay', { amount: 1 })).status, 403)
  t.srv.state.online = false
  assert.equal((await t.req('POST', '/arrivals', { supplierId: 'sup-1', debt: 30, items: [{ productId: 'nur', qty: 1, cost: 100, expiryDate: '2028-01-31' }] })).status, 201)
  const r = await t.req('GET', '/products/nur/history')
  assert.equal(r.status, 0)
  assert.equal(r.data.message, MESSAGES.historyOnline)
  t.srv.state.online = true
  await t.gw.syncNow()
  assert.equal(t.srv.state.data.suppliers.find((s) => s.id === 'sup-1').debt, 530, 'долг прихода кассира не дошёл до сервера')
  assert.equal((await t.req('GET', '/products/nur/history')).status, 403)
})
