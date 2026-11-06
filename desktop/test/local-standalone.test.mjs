// ── Магазин без интернета (версия 1.6.0) ──
//
// Программа ставится на компьютер магазина, у которого интернета нет вовсе: способ работы
// выбирают при первом запуске, программу активируют кодом, магазин и владельца заводят здесь
// же. Дальше — всё, что умеет касса, и то, что раньше умел только сервер: каждая операция
// принимается сразу, объединение товаров, удаление покупателя, свой пароль, сброс пароля
// владельца кодом, отчёты и возвраты за любой срок. Сети программа при этом не касается вовсе:
// заглушка сети считает обращения, и их должно быть ноль.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway, MESSAGES } from '../src/gateway.mjs'
import { CASHIER_DEFAULT } from '../src/local/accounts.mjs'
import { openDb, q } from '../src/local/db.mjs'
import { computerCodeOf, computerRawOf } from '../src/local/licence-code.mjs'
import { CORE_SCHEMA, PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyRestore, requestRestore } from '../src/restore.mjs'
import Database from 'better-sqlite3'
import { recountDebts } from '../src/local/snapshot.mjs'
import { ALL_PERMISSIONS } from '../src/local/standalone.mjs'
import { rebuildStock } from '../src/local/stock.mjs'
import { NOW, DAY } from '../test-support/pharmacy.mjs'
import { fakeSeal, manualTimers, memorySession } from '../test-support/server.mjs'
import { dayOf, FOREVER, issueCode, makeKeys, publicOf, todayDay } from '../test-support/licence-sign.mjs'

const MACHINE = 'a1b2c3d4-0000-4000-8000-000000000001'
const PC = computerRawOf(MACHINE)
const OTHER_PC = computerRawOf('ffffffff-0000-4000-8000-000000000002')
const KEYS = makeKeys()
const OWNER = 'farrukh'
const PASS = 'Parol-777'

// machine, cipher — другой компьютер: свой код компьютера и своё шифрование Windows (отпечатки
// паролей, зашифрованные на одном компьютере, на другом не открыть). core и dataDir — та же
// программа после перезапуска. requireCode — с кодом активации (механизм 1.6.0; в 1.7.0 выключен,
// но остаётся рабочим); offlineOnly — все магазины без интернета (1.7.0)
function setup({ machine = MACHINE, cipher = fakeSeal, core: coreDb, dataDir: dir, time: clockTime, requireCode = true, offlineOnly = false } = {}) {
  const time = clockTime || { now: NOW }
  const core = coreDb || openDb(':memory:', CORE_SCHEMA)
  const session = memorySession()
  const events = []
  const errors = []
  const net = []
  const dataDir = dir || fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-'))
  const pc = computerRawOf(machine)
  const gw = createGateway({
    apiUrl: 'https://server.example/api',
    // Сети у магазина нет: любое обращение — ошибка проверки
    fetchImpl: async (url) => {
      net.push(String(url))
      throw new Error('сети нет')
    },
    session,
    core,
    cipher,
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now, floor: () => time.now },
    dataDir,
    timers: manualTimers(),
    emit: (type, payload) => events.push({ type, payload }),
    log: { info() {}, warn() {}, error: (...a) => errors.push(a) },
    standalone: { publicKey: KEYS.publicKey, computerRaw: pc, computerCode: computerCodeOf(machine), requireCode },
    offlineOnly,
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = (name = OWNER, password = PASS) => req('POST', '/auth/login', { name, password })
  const code = (over = {}) => issueCode(KEYS.privateKey, pc, { kind: 'activate', until: todayDay(time.now) + 365, registers: 2, serial: 1, ...over })
  // База магазина, которую держит открытой сам шлюз
  const db = () => gw.pharmacyDb()
  return { gw, core, session, events, errors, net, time, req, login, code, dataDir, db, pc }
}

// Магазин заведён, владелец вошёл, смена открыта
async function shop() {
  const t = setup()
  assert.deepEqual(t.gw.standalone.chooseMode('standalone'), { ok: true, mode: 'standalone' })
  assert.equal(t.gw.standalone.activate(t.code()).ok, true)
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: PASS })).ok, true)
  assert.equal((await t.login()).status, 201)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 100 })).status, 201)
  return t
}

const pendingOps = (db) => q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n

// Остаток, закупочная, срок и долги — как сейчас; и то же после пересборки с нуля (как после
// перезапуска с испорченной памятью): приём операции обязан сделать их основой
function stateOf(db) {
  return {
    stock: q(db, 'SELECT productId, SUM(units) AS u FROM batches GROUP BY productId ORDER BY productId').all(),
    cost: q(db, 'SELECT id, costC, expiryDate FROM products ORDER BY id').all(),
    debts: q(db, 'SELECT id, debtC FROM customers ORDER BY id').all(),
  }
}

test('первый запуск: способ работы, активация, магазин и вход — без единого обращения к сети', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  const info = t.gw.standalone.info()
  assert.deepEqual([info.mode, info.cloudAccounts, info.shop, info.ready, info.computer], ['', 0, false, true, computerCodeOf(MACHINE)])
  // 1.7.1: без кода — пробный срок; до заведения магазина он ещё не пошёл
  assert.deepEqual([info.activation.active, info.activation.trial, info.activation.notStarted], [true, true, true])
  // Активация — только после выбора «без интернета»
  assert.deepEqual(t.gw.standalone.activate(t.code()), { error: MESSAGES.notStandalone })
  t.gw.standalone.chooseMode('standalone')
  // Опечатка, чужой компьютер, код сброса вместо активации, просроченный код
  assert.match(t.gw.standalone.activate('ABCDE-12345').error, /опечатка/)
  assert.match(t.gw.standalone.activate(issueCode(KEYS.privateKey, OTHER_PC, { until: todayDay(t.time.now) + 30 })).error, /не подходит к этому компьютеру/)
  assert.match(t.gw.standalone.activate(t.code({ kind: 'reset', until: todayDay(t.time.now) + 2 })).error, /код сброса пароля/)
  assert.match(t.gw.standalone.activate(t.code({ until: todayDay(t.time.now) - 1 })).error, /уже прошёл/)
  // Код другого сервиса (чужой ключ)
  assert.match(t.gw.standalone.activate(issueCode(makeKeys().privateKey, PC, { until: todayDay(t.time.now) + 30 })).error, /не подходит/)
  const ok = t.gw.standalone.activate(t.code())
  assert.equal(ok.ok, true)
  assert.deepEqual([ok.activation.active, ok.activation.registers, ok.activation.forever], [true, 2, false])
  // Магазин: правила пароля — как у сервера
  assert.match((await t.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: '123456' })).error, /подберут/)
  assert.equal((await t.gw.standalone.setupShop({ shopName: '', login: OWNER, password: PASS })).error, MESSAGES.noShopName)
  assert.deepEqual(await t.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: PASS }), { ok: true, login: OWNER })
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Второй', login: 'x', password: PASS })).error, MESSAGES.shopExists)
  // Способ работы больше не меняется
  assert.equal(t.gw.standalone.chooseMode('cloud').error, MESSAGES.modeLocked)

  assert.equal((await t.login(OWNER, 'не-тот-пароль')).data.message, 'Неверное имя или пароль')
  assert.equal((await t.login('nikto', PASS)).data.message, 'Неверное имя или пароль')
  const r = await t.login()
  assert.equal(r.status, 201)
  assert.deepEqual([r.data.user.role, r.data.user.standalone, r.data.user.pharmacy.name, r.data.user.subscription.canWrite], ['founder', true, 'Магазин у дома', true])
  const me = await t.req('GET', '/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.data.standalone, true)

  // Справочники нового магазина — как у нового магазина на сервере
  assert.equal((await t.req('GET', '/categories')).data.length, 7)
  assert.ok((await t.req('GET', '/expense-categories')).data.some((c) => c.name === 'Зарплата'))
  assert.equal((await t.req('GET', '/income-categories')).data.length, 4)
  assert.equal((await t.req('GET', '/pay-services')).data.length, 5)
  assert.equal((await t.req('GET', '/product-types')).data.length, 7)
  const roles = (await t.req('GET', '/roles')).data
  assert.deepEqual(roles.map((x) => x.name), ['Владелец', 'Кассир', 'Заведующий', 'Наблюдатель'])
  assert.deepEqual(roles[1].permissions, CASHIER_DEFAULT)
  const users = (await t.req('GET', '/users')).data
  assert.deepEqual(users.map((u) => [u.name, u.roleId]), [[OWNER, 'owner']])
  assert.deepEqual(t.net, [], 'программа без интернета ходила в сеть')
  assert.deepEqual(t.errors, [])
})

test('каждая операция принимается сразу: очереди нет, пересборка остатка даёт то же самое', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const sup = await t.req('POST', '/suppliers', { name: 'Оптовик', openingDebt: 50 })
  assert.equal(sup.status, 201)
  const a = (await t.req('POST', '/products', { name: 'Мука', barcode: '4600000000101', price: 20, cost: 10, stock: 0 })).data
  const b = (await t.req('POST', '/products', { name: 'Сахар', barcode: '4600000000102', price: 15, cost: 8, stock: 4 })).data
  // Приход: 10 шт по 10, из кассы заплачено 30, в долг — 70
  const arr = await t.req('POST', '/arrivals', { supplierId: sup.data.id, debt: 70, payMethod: 'cash', paidCash: 30, items: [{ productId: a.id, qty: 10, cost: 10, expiryDate: '2028-01-01' }] })
  assert.equal(arr.status, 201, JSON.stringify(arr.data))
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: a.id, qty: 3 }] })
  assert.equal(sale.status, 201)
  assert.equal((await t.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: a.id, units: 1 }] })).status, 201)
  assert.equal((await t.req('POST', '/writeoffs', { items: [{ productId: b.id, units: 1 }] })).status, 201)
  const cust = (await t.req('POST', '/customers', { name: 'Иван', phone: '' })).data
  assert.equal((await t.req('POST', '/sales', { payment: 'debt', customerId: cust.id, items: [{ productId: a.id, qty: 2 }] })).status, 201)
  assert.equal((await t.req('POST', `/customers/${cust.id}/pay`, { amount: 15 })).status, 201)
  assert.equal((await t.req('POST', '/expenses', { category: 'Аренда', amount: 12, fromCash: true })).status, 201)
  assert.equal((await t.req('POST', '/incomes', { category: 'Услуги', amount: 5 })).status, 201)
  assert.equal((await t.req('POST', '/shifts/cash', { kind: 'in', amount: 7 })).status, 201)
  assert.equal((await t.req('POST', `/suppliers/${sup.data.id}/pay`, { amount: 20, fromCash: true })).status, 201)
  // Пересчёт: сахара по учёту 3, насчитали 1 — недостача 2 шт оформится списанием
  const sheet = (await t.req('POST', '/inventory', { scope: 'all' })).data
  const lineB = sheet.items.find((i) => i.productId === b.id)
  assert.equal((await t.req('PATCH', `/inventory/${sheet.id}`, { items: [{ id: lineB.id, actualUnits: 1 }] })).status, 200)
  assert.equal((await t.req('POST', `/inventory/${sheet.id}/apply`, {})).status, 201)

  const db = t.db()
  assert.equal(pendingOps(db), 0, 'операции остались неприняты')
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM docs WHERE sync <> 'synced'").get().n, 0, 'документы остались «ждущими»')
  assert.equal(q(db, 'SELECT COUNT(*) AS n FROM stock_moves WHERE synced = 0').get().n, 0)
  // Остатки: мука 10 − 3 + 1 − 2 = 6; сахар 4 − 1 − 2 (недостача) = 1
  const units = (id) => q(db, 'SELECT COALESCE(SUM(units), 0) AS u FROM batches WHERE productId = ?').get(id).u
  assert.deepEqual([units(a.id), units(b.id)], [6, 1])
  // Пересборка с основы даёт ровно то же: приём перенёс всё в основу
  const before = stateOf(db)
  rebuildStock(db)
  recountDebts(db)
  assert.deepEqual(stateOf(db), before)

  // Оплата прихода из кассы — записана оплатой поставщику (как делает сервер)
  const pays = (await t.req('GET', '/supplier-payments?days=0')).data
  assert.deepEqual(pays.map((p) => [p.amount, p.note]).sort(), [[20, ''], [30, 'Оплата прихода']])
  // Недостача по пересчёту — списанием «недостача»
  const wo = (await t.req('GET', '/writeoffs?days=0')).data.find((w) => w.source === 'inventory')
  assert.ok(wo, 'нет списания недостачи')
  assert.deepEqual([wo.reason, wo.note, wo.items[0].units, wo.totalCost], ['lost', 'Недостача по итогам пересчёта', 2, 16])
  // Долг поставщика: 50 начальный + 70 приход − 20 оплата = 100
  const s = (await t.req('GET', '/suppliers')).data.find((x) => x.id === sup.data.id)
  assert.equal(s.debt, 100)
  const debts = (await t.req('GET', '/suppliers/debts')).data
  assert.deepEqual([debts.total, debts.suppliers.find((x) => x.id === sup.data.id).arrivals], [100, 1])
  // Долг покупателя: 2 × 20 − 15 = 25
  assert.equal((await t.req('GET', '/customers')).data.find((c) => c.id === cust.id).debt, 25)
  // Смена: 100 + 60 (чек) − 20 (возврат) + 15 (долг) + 7 (внесено) − 12 (расход) − 30 (приход) − 20 (поставщику)
  const shift = (await t.req('GET', '/shifts')).data.find((x) => !x.closedAt)
  assert.deepEqual([shift.expenseCash, shift.supplierCash, shift.cashIn], [12, 50, 7])
  const closed = await t.req('POST', '/shifts/close', { countedCash: 100 })
  assert.equal(closed.status, 201)
  assert.equal(closed.data.expectedCash, 100)
  assert.equal(closed.data.difference, 0)
  assert.deepEqual(t.net, [])
  assert.deepEqual(t.errors, [])
})

test('давние чеки и отчёты за любой срок: всё хранится на этом компьютере', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const p = (await t.req('POST', '/products', { name: 'Чай', barcode: '4600000000201', price: 30, cost: 20, stock: 5 })).data
  const old = (await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })).data
  // Прошло 200 дней — касса с сервером хранила бы чеки только за 60
  t.time.now += 200 * DAY
  t.gw.tick()
  const all = (await t.req('GET', '/sales?days=0')).data
  assert.ok(all.some((s) => s.id === old.id), 'давнего чека нет в журнале «за всё время»')
  const from = new Date(NOW - DAY).toISOString()
  const to = new Date(NOW + DAY).toISOString()
  assert.ok((await t.req('GET', `/sales?from=${from}&to=${to}`)).data.some((s) => s.id === old.id))
  assert.ok((await t.req('GET', '/sales?days=365')).data.some((s) => s.id === old.id))
  // Возврат по чеку двухсотдневной давности — здесь же, без сервера
  const ret = await t.req('POST', '/returns', { saleId: old.id, items: [{ productId: p.id, units: 1 }] })
  assert.equal(ret.status, 201, JSON.stringify(ret.data))
  // История товара полная: пометки «только данные компьютера» нет
  const h = (await t.req('GET', `/products/${p.id}/history?days=0`)).data
  assert.deepEqual([h.local, h.partial], [false, false])
  assert.ok(h.rows.length >= 2)
  assert.deepEqual(t.net, [])
})

test('свой пароль, новый сотрудник и сброс пароля владельца кодом', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  // Свой пароль
  assert.equal((await t.req('POST', '/auth/change-password', { oldPassword: 'не-тот', newPassword: 'Novyi-777' })).data.message, MESSAGES.oldPassword)
  assert.equal((await t.req('POST', '/auth/change-password', { oldPassword: PASS, newPassword: PASS })).data.message, MESSAGES.samePassword)
  assert.equal((await t.req('POST', '/auth/change-password', { oldPassword: PASS, newPassword: 'Novyi-777' })).status, 201)
  t.gw.logout()
  assert.equal((await t.login(OWNER, PASS)).status, 401, 'прежний пароль всё ещё подходит')
  assert.equal((await t.login(OWNER, 'Novyi-777')).status, 201)

  // Новый кассир — входит сразу, с правами кассира
  const made = await t.req('POST', '/users', { name: 'kassir1', password: 'Kassir-pass-1' })
  assert.equal(made.status, 201, JSON.stringify(made.data))
  t.gw.logout()
  const k = await t.login('kassir1', 'Kassir-pass-1')
  assert.equal(k.status, 201)
  assert.deepEqual(k.data.user.permissions, CASHIER_DEFAULT)
  // Кассиру менять свой пароль нельзя (как на сервере)
  assert.equal((await t.req('POST', '/auth/change-password', { oldPassword: 'Kassir-pass-1', newPassword: 'Kassir-pass-2' })).status, 403)
  // Удаление покупателя и объединение товаров — не его права
  assert.equal((await t.req('DELETE', '/customers/net')).status, 403)
  t.gw.logout()

  // Владелец забыл пароль: код сброса от поставщика программы
  const reset = (over = {}) => issueCode(KEYS.privateKey, PC, { kind: 'reset', until: todayDay(t.time.now) + 2, serial: 777, registers: 0, ...over })
  assert.match((await t.gw.standalone.resetPassword({ code: t.code(), password: 'Sbros-pass-1' })).error, /код активации, а не код сброса/)
  assert.match((await t.gw.standalone.resetPassword({ code: issueCode(KEYS.privateKey, OTHER_PC, { kind: 'reset', until: todayDay(t.time.now) + 2 }), password: 'Sbros-pass-1' })).error, /не подходит/)
  assert.match((await t.gw.standalone.resetPassword({ code: reset({ until: todayDay(t.time.now) - 1 }), password: 'Sbros-pass-1' })).error, /уже прошёл/)
  assert.match((await t.gw.standalone.resetPassword({ code: reset(), password: '111111' })).error, /подберут|повторяющегося/)
  assert.deepEqual(await t.gw.standalone.resetPassword({ code: reset(), password: 'Sbros-pass-1' }), { ok: true, login: OWNER })
  assert.equal((await t.login(OWNER, 'Novyi-777')).status, 401)
  assert.equal((await t.login(OWNER, 'Sbros-pass-1')).status, 201)
  t.gw.logout()
  // Тот же код второй раз не проходит
  assert.match((await t.gw.standalone.resetPassword({ code: reset(), password: 'Eshche-raz-1' })).error, /уже использован/)
  // Кассир после сброса пароля владельца входит как прежде
  assert.equal((await t.login('kassir1', 'Kassir-pass-1')).status, 201)
  assert.deepEqual(t.net, [])
})

test('объединение одинаковых товаров и удаление покупателя — здесь же, без сервера', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const a = (await t.req('POST', '/products', { name: 'Рис', barcode: '4600000000301', price: 25, cost: 10, stock: 5 })).data
  const dup = (await t.req('POST', '/products', { name: 'Рис (дубль)', barcode: '4600000000302', price: 25, cost: 20, stock: 3 })).data
  const other = (await t.req('POST', '/products', { name: 'Рис в пачке', barcode: '4600000000303', price: 25, cost: 10, stock: 1, unitsPerPack: 10 })).data
  const sale = (await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: dup.id, qty: 1 }] })).data
  // Упаковки разные — не объединить
  const bad = await t.req('POST', `/products/${other.id}/merge`, { into: a.id })
  assert.equal(bad.status, 400)
  assert.match(bad.data.message, /Штук в упаковке/)
  const m = await t.req('POST', `/products/${dup.id}/merge`, { into: a.id })
  assert.equal(m.status, 200, JSON.stringify(m.data))
  const list = (await t.req('GET', '/products')).data
  assert.equal(list.some((p) => p.id === dup.id), false, 'лишняя карточка осталась')
  const rice = list.find((p) => p.id === a.id)
  // Остаток обеих: 5 + 3 − 1 = 7; закупочная — средняя по партиям: (5 × 10 + 2 × 20) / 7
  assert.equal(rice.stock, 7)
  assert.equal(rice.cost, 12.86)
  // Проданное с дубля теперь числится за основной карточкой
  const s = (await t.req('GET', '/sales?days=0')).data.find((x) => x.id === sale.id)
  assert.equal(s.items[0].productId, a.id)

  // Покупатель с долгом и погашением — удаляется вместе с историей погашений
  const c = (await t.req('POST', '/customers', { name: 'Пётр' })).data
  await t.req('POST', '/sales', { payment: 'debt', customerId: c.id, items: [{ productId: a.id, qty: 1 }] })
  await t.req('POST', `/customers/${c.id}/pay`, { amount: 10 })
  assert.equal((await t.req('DELETE', `/customers/${c.id}`)).status, 200)
  assert.equal((await t.req('GET', '/customers')).data.some((x) => x.id === c.id), false)
  assert.equal((await t.req('GET', '/payments?days=0')).data.some((p) => p.customerId === c.id), false)
  assert.equal((await t.req('DELETE', `/customers/${c.id}`)).status, 404)
  // Разделы, которые бывают только с сервером, — пустые, а не «нужен интернет»
  assert.deepEqual((await t.req('GET', '/discrepancies')).data, [])
  assert.equal((await t.req('GET', '/admin/pharmacies')).data.message, MESSAGES.soloUnavailable)
  assert.deepEqual(t.net, [])
})

test('срок кода: предупреждение за 7 дней, остановка, новый код — работа сразу', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  t.gw.standalone.chooseMode('standalone')
  const today = todayDay(t.time.now)
  assert.equal(t.gw.standalone.activate(t.code({ until: today + 10 })).ok, true)
  await t.gw.standalone.setupShop({ shopName: 'Магазин', login: OWNER, password: PASS })
  await t.login()
  t.gw.listen(true)
  await t.req('POST', '/shifts/open', { openingCash: 0 })
  const p = (await t.req('POST', '/products', { name: 'Соль', barcode: '4600000000401', price: 5, cost: 3, stock: 50 })).data
  const sell = () => t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  assert.equal(t.gw.status().activation.warn, false)
  // За неделю до конца — предупреждение
  t.time.now += 5 * DAY
  t.gw.tick()
  assert.equal(t.gw.status().activation.warn, true)
  assert.equal((await t.req('GET', '/auth/me')).data.subscription.warn, true)
  assert.equal((await sell()).status, 201)
  // Последний день — ещё работает; следующий — нет
  t.time.now += 5 * DAY
  t.gw.tick()
  assert.equal((await sell()).status, 201, 'последний день срока должен работать целиком')
  t.time.now += DAY
  t.gw.tick()
  // 1.7.1: срок вышел — не выход, а только просмотр: окно узнаёт сразу
  assert.equal(t.events.filter((e) => e.type === 'suspended').length, 0)
  const stop = t.events.filter((e) => e.type === 'licence')
  assert.equal(stop.length, 1)
  assert.equal(stop[0].payload.canWrite, false)
  const no = await sell()
  assert.equal(no.status, 403)
  assert.equal(no.data.message, MESSAGES.licExpired)
  const me = await t.req('GET', '/auth/me')
  assert.equal(me.status, 200, 'вход остаётся: смотреть можно')
  assert.deepEqual([me.data.subscription.canWrite, me.data.subscription.readOnly], [false, true])
  assert.equal((await t.req('GET', '/products')).status, 200, 'товары видны')
  assert.equal((await t.req('GET', '/sales?days=30')).status, 200, 'отчёты видны')
  assert.equal((await t.req('POST', '/products', { name: 'Перец', price: 1, cost: 1 })).status, 403, 'менять нельзя')
  // Старый (более ранний) код не принимается; новый — работа сразу
  assert.match(t.gw.standalone.activate(t.code({ until: today + 5 })).error, /уже прошёл|более поздним/)
  assert.equal(t.gw.standalone.activate(t.code({ until: FOREVER, serial: 2 })).ok, true)
  assert.equal(t.events.filter((e) => e.type === 'licence').length, 2)
  assert.equal(t.events.filter((e) => e.type === 'licence').pop().payload.canWrite, true)
  assert.equal((await sell()).status, 201)
  assert.equal(t.gw.status().activation.forever, true)
  assert.deepEqual(t.net, [])
})

test('код с тем же сроком: новее тот, что выдан позже — прежний не возвращает кассы', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  t.gw.standalone.chooseMode('standalone')
  const until = todayDay(t.time.now) + 100
  assert.equal(t.gw.standalone.activate(t.code({ until, registers: 3, serial: 5 })).ok, true)
  // Поставщик уменьшил число касс тем же сроком — новый код (номер больше) принимается
  const down = t.gw.standalone.activate(t.code({ until, registers: 1, serial: 9 }))
  assert.equal(down.ok, true)
  assert.equal(down.activation.registers, 1)
  // Прежний код с тем же сроком — отказ; тот же код ещё раз — можно
  assert.equal(t.gw.standalone.activate(t.code({ until, registers: 3, serial: 5 })).error, 'Этот код выдан раньше уже введённого — введите последний выданный код.')
  assert.equal(t.gw.standalone.activate(t.code({ until, registers: 1, serial: 9 })).ok, true)
  assert.equal(t.gw.standalone.info().activation.registers, 1)
  // Более поздний срок — принимается при любом номере
  assert.equal(t.gw.standalone.activate(t.code({ until: until + 30, registers: 2, serial: 2 })).ok, true)
})

test('старые служебные журналы убираются, документы — никогда', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const p = (await t.req('POST', '/products', { name: 'Мыло', barcode: '4600000000501', price: 5, cost: 3, stock: 9 })).data
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  const db = t.db()
  assert.ok(q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'done'").get().n > 0)
  t.time.now += 60 * DAY
  t.gw.tick()
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'done'").get().n, 0)
  assert.equal(q(db, 'SELECT COUNT(*) AS n FROM stock_moves').get().n, 0)
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 1, 'чек пропал вместе с журналом')
  // Остаток после уборки и пересборки — прежний
  const before = stateOf(db)
  rebuildStock(db)
  assert.deepEqual(stateOf(db), before)
})

// ── Магазин переехал: старый компьютер сломался, копия с флешки — на новый ──
// Шифрование Windows у каждого компьютера своё: отпечаток пароля, зашифрованный на старом, на
// новом не открыть. На новом магазин заводят заново (свой код, свой владелец и пароль) и
// загружают копию — как это делает программа (restore.mjs) — и смотрят, кто как входит
const sealOf = (tag) => ({
  seal: (text) => tag + ':' + Buffer.from(text).toString('base64'),
  open: (stored) => {
    if (!String(stored).startsWith(tag + ':')) throw new Error('не расшифровалось')
    return Buffer.from(String(stored).slice(tag.length + 1), 'base64').toString()
  },
})

async function moveShop({ newLogin = OWNER, newPass = 'Novyi-komp-1', coOwner = false } = {}) {
  // ── Старый компьютер: магазин, кассир, чек, владелец сменил пароль ──
  const a = setup({ machine: 'aaaaaaaa-0000-4000-8000-00000000000a', cipher: sealOf('A') })
  a.gw.standalone.chooseMode('standalone')
  assert.equal(a.gw.standalone.activate(a.code()).ok, true)
  await a.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: PASS })
  assert.equal((await a.login()).status, 201)
  await a.req('POST', '/shifts/open', { openingCash: 100 })
  const p = (await a.req('POST', '/products', { name: 'Сахар', barcode: '4600000000601', price: 12, cost: 10, stock: 20 })).data
  const sale = (await a.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })).data
  assert.equal((await a.req('POST', '/users', { name: 'kassir1', password: 'Kassir-pass-1' })).status, 201)
  // Второй владелец (совладелец) — для проверки «в копии несколько владельцев»
  const f2 = coOwner ? await a.req('POST', '/users', { name: 'f2', password: 'Sovladelec-1', roleId: 'owner' }) : null
  if (coOwner) assert.equal(f2.status, 201, JSON.stringify(f2.data))
  assert.equal((await a.req('POST', '/auth/change-password', { oldPassword: PASS, newPassword: 'Stary-pass-2' })).status, 201)
  const ownerA = (await a.req('GET', '/auth/me')).data
  // Копия: база магазина и общая база (как «Сохранить копию в…»)
  const copy = fs.mkdtempSync(join(os.tmpdir(), 'finmax-fleshka-'))
  fs.writeFileSync(join(copy, 'core.db'), a.core.serialize())
  a.gw.close()
  fs.copyFileSync(join(a.dataDir, 'pharmacy-local.db'), join(copy, 'pharmacy-local.db'))

  // ── Новый компьютер: свой код активации, магазин заводят заново ──
  const dirB = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-b-'))
  const machineB = 'bbbbbbbb-0000-4000-8000-00000000000b'
  let coreB = openDb(join(dirB, 'core.db'), CORE_SCHEMA)
  let b = setup({ machine: machineB, cipher: sealOf('B'), core: coreB, dataDir: dirB })
  b.gw.standalone.chooseMode('standalone')
  assert.equal(b.gw.standalone.activate(b.code()).ok, true)
  assert.equal((await b.gw.standalone.setupShop({ shopName: 'Новый магазин', login: newLogin, password: newPass })).ok, true)
  assert.equal((await b.login(newLogin, newPass)).status, 201)
  b.gw.logout()
  b.gw.close()
  coreB.close()
  // «Загрузить копию»: просьба, перезапуск, загрузка — как в программе
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-ud-'))
  requestRestore({ userData, fs, Database, folder: copy, shopFile: 'pharmacy-local.db', foreign: true, at: NOW, now: () => NOW })
  const done = applyRestore({ userData, dataDir: dirB, fs, Database, now: () => NOW + 60000, schemaMax: PHARMACY_SCHEMA.length })
  assert.equal(done.ok, true, JSON.stringify(done))
  coreB = openDb(join(dirB, 'core.db'), CORE_SCHEMA)
  b = setup({ machine: machineB, cipher: sealOf('B'), core: coreB, dataDir: dirB })
  return { b, ownerA, sale, p, coreB, newPass, f2: f2?.data || null }
}

test('магазин переехал на новый компьютер: владелец входит паролем нового компьютера, кассиру пароль задаёт владелец', async (tt) => {
  const { b, ownerA, sale, p, coreB, newPass } = await moveShop()
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  // Пароль со старого компьютера здесь не годится (его отпечаток здесь не открыть)
  assert.equal((await b.login(OWNER, 'Stary-pass-2')).data.message, MESSAGES.wrongLogin)
  const r = await b.login(OWNER, newPass)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  // Владелец — тот же, что в копии: одна учётная запись, название магазина — из копии
  assert.equal(r.data.user.id, ownerA.id)
  assert.equal(r.data.user.pharmacy.name, 'Магазин у дома')
  const users = (await b.req('GET', '/users')).data
  assert.deepEqual(users.map((u) => [u.name, u.roleId === 'owner']).sort(), [['farrukh', true], ['kassir1', false]])
  assert.equal(q(coreB, "SELECT COUNT(*) AS n FROM accounts WHERE role = 'founder'").get().n, 1)
  // Данные — из копии
  assert.equal((await b.req('GET', '/products')).data.find((x) => x.id === p.id).stock, 18)
  assert.ok((await b.req('GET', '/sales?days=0')).data.some((s) => s.id === sale.id))
  // Кассир: пароль остался на старом компьютере — понятный ответ, а не «неверный пароль»
  b.gw.logout()
  assert.equal((await b.login('kassir1', 'Kassir-pass-1')).data.message, MESSAGES.noPasswordHere)
  assert.equal((await b.login(OWNER, newPass)).status, 201)
  const kassir = users.find((u) => u.name === 'kassir1')
  const setPw = await b.req('PATCH', `/users/${kassir.id}`, { password: 'Kassir-novyi-2' })
  assert.equal(setPw.status, 200, JSON.stringify(setPw.data))
  // Правка сотрудников не убирает вход владельца (раньше логин владельца «занимал» владелец из копии)
  b.gw.logout()
  assert.equal((await b.login('kassir1', 'Kassir-novyi-2')).status, 201)
  b.gw.logout()
  assert.equal((await b.login(OWNER, newPass)).status, 201)
  // Свой пароль владелец меняет как обычно; новый чек подписан им
  assert.equal((await b.req('POST', '/auth/change-password', { oldPassword: newPass, newPassword: 'Novyi-komp-2' })).status, 201)
  b.gw.logout()
  assert.equal((await b.login(OWNER, 'Novyi-komp-2')).status, 201)
  await b.req('POST', '/shifts/open', { openingCash: 0 })
  const s2 = await b.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  assert.equal(s2.status, 201, JSON.stringify(s2.data))
  const staffOwner = q(b.db(), 'SELECT userId FROM team_accounts WHERE id = ?').get(ownerA.id).userId
  assert.equal(q(coreB, 'SELECT tenantUserId FROM accounts WHERE id = ?').get(ownerA.id).tenantUserId, staffOwner)
  assert.deepEqual(b.net, [])
})

test('магазин переехал: на новом компьютере владелец завёл другой логин — входит им', async (tt) => {
  const { b, ownerA, coreB } = await moveShop({ newLogin: 'yangi', newPass: 'Yangi-pass-1' })
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  // Чужой пароль у логина этого компьютера — отказ, и вход никому не переходит
  assert.equal((await b.login('yangi', 'Stary-pass-2')).status, 401)
  const r = await b.login('yangi', 'Yangi-pass-1')
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.user.id, ownerA.id)
  // В «Сотрудниках» владелец — под логином этого компьютера; правка сотрудников его не трогает
  const users = (await b.req('GET', '/users')).data
  assert.deepEqual(users.map((u) => u.name).sort(), ['kassir1', 'yangi'])
  const kassir = users.find((u) => u.name === 'kassir1')
  assert.equal((await b.req('PATCH', `/users/${kassir.id}`, { password: 'Kassir-novyi-2' })).status, 200)
  b.gw.logout()
  assert.equal((await b.login('yangi', 'Yangi-pass-1')).status, 201)
  b.gw.logout()
  // Логина из копии больше нет — он стал логином этого компьютера
  assert.equal((await b.login(OWNER, 'Yangi-pass-1')).status, 401)
})

test('магазин переехал: владелец вошёл прежним логином из копии и паролем нового компьютера', async (tt) => {
  const { b, ownerA, coreB } = await moveShop({ newLogin: 'yangi', newPass: 'Yangi-pass-1' })
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  const r = await b.login(OWNER, 'Yangi-pass-1')
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.user.id, ownerA.id)
  assert.deepEqual((await b.req('GET', '/users')).data.map((u) => u.name).sort(), [OWNER, 'kassir1'])
  b.gw.logout()
  assert.equal((await b.login('yangi', 'Yangi-pass-1')).status, 401)
  assert.equal((await b.login(OWNER, 'Yangi-pass-1')).status, 201)
})

test('магазин переехал, а пароль нового компьютера забыт: код сброса — до первого входа', async (tt) => {
  const { b, ownerA, coreB } = await moveShop()
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  const reset = issueCode(KEYS.privateKey, b.pc, { kind: 'reset', until: todayDay(b.time.now) + 2, serial: 900, registers: 0 })
  assert.deepEqual(await b.gw.standalone.resetPassword({ code: reset, password: 'Sbros-pass-9' }), { ok: true, login: OWNER })
  const r = await b.login(OWNER, 'Sbros-pass-9')
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.user.id, ownerA.id)
})

test('магазин переехал: логин этого компьютера в копии занят кассиром — сказано, каким логином входить', async (tt) => {
  const { b, ownerA, coreB } = await moveShop({ newLogin: 'kassir1', newPass: 'Novyi-komp-1' })
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  const r = await b.login('kassir1', 'Novyi-komp-1')
  assert.equal(r.status, 401)
  assert.equal(r.data.message, MESSAGES.loginMoved('kassir1', OWNER))
  const ok = await b.login(OWNER, 'Novyi-komp-1')
  assert.equal(ok.status, 201, JSON.stringify(ok.data))
  assert.equal(ok.data.user.id, ownerA.id)
})

test('магазин переехал, в копии два владельца: просим войти логином своего — и вход переходит к нему', async (tt) => {
  const { b, f2, coreB } = await moveShop({ newLogin: 'yangi', newPass: 'Yangi-pass-1', coOwner: true })
  tt.after(() => {
    b.gw.close()
    coreB.close()
  })
  const r = await b.login('yangi', 'Yangi-pass-1')
  assert.equal(r.status, 401)
  assert.equal(r.data.message, MESSAGES.whichOwnerHere([OWNER, 'f2']))
  // Логином совладельца и его прежним паролем (со старого компьютера) — отказ, вход не переходит
  assert.equal((await b.login('f2', 'Sovladelec-1')).status, 401)
  const ok = await b.login('f2', 'Yangi-pass-1')
  assert.equal(ok.status, 201, JSON.stringify(ok.data))
  assert.equal(ok.data.user.id, f2.id)
  // Второй владелец копии — в списке; его пароль задаёт кто-то из владельцев
  assert.deepEqual((await b.req('GET', '/users')).data.map((u) => u.name).sort(), ['f2', OWNER, 'kassir1'])
})

test('загружена своя прежняя копия: сотрудники, заведённые после неё, больше не входят', async (tt) => {
  const t = await shop()
  const made = await t.req('POST', '/users', { name: 'kassir1', password: 'Kassir-pass-1' })
  assert.equal(made.status, 201)
  t.gw.close()
  // Копия «на флешку» — до того, как завели ещё кассира и совладельца
  const copy = fs.mkdtempSync(join(os.tmpdir(), 'finmax-svoya-'))
  fs.copyFileSync(join(t.dataDir, 'pharmacy-local.db'), join(copy, 'pharmacy-local.db'))
  let u = setup({ core: t.core, dataDir: t.dataDir, time: t.time })
  assert.equal((await u.login()).status, 201)
  assert.equal((await u.req('POST', '/users', { name: 'kassir2', password: 'Kassir-pass-2' })).status, 201)
  assert.equal((await u.req('POST', '/users', { name: 'f2', password: 'Sovladelec-1', roleId: 'owner' })).status, 201)
  u.gw.logout()
  assert.equal((await u.login('kassir2', 'Kassir-pass-2')).status, 201)
  u.gw.logout()
  u.gw.close()
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-ud-'))
  requestRestore({ userData, fs, Database, folder: copy, shopFile: 'pharmacy-local.db', foreign: false, at: NOW, now: () => NOW })
  assert.equal(applyRestore({ userData, dataDir: t.dataDir, fs, Database, now: () => NOW + 60000, schemaMax: PHARMACY_SCHEMA.length }).ok, true)
  u = setup({ core: t.core, dataDir: t.dataDir, time: t.time })
  tt.after(() => u.gw.close())
  assert.equal((await u.login('kassir2', 'Kassir-pass-2')).status, 401)
  assert.equal((await u.login('f2', 'Sovladelec-1')).status, 401)
  assert.equal(q(t.core, "SELECT COUNT(*) AS n FROM accounts WHERE login IN ('kassir2', 'f2')").get().n, 0)
  assert.equal((await u.login('kassir1', 'Kassir-pass-1')).status, 201)
  u.gw.logout()
  assert.equal((await u.login()).status, 201)
  assert.deepEqual((await u.req('GET', '/users')).data.map((x) => x.name).sort(), [OWNER, 'kassir1'])
})

test('общая база потерялась, база магазина цела: новый код, «Забыли пароль?» — и владелец снова входит', async (tt) => {
  const t = await shop()
  const owner = (await t.req('GET', '/auth/me')).data
  const p = (await t.req('POST', '/products', { name: 'Чай', barcode: '4600000000701', price: 9, cost: 6, stock: 7 })).data
  t.gw.close()
  // Общая база начата заново (повреждена, копии не было)
  const core2 = openDb(':memory:', CORE_SCHEMA)
  const t2 = setup({ core: core2, dataDir: t.dataDir, time: t.time })
  tt.after(() => t2.gw.close())
  assert.equal(t2.gw.standalone.info().mode, '')
  t2.gw.standalone.chooseMode('standalone')
  assert.equal(t2.gw.standalone.activate(t2.code({ serial: 3 })).ok, true)
  // Магазин на компьютере есть — заводить второй нельзя, а вход по прежнему паролю не по чему
  assert.equal(t2.gw.standalone.info().shop, true)
  assert.equal((await t2.gw.standalone.setupShop({ shopName: 'Новый', login: 'x', password: 'Parol-888' })).error, MESSAGES.shopExists)
  assert.equal((await t2.login()).data.message, MESSAGES.noOwnerPasswordHere)
  const reset = issueCode(KEYS.privateKey, t2.pc, { kind: 'reset', until: todayDay(t2.time.now) + 2, serial: 555, registers: 0 })
  assert.deepEqual(await t2.gw.standalone.resetPassword({ code: reset, password: 'Sbros-pass-7' }), { ok: true, login: OWNER })
  const r = await t2.login(OWNER, 'Sbros-pass-7')
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.user.id, owner.id)
  assert.equal((await t2.req('GET', '/products')).data.find((x) => x.id === p.id).stock, 7)
})

test('часы назад при стёртой записи о времени: срок не раньше последнего документа магазина', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  t.gw.standalone.chooseMode('standalone')
  const today = todayDay(t.time.now)
  assert.equal(t.gw.standalone.activate(t.code({ until: today + 10 })).ok, true)
  await t.gw.standalone.setupShop({ shopName: 'Магазин', login: OWNER, password: PASS })
  await t.login()
  await t.req('POST', '/shifts/open', { openingCash: 0 })
  const p = (await t.req('POST', '/products', { name: 'Соль', barcode: '4600000000801', price: 5, cost: 3, stock: 50 })).data
  t.time.now += 8 * DAY
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  assert.equal(t.gw.standalone.info().activation.daysLeft, 3)
  // Запись о прожитом времени стёрли, часы перевели на неделю назад
  q(t.core, 'DELETE FROM licences').run()
  q(t.core, "DELETE FROM meta WHERE key = 'clock'").run()
  t.time.now -= 7 * DAY
  // Срок — не раньше последнего чека: осталось те же 3 дня, а не 10
  assert.equal(t.gw.standalone.info().activation.daysLeft, 3)
  // Запись есть — даты документов на срок не влияют (сбитые вперёд часы не крадут дни)
  const fresh = setup()
  tt.after(() => fresh.gw.close())
  fresh.gw.standalone.chooseMode('standalone')
  assert.equal(fresh.gw.standalone.activate(fresh.code({ until: todayDay(fresh.time.now) + 10 })).ok, true)
  assert.equal(fresh.gw.standalone.info().activation.daysLeft, 11)
})

test('правки остатка остаются в истории товара и после уборки журналов', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const p = (await t.req('POST', '/products', { name: 'Мука', barcode: '4600000000901', price: 20, cost: 15, stock: 10 })).data
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })
  assert.equal((await t.req('PATCH', `/products/${p.id}`, { stock: 20 })).status, 200)
  await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  const before = (await t.req('GET', `/products/${p.id}/history`)).data
  t.time.now += 60 * DAY
  t.gw.tick()
  const after = (await t.req('GET', `/products/${p.id}/history`)).data
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)), 'история товара изменилась после уборки журналов')
  assert.ok(q(t.db(), "SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'count'").get().n >= 1)
})

test('код магазина без интернета сервер другим магазинам не выдаёт', () => {
  const src = fs.readFileSync(new URL('../../server/src/admin/pharmacies.service.ts', import.meta.url), 'utf8')
  const m = /RESERVED_CODES = new Set\(\[([^\]]*)\]\)/.exec(src)
  assert.ok(m, 'нет RESERVED_CODES в server/src/admin/pharmacies.service.ts')
  assert.ok(m[1].includes("'local'"))
})

test('права и роли — те же, что на сервере', () => {
  const src = fs.readFileSync(new URL('../../server/src/auth/permissions.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('PERMISSION_GROUPS'), src.indexOf('export const ALL_PERMISSIONS'))
  const server = [...body.matchAll(/\[\s*'([a-zA-Z.]+)'\s*,/g)].map((m) => m[1])
  assert.deepEqual(ALL_PERMISSIONS, server)
})

test('выпуск кодов в проверках — тот же расчёт, что у сервера', () => {
  const V = JSON.parse(fs.readFileSync(new URL('./licence-vectors.json', import.meta.url), 'utf8'))
  const privateKey = '2f6d0b9a8c7e5d4f3a2b1c0d9e8f7a6b'
  const pc = computerRawOf('C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F')
  assert.equal(publicOf(privateKey), V.publicKey)
  assert.equal(issueCode(privateKey, pc, { kind: 'activate', until: dayOf('2027-11-01'), registers: 2, serial: 7 }), V.code)
  assert.equal(issueCode(privateKey, pc, { kind: 'reset', until: dayOf('2026-11-03'), registers: 0, serial: 4242 }), V.reset)
})

// ── 1.7.0: все магазины без интернета, без кода активации ──

test('1.7.0: первый запуск — без выбора способа работы и без кода: магазин, вход, продажа, ни одного обращения к сети', async (tt) => {
  const t = setup({ requireCode: false, offlineOnly: true })
  tt.after(() => t.gw.close())
  const info = t.gw.standalone.info()
  assert.equal(info.mode, 'standalone', 'способ работы задан сам')
  assert.equal(info.offlineOnly, true)
  assert.equal(info.codeRequired, false)
  assert.equal(info.activation.active, true)
  assert.equal(info.activation.forever, true)
  assert.equal(info.shop, false)
  // Другого способа работы нет
  assert.ok(t.gw.standalone.chooseMode('cloud').error)
  // Магазин — без кода
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: PASS })).ok, true)
  assert.equal((await t.login()).status, 201)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const p = (await t.req('POST', '/products', { name: 'Соль', barcode: '4600000000401', price: 5, cost: 3, stock: 50 })).data
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })).status, 201)
  // Срока нет: и через три года всё работает
  t.time.now += 3 * 365 * DAY
  t.gw.tick()
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  assert.equal(t.events.filter((e) => e.type === 'suspended').length, 0)
  assert.equal(t.gw.status().activation?.free ?? true, true)
  assert.deepEqual(t.net, [], 'ни одного обращения к сети')
})

test('1.7.0: компьютер, работавший с сервером, переходит на работу без интернета — входы магазина сервера убираются', async (tt) => {
  const core = openDb(':memory:', CORE_SCHEMA)
  // Как было у тестового магазина с сервером: способ работы «с интернетом», вход кассира
  q(core, "INSERT INTO meta (key, value) VALUES ('appMode', 'cloud')").run()
  q(
    core,
    `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, seenAt, permissions, roleName, roleSystem)
     VALUES ('acc-test', 'test', 'founder', 'shifo', 'Шифо', 'dpapi:x', 'active', NULL, '2026-11-01T00:00:00.000Z', '', 'Владелец', 'owner')`,
  ).run()
  const t = setup({ core, requireCode: false, offlineOnly: true })
  tt.after(() => t.gw.close())
  assert.equal(q(core, "SELECT COUNT(*) AS n FROM accounts WHERE pharmacyCode <> 'local'").get().n, 0, 'вход магазина сервера убран')
  const info = t.gw.standalone.info()
  assert.equal(info.mode, 'standalone')
  assert.equal(info.shop, false, 'магазин заводится заново')
  // Тот же логин теперь свободен
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Шифо', login: 'test', password: PASS })).ok, true)
  assert.equal((await t.login('test', PASS)).status, 201)
  assert.deepEqual(t.net, [])
})

test('1.7.0: без кода активации сброс пароля владельца кодом сброса работает', async (tt) => {
  const t = setup({ requireCode: false, offlineOnly: true })
  tt.after(() => t.gw.close())
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Магазин', login: OWNER, password: PASS })).ok, true)
  const reset = issueCode(KEYS.privateKey, t.pc, { kind: 'reset', until: todayDay(t.time.now) + 3, registers: 1, serial: 7 })
  assert.equal((await t.gw.standalone.resetPassword({ code: reset, password: 'novyy-parol-1' })).ok, true)
  assert.equal((await t.login(OWNER, 'novyy-parol-1')).status, 201)
  assert.deepEqual(t.net, [])
})


test('1.7.0: логотип магазина ставят в программе — чек, лента и экран покупателя берут его у кассы', async (tt) => {
  const t = setup({ requireCode: false, offlineOnly: true })
  tt.after(() => t.gw.close())
  assert.equal((await t.gw.standalone.setupShop({ shopName: 'Магазин', login: OWNER, password: PASS })).ok, true)
  assert.equal((await t.login()).status, 201)
  t.gw.listen(true)
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  assert.deepEqual((await t.req('GET', '/shop/logo')).data, { logo: '', at: null })
  const set = await t.req('POST', '/shop/logo', { logo: PNG })
  assert.equal(set.status, 200)
  assert.equal(set.data.logo, PNG)
  assert.equal((await t.req('GET', '/shop/logo')).data.logo, PNG)
  assert.equal(t.gw.shopLogo(), PNG, 'лента и экран покупателя берут его у кассы')
  assert.ok(t.events.some((e) => e.type === 'changed' && e.payload.includes('shop')), 'окно узнаёт сразу')
  // Не картинка — отказ, прежний логотип на месте
  const bad = await t.req('POST', '/shop/logo', { logo: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })
  assert.equal(bad.status, 400)
  assert.equal((await t.req('GET', '/shop/logo')).data.logo, PNG)
  // Убрать
  assert.equal((await t.req('POST', '/shop/logo', { logo: '' })).data.logo, '')
  assert.equal(t.gw.shopLogo(), '')
  assert.deepEqual(t.net, [])
})
