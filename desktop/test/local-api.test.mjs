// ── Локальный сервер магазина и учётные записи ──
//
// Что касса отвечает сама, а за чем идёт на сервер; кому что разрешено; как долго
// закрыт вход после подбора пароля. Всё это — граница между «работает без
// интернета» и «небезопасно», поэтому проверяется отдельно от операций.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  accountById,
  accountByLogin,
  checkVerifier,
  deviceIdOf,
  dropVerifier,
  makeVerifier,
  offlineLogin,
  saveAccount,
  setSubscription,
  subscriptionOf,
  throttle,
  userView,
} from '../src/local/accounts.mjs'
import { matchFallback, matchLocal, parseQuery, pendingInPeriod, periodOf } from '../src/local/api.mjs'
import { ApiError, openDb } from '../src/local/db.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { CORE_SCHEMA, PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applySnapshot, tenantUserOf } from '../src/local/snapshot.mjs'
import { ctx, DAY, NOW, pharmacy, product } from '../test-support/pharmacy.mjs'

// ── Что касса отвечает сама ──

test('касса отвечает сама ровно на то, что умеет без интернета', () => {
  const local = [
    ['GET', '/products'],
    ['GET', '/products/barcode/4600000000017'],
    ['GET', '/categories'],
    ['GET', '/customers'],
    ['GET', '/deferred'],
    ['GET', '/shifts'],
    ['GET', '/sales?days=60'],
    ['GET', '/returns'],
    ['GET', '/arrivals?days=180'],
    ['GET', '/supplier-returns?days=180'],
    ['GET', '/writeoffs'],
    ['GET', '/payments'],
    ['GET', '/expenses?days=180'],
    ['GET', '/expenses/cash-sources'],
    ['GET', '/expense-categories'],
    ['GET', '/suppliers'],
    ['GET', '/supplier-payments'],
    ['GET', '/pay-services'],
    ['GET', '/cash-moves?days=180'],
    ['GET', '/shifts/cash-sources'],
    ['POST', '/shifts/cash'],
    ['POST', '/expenses'],
    ['POST', '/sales'],
    ['POST', '/returns'],
    ['POST', '/arrivals'],
    ['POST', '/supplier-returns'],
    ['POST', '/writeoffs'],
    ['POST', '/shifts/open'],
    ['POST', '/shifts/close'],
    ['POST', '/customers'],
    ['POST', '/customers/abc/pay'],
    ['POST', '/deferred'],
    ['DELETE', '/deferred/abc'],
    // С версии 1.4.14 — и справочники, и правка документов
    ['POST', '/products'],
    ['PATCH', '/products/abc'],
    ['DELETE', '/products/abc'],
    ['POST', '/categories'],
    ['PATCH', '/categories/abc'],
    ['DELETE', '/categories/abc'],
    ['POST', '/product-types'],
    ['PATCH', '/product-types/abc'],
    ['DELETE', '/product-types/abc'],
    ['POST', '/pay-services'],
    ['DELETE', '/pay-services/abc'],
    ['POST', '/expense-categories'],
    ['DELETE', '/expense-categories/abc'],
    ['POST', '/income-categories'],
    ['DELETE', '/income-categories/abc'],
    ['POST', '/suppliers'],
    ['PATCH', '/suppliers/abc'],
    ['DELETE', '/suppliers/abc'],
    ['POST', '/suppliers/abc/pay'],
    ['DELETE', '/supplier-payments/abc'],
    ['DELETE', '/supplier-returns/abc'],
    ['PATCH', '/expenses/abc'],
    ['DELETE', '/expenses/abc'],
    ['PATCH', '/incomes/abc'],
    ['DELETE', '/incomes/abc'],
    ['DELETE', '/cash-moves/abc'],
    ['GET', '/arrivals/abc'],
    ['PATCH', '/arrivals/abc'],
    ['DELETE', '/arrivals/abc'],
  ]
  for (const [method, path] of local) assert.ok(matchLocal(method, path), `${method} ${path} должен обслуживаться локально`)

  // Сначала сервер, без связи — касса: история товара и карточка поставщика
  for (const [method, path] of [['GET', '/products/abc/history'], ['GET', '/suppliers/abc']]) {
    assert.equal(matchLocal(method, path), null, `${method} ${path} — сначала сервер`)
    assert.ok(matchFallback(method, path), `${method} ${path} без связи отвечает касса`)
  }

  // Всё остальное — дело сервера: сотрудники и роли, пересчёт, резервная копия,
  // удаление клиента, панель владельца сервиса
  const remote = [
    ['GET', '/users'],
    ['POST', '/users'],
    ['GET', '/discrepancies'],
    ['POST', '/products/p1/merge'],
    ['GET', '/backup'],
    ['POST', '/backup/restore'],
    ['DELETE', '/customers/abc'],
    ['GET', '/admin/pharmacies'],
    ['GET', '/auth/me'],
    ['POST', '/auth/login'],
    ['GET', '/'],
    ['GET', '/sales/abc'],
    ['DELETE', '/sales'],
  ]
  for (const [method, path] of remote) {
    assert.equal(matchLocal(method, path), null, `${method} ${path} не должен обслуживаться локально`)
    assert.equal(matchFallback(method, path), null, `${method} ${path} не должен обслуживаться локально`)
  }
})

test('из адреса достаются номер записи и параметры', () => {
  const m = matchLocal('POST', '/customers/%D0%B8%D0%B2%D0%B0%D0%BD/pay?x=1')
  assert.deepEqual(m.params, ['иван'])
  assert.deepEqual(m.query, { x: '1' })
  assert.deepEqual(parseQuery('/sales?from=2026-10-01T00%3A00%3A00.000Z&to=&days=7'), { from: '2026-10-01T00:00:00.000Z', to: '', days: '7' })
  assert.deepEqual(parseQuery('/sales'), {})
})

test('за какой срок просят журнал: недавнее — своё, давнее — на сервере', () => {
  const from = (days) => new Date(NOW - days * DAY).toISOString()
  // Без параметров — срок по умолчанию, тот же, что у сервера
  assert.deepEqual(periodOf('sale', {}, NOW), { deep: false, from: from(60), to: null })
  assert.deepEqual(periodOf('return', {}, NOW), { deep: false, from: from(180), to: null })
  assert.deepEqual(periodOf('sale', { days: '7' }, NOW), { deep: false, from: from(7), to: null })
  assert.deepEqual(periodOf('sale', { days: '60' }, NOW), { deep: false, from: from(60), to: null })
  assert.deepEqual(periodOf('sale', { days: '' }, NOW), { deep: false, from: from(60), to: null })
  assert.deepEqual(periodOf('sale', { days: '2.9' }, NOW), { deep: false, from: from(2), to: null })

  // Глубже, чем лежит на компьютере, — только сервер
  assert.equal(periodOf('sale', { days: '61' }, NOW).deep, true)
  assert.equal(periodOf('payment', { days: '181' }, NOW).deep, true)
  // Ноль и мусор означают «всё время»
  for (const days of ['0', '-5', 'abc']) assert.deepEqual(periodOf('sale', { days }, NOW), { deep: true, from: null, to: null })
  // Отрезок дат — всегда сервер: им спрашивают именно давнее
  assert.deepEqual(periodOf('sale', { from: '2026-01-01T00:00:00.000Z', to: 'мусор' }, NOW), { deep: true, from: '2026-01-01T00:00:00.000Z', to: null })
  assert.deepEqual(periodOf('sale', { to: '2026-01-01T00:00:00.000Z' }, NOW), { deep: true, from: null, to: '2026-01-01T00:00:00.000Z' })
})

test('журнал отдаёт только то, что попадает в срок', () => {
  const db = pharmacy({ products: [product({ id: 'nur', stock: 50 })] })
  const sale = (days) => checkout(ctx(db, { now: NOW - days * DAY }), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const week = sale(6)
  const month = sale(40)
  const run = (path) => matchLocal('GET', path).handler({ db, now: NOW, deviceId: 'kassa-1', user: ctx(db).user, query: parseQuery(path) })
  assert.deepEqual(run('/sales?days=7').map((s) => s.id), [week.id])
  assert.deepEqual(run('/sales?days=60').map((s) => s.id), [week.id, month.id], 'новые сверху')
  assert.deepEqual(run('/sales?days=0'), { __deep: { kind: 'sale', from: null, to: null } })
  // Свои неотправленные за период — их добавляют к ответу сервера
  assert.deepEqual(pendingInPeriod(db, 'sale', { from: new Date(NOW - 10 * DAY).toISOString(), to: null }).map((s) => s.id), [week.id])
  assert.equal(pendingInPeriod(db, 'sale', { from: null, to: null }).length, 2)
})

test('товар по штрихкоду — из локальной базы, с остатком', () => {
  const db = pharmacy({ products: [product({ id: 'nur', barcode: '4600000000017', stock: 3, unitsPerPack: 10, looseUnits: 4 })] })
  const run = (path) => {
    const m = matchLocal('GET', path)
    return m.handler({ db, now: NOW, deviceId: 'kassa-1', user: ctx(db).user, query: m.query, params: m.params })
  }
  const found = run('/products/barcode/4600000000017')
  assert.deepEqual([found.id, found.stock, found.looseUnits], ['nur', 3, 4])
  assert.equal(run('/products/barcode/000'), null)
})

// ── Учётные записи и вход без интернета ──

const user = (over = {}) => ({
  id: 'acc-1',
  name: 'kassir',
  role: 'cashier',
  pharmacy: { code: 'apteka-1', name: 'Магазин №1' },
  subscription: { status: 'active', paidUntil: '2026-11-01T12:00:00.000Z' },
  ...over,
})
const core = () => openDb(':memory:', CORE_SCHEMA)
const open = (stored) => stored

test('отпечаток пароля: проверяется верный, отвергается неверный, сам пароль не хранит', async () => {
  const v = await makeVerifier('sekret-1')
  assert.match(v, /^s3\$16384\$8\$4\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
  assert.equal(v.includes('sekret-1'), false)
  assert.equal(await checkVerifier('sekret-1', v), true)
  assert.equal(await checkVerifier('sekret-2', v), false)
  assert.equal(await checkVerifier('', v), false)
  // Соль своя у каждого: одинаковые пароли дают разные отпечатки
  assert.notEqual(await makeVerifier('sekret-1'), v)
  // Мусор и чужие виды отпечатка — просто «не подошёл», без падения
  for (const bad of ['', null, 'abc', 's3$1$1$1$aa$bb', 's3$999999999$8$4$aa$bb', 's2$16384$aa$bb']) {
    assert.equal(await checkVerifier('sekret-1', bad), false, String(bad))
  }
})

test('сведения о сотруднике обновляются, а отпечаток пароля при этом не теряется', () => {
  const db = core()
  saveAccount(db, user(), { verifier: 'отпечаток', now: NOW })
  assert.equal(accountByLogin(db, 'kassir').verifier, 'отпечаток')
  // «Кто я» приносит свежую роль и подписку, но пароля в нём нет — отпечаток прежний
  saveAccount(db, user({ role: 'founder', subscription: { status: 'trial', paidUntil: '2026-12-01T00:00:00.000Z' } }), { now: NOW + 1000 })
  const acc = accountById(db, 'acc-1')
  assert.deepEqual([acc.role, acc.subStatus, acc.paidUntil, acc.verifier], ['founder', 'trial', '2026-12-01T00:00:00.000Z', 'отпечаток'])
  assert.equal(acc.seenAt, new Date(NOW + 1000).toISOString())
  // Новый вход с паролем — отпечаток заменяется
  saveAccount(db, user(), { verifier: 'новый', now: NOW })
  assert.equal(accountById(db, 'acc-1').verifier, 'новый')
  dropVerifier(db, 'acc-1')
  assert.equal(accountById(db, 'acc-1').verifier, null)
  // Владелец сервиса (без магазина) сюда не записывается
  assert.equal(saveAccount(db, user({ id: 'adm', name: 'admin', pharmacy: null }), { now: NOW }), null)
})

test('логин перешёл к новой учётной записи — прежняя уходит, а не мешает', () => {
  const db = core()
  saveAccount(db, user({ id: 'old' }), { verifier: 'v1', now: NOW })
  // Сотрудника удалили и завели заново под тем же именем
  saveAccount(db, user({ id: 'new' }), { verifier: 'v2', now: NOW })
  assert.equal(accountById(db, 'old'), null)
  assert.equal(accountByLogin(db, 'kassir').id, 'new')
})

test('подписка без связи: предупреждение, пробный период, окончание, приостановка', () => {
  const acc = { paidUntil: '2026-11-01T12:00:00.000Z', subStatus: 'active' }
  const at = (iso) => Date.parse(iso)

  const far = subscriptionOf(acc, at('2026-10-04T10:00:00.000Z'))
  assert.deepEqual([far.status, far.canWrite, far.warn, far.daysLeft, far.message], ['active', true, false, 29, ''])
  assert.deepEqual(Object.keys(far), ['status', 'daysLeft', 'leftMs', 'paidUntil', 'canWrite', 'warn', 'message'])

  const soon = subscriptionOf(acc, at('2026-10-28T10:00:00.000Z'))
  assert.deepEqual([soon.warn, soon.daysLeft, soon.message], [true, 5, 'Подписка заканчивается 01.11.2026 в 17:00.'])

  // Срок — это момент, а не день: за минуту до него ещё работаем
  assert.equal(subscriptionOf(acc, at('2026-11-01T11:59:00.000Z')).canWrite, true)
  const over = subscriptionOf(acc, at('2026-11-01T12:00:00.000Z'))
  assert.deepEqual([over.status, over.canWrite], ['expired', false])
  assert.match(over.message, /^Подписка закончилась 01\.11\.2026 в 17:00\. Данные магазина сохранены/)

  const trial = subscriptionOf({ ...acc, subStatus: 'trial' }, at('2026-10-04T10:00:00.000Z'))
  assert.deepEqual([trial.status, trial.warn, trial.message], ['trial', true, 'Пробный период: осталось 29 дн.'])
  assert.equal(subscriptionOf({ ...acc, subStatus: 'trial' }, at('2026-11-01T00:00:00.000Z')).message, 'Пробный период заканчивается 01.11.2026 в 17:00.')

  const stopped = subscriptionOf({ ...acc, subStatus: 'suspended' }, at('2026-10-04T10:00:00.000Z'))
  assert.deepEqual([stopped.status, stopped.canWrite, stopped.message], ['suspended', false, 'Работа приостановлена. Обратитесь к поставщику программы.'])
  // Сервер сказал «закончилась» — верим ему, даже если по нашим часам ещё рано
  assert.equal(subscriptionOf({ ...acc, subStatus: 'expired' }, at('2026-10-04T10:00:00.000Z')).status, 'expired')
  assert.equal(subscriptionOf({ paidUntil: null }, NOW), null)
})

test('подписка касается всего магазина: продлили — у всех его сотрудников на этом компьютере', () => {
  const db = core()
  saveAccount(db, user({ id: 'a', name: 'kassir' }), { now: NOW })
  saveAccount(db, user({ id: 'b', name: 'vladelec' }), { now: NOW })
  saveAccount(db, user({ id: 'c', name: 'chuzhoj', pharmacy: { code: 'apteka-2', name: 'Вторая' } }), { now: NOW })
  setSubscription(db, 'apteka-1', { status: 'suspended', paidUntil: '2027-01-01T00:00:00.000Z' })
  assert.deepEqual(['a', 'b', 'c'].map((id) => accountById(db, id).subStatus), ['suspended', 'suspended', 'active'])
  // Пусто — «не трогать»
  setSubscription(db, 'apteka-1', { status: 'active' })
  assert.equal(accountById(db, 'a').paidUntil, '2027-01-01T00:00:00.000Z')
  assert.deepEqual(userView(accountById(db, 'a'), NOW).pharmacy, { code: 'apteka-1', name: 'Магазин №1' })
})

test('защита от подбора: минута, пять, пятнадцать — и счёт лежит в базе', () => {
  const db = core()
  let now = NOW
  const fails = (n) => {
    for (let i = 0; i < n; i++) throttle.fail(db, 'k', now)
  }
  fails(4)
  assert.equal(throttle.retryAfterMs(db, 'k', now), 0, 'четыре промаха вход не закрывают')
  fails(1)
  assert.equal(throttle.retryAfterMs(db, 'k', now), 60_000)

  // Вторая серия дороже первой, третья — ещё дороже, дальше по пятнадцать минут
  for (const wait of [5 * 60_000, 15 * 60_000, 15 * 60_000]) {
    now += 16 * 60_000
    assert.equal(throttle.retryAfterMs(db, 'k', now), 0)
    fails(5)
    assert.equal(throttle.retryAfterMs(db, 'k', now), wait)
  }

  // Удачный вход стирает всё, вместе со ступенькой
  throttle.success(db, ['k'])
  fails(5)
  assert.equal(throttle.retryAfterMs(db, 'k', now), 60_000)

  // Час тишины — и ступенька забыта
  now += 61 * 60_000
  assert.equal(throttle.retryAfterMs(db, 'k', now), 0)
  fails(5)
  assert.equal(throttle.retryAfterMs(db, 'k', now), 60_000)
  assert.equal(throttle.humanWait(59_000), '59 сек.')
  assert.equal(throttle.humanWait(61_000), '2 мин.')
})

test('вход без интернета: промахи считаются и по имени, и по компьютеру', async () => {
  const db = core()
  const verifier = await makeVerifier('sekret-1')
  saveAccount(db, user({ id: 'a', name: 'Kassir' }), { verifier, now: NOW })
  saveAccount(db, user({ id: 'b', name: 'vladelec' }), { verifier, now: NOW })
  const attempt = (name, password, now = NOW) => offlineLogin(db, { name, password }, { now, open })
  const status = async (p) => p.then(() => 200, (e) => (e instanceof ApiError ? e.status : 0))

  // Логин — как на сервере: с учётом регистра, пробелы по краям не в счёт
  assert.equal((await attempt('  Kassir ', 'sekret-1')).id, 'a')
  assert.equal(await status(attempt('kassir', 'sekret-1')), 503)

  // Перебор паролей вперемешку по разным именам закрывает вход с компьютера целиком
  for (const name of ['Kassir', 'vladelec', 'Kassir', 'vladelec', 'Kassir']) assert.equal(await status(attempt(name, 'промах')), 401)
  await assert.rejects(attempt('vladelec', 'sekret-1'), (e) => e.status === 429 && e.message === 'Слишком много неудачных попыток. Вход с этого устройства закрыт на 1 мин.')
  // Имя, под которым ещё не входили, счёт не увеличивает — перебирать там нечего
  assert.equal(await status(attempt('неизвестный', 'x', NOW + 61_000)), 503)
  assert.equal((await attempt('vladelec', 'sekret-1', NOW + 61_000)).id, 'b')
})

// ── Мелочи, на которых держится остальное ──

test('номер кассы создаётся один раз и не меняется', () => {
  const db = core()
  const id = deviceIdOf(db)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(deviceIdOf(db), id)
})

test('сотрудник магазина узнаётся по документам, которые он уже оформлял', () => {
  const db = openDb(':memory:', PHARMACY_SCHEMA)
  assert.equal(tenantUserOf(db, 'kassir'), null)
  applySnapshot(
    db,
    {
      sales: [
        { id: 's1', date: '2026-10-01T00:00:00.000Z', total: 1, items: [], user: { id: 'tenant-7', name: 'kassir' } },
        { id: 's2', date: '2026-10-02T00:00:00.000Z', total: 1, items: [], user: { id: 'tenant-9', name: 'drugoj' } },
        { id: 's3', date: '2026-10-03T00:00:00.000Z', total: 1, items: [], user: null },
      ],
    },
    { now: NOW },
  )
  assert.equal(tenantUserOf(db, 'kassir'), 'tenant-7')
  assert.equal(tenantUserOf(db, 'drugoj'), 'tenant-9')
  assert.equal(tenantUserOf(db, 'никто'), null)
})

test('схема базы: новые шаги доезжают до старой базы, а база новее программы не открывается', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'apteka-db-')), 'p.db')
  const v1 = ['CREATE TABLE a (x TEXT)']
  const v2 = [...v1, 'ALTER TABLE a ADD COLUMN y TEXT']

  // Первая версия программы создала базу и записала данные
  let db = openDb(file, v1)
  db.prepare("INSERT INTO a (x) VALUES ('чек')").run()
  db.close()

  // Обновление программы: проходит только недостающий шаг, данные на месте
  db = openDb(file, v2)
  assert.deepEqual(db.prepare('SELECT x, y FROM a').all(), [{ x: 'чек', y: null }])
  db.close()
  // Повторный запуск той же версии ничего не выполняет заново
  assert.doesNotThrow(() => openDb(file, v2).close())

  // Поверх новой версии поставили старую: с незнакомой базой она работать не должна
  assert.throws(() => openDb(file, v1), /более новой версией программы/)
})

test('запись на диск настроена на сохранность: журнал WAL и полная синхронизация', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'apteka-db-')), 'p.db')
  const db = openDb(file, PHARMACY_SCHEMA)
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  // 2 = FULL: записанный чек переживает отключение питания
  assert.equal(db.pragma('synchronous', { simple: true }), 2)
  db.close()
})
