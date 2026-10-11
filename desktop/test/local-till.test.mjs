// ── Поставщики, наличные в смене и переводы без интернета ──
//
// Версия 1.0.2 добавила кассе три вещи, которые должны работать и без связи:
//   • приход в долг поставщику, которого касса уже знает;
//   • внесение и изъятие наличных в своей смене;
//   • оплата переводом (Alif, DC, Эсхата…) с указанием сервиса — в чеке, возврате и смене.
// Самое тонкое здесь то же, что у расходов из кассы: сумма не должна ни потеряться,
// ни посчитаться дважды, пока операция идёт на сервер, когда он её принял и когда
// его копия пришла обратно. Долг поставщика при этом складывается из того, что
// сказал сервер, и того, что касса ему ещё только отправит.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { matchLocal } from '../src/local/api.mjs'
import { getMeta, openDb, setMeta } from '../src/local/db.mjs'
import { listDocs, listShifts, myOpenShift } from '../src/local/docs.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { cashMovesOf, createCashMove, NO_OPEN_SHIFT_CASH } from '../src/local/ops/cash.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift, shiftView } from '../src/local/ops/shift.mjs'
import { ackOp, describeOp, pendingOps, rejectedOps, rejectOp, touchedBy } from '../src/local/outbox.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { payServicesList, suppliersList } from '../src/local/suppliers.mjs'
import { ctx, NOW, PAY_SERVICES, pharmacy, product, refused, row, rows, SUPPLIERS } from '../test-support/pharmacy.mjs'

const iso = (t) => new Date(t).toISOString()
const apteka = () => pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
const ops = (db) => pendingOps(db, 100)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const up = (...list) => ({ upsert: list, remove: [] })
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
const CASHIER = { accountId: 'acc-2', id: 'user-2', name: 'nilufar', role: 'cashier' }
const EXP = '2028-01-31'
// Внесено и изъято за открытую смену — как это видит окно на странице смены
const till = (db, deviceId = 'kassa-1') => {
  const s = shiftView(db, listShifts(db, deviceId).find((x) => !x.closedAt))
  return [s.cashIn, s.cashOut]
}
const debtOf = (db, id) => suppliersList(db, true).find((s) => s.id === id).debt
// Смена, о которой сервер уже знает
function openedShift(db, openingCash = 100) {
  const shift = openShift(ctx(db), { openingCash })
  ackOp(db, opOf(db, 'shift.open'))
  return shift
}

// ── Внесение и изъятие ──

test('внесение и изъятие без связи: ложатся в смену этой кассы, встают в очередь, «ожидается в кассе» меняется сразу', () => {
  const db = apteka()
  const c = ctx(db)
  // Смены нет — внести или изъять не из чего
  refused(() => createCashMove(c, { kind: 'in', amount: 10 }), 400, NO_OPEN_SHIFT_CASH)
  const shift = openShift(c, { openingCash: 100 })
  assert.deepEqual(till(db), [0, 0])

  const m = createCashMove({ ...c, now: NOW + 60000 }, { kind: 'in', amount: 200.456, note: '  размен ', clientId: 'cm_1' })
  assert.deepEqual(m, {
    id: m.id,
    clientId: 'cm_1',
    shiftId: shift.id,
    kind: 'in',
    amount: 200.46,
    note: 'размен',
    userId: 'user-1',
    date: iso(NOW + 60000),
    createdAt: iso(NOW + 60000),
    user: { id: 'user-1', name: 'kassir' },
  })
  assert.deepEqual(listDocs(db, 'cashmove'), [m])
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'cashmove'").sync, 'pending')
  const op = opOf(db, 'cash.move')
  assert.equal(op.accountId, 'acc-1')
  // Серверу — только сама операция: кто её сделал, он знает по учётной записи
  assert.deepEqual(op.payload, {
    move: { id: m.id, shiftId: shift.id, kind: 'in', amount: 200.46, note: 'размен', date: iso(NOW + 60000) },
    deviceId: 'kassa-1',
  })
  // Окно переиграло запрос после заминки — второй записи нет
  assert.equal(createCashMove(c, { kind: 'in', amount: 200.456, clientId: 'cm_1' }).id, m.id)
  assert.equal(listDocs(db, 'cashmove').length, 1)
  assert.deepEqual(ops(db).map((o) => o.type), ['shift.open', 'cash.move'])

  createCashMove(c, { kind: 'out', amount: 50, note: 'владельцу' })
  assert.deepEqual(till(db), [200.46, 50])
  const { cashIn, cashOut } = cashMovesOf(db, shift.id)
  assert.deepEqual([cashIn.toNumber(), cashOut.toNumber()], [200.46, 50])

  // Отказы — словами, без следов в базе
  refused(() => createCashMove(c, { kind: 'x', amount: 10 }), 400, 'Вид операции: допустимо только — in, out')
  refused(() => createCashMove(c, { kind: 'in', amount: 0 }), 400, 'Сумма: не меньше 0.01')
  refused(() => createCashMove(c, { kind: 'in', amount: '10' }), 400, 'Сумма: только число')
  refused(() => createCashMove(c, { kind: 'in', amount: 1e12 }), 400, 'Сумма: не больше 9999999999.99')
  refused(() => createCashMove(c, { kind: 'in', amount: 10, note: 'х'.repeat(501) }), 400, 'Примечание: не длиннее 500 символов')
  assert.equal(listDocs(db, 'cashmove').length, 2)
  // Текст — слово в слово как у сервера (server/src/shifts/till.ts)
  assert.equal(NO_OPEN_SHIFT_CASH, 'Нет открытой смены — внести или изъять наличные не из чего. Откройте смену.')

  // Закрытие: 100 на начало + 200.46 внесено − 50 изъято
  const closed = closeShift({ ...c, now: NOW + 3600_000 }, { countedCash: 250.46 })
  assert.deepEqual(
    [closed.cashIn, closed.cashOut, closed.supplierCash, closed.salesTransfer, closed.transferBy, closed.totalSales, closed.expectedCash, closed.difference],
    [200.46, 50, 0, 0, {}, 0, 250.46, 0],
  )
  // Смена закрыта — внести и изъять больше не во что
  refused(() => createCashMove(c, { kind: 'out', amount: 1 }), 400, NO_OPEN_SHIFT_CASH)
})

test('сервер принял внесение: сумма не теряется до прихода свежей смены и не задваивается после; отвергнутое снято с учёта', () => {
  const db = apteka()
  const c = ctx(db)
  const shift = openedShift(db)
  const m = createCashMove(c, { kind: 'in', amount: 40 })
  assert.deepEqual(till(db), [40, 0])

  // Принял — а связь могла оборваться сразу после этого: свежей смены ещё нет
  const op = opOf(db, 'cash.move')
  ackOp(db, op, { status: 'ok', docId: m.id })
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'cashmove'").sync, 'synced')
  assert.deepEqual(till(db), [40, 0], 'принятое внесение пропало из смены')
  ackOp(db, op, { status: 'ok', docId: m.id })
  assert.deepEqual(till(db), [40, 0])

  // Пришла копия с сервера: та же запись под тем же номером и смена с суммой
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', cashIn: 40 }), cashMoves: up({ ...m, clientId: null }) })
  assert.deepEqual(till(db), [40, 0], 'принятое внесение посчитано дважды')
  assert.equal(listDocs(db, 'cashmove').length, 1)

  // Владелец на сайте изъял из ящика этой кассы 15 — касса узнаёт об этом
  const fromSite = { id: 'cm-site', shiftId: shift.id, kind: 'out', amount: 15, note: '', userId: 'u', date: iso(NOW + 5000), createdAt: iso(NOW + 5000), user: { id: 'u', name: 'hoz' } }
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', cashIn: 40, cashOut: 15 }), cashMoves: up(fromSite) }, '110')
  assert.deepEqual(till(db), [40, 15])
  // Отменил на сайте — её нет и здесь
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', cashIn: 40, cashOut: 0 }), cashMoves: { upsert: [], remove: ['cm-site'] } }, '120')
  assert.deepEqual(till(db), [40, 0])

  // Сервер отверг изъятие: денег из ящика не уходило, владелец видит отказ целиком
  createCashMove(c, { kind: 'out', amount: 5, note: 'ошибка' })
  assert.deepEqual(till(db), [40, 5])
  const bad = opOf(db, 'cash.move')
  rejectOp(db, bad, 'Смена не найдена')
  assert.deepEqual(till(db), [40, 0])
  assert.equal(listDocs(db, 'cashmove').length, 1, 'отвергнутой записи в журнале нет')
  const [rej] = rejectedOps(db)
  assert.equal(rej.error, 'Смена не найдена')
  assert.deepEqual(describeOp(rej), { sum: 5, title: '', detail: { kind: 'out', note: 'ошибка' } })
  assert.deepEqual(touchedBy(rej), ['cashMoves', 'shifts'])
  assert.equal(getMeta(db, 'needFull'), '1')

  // Закрытие считает по всем записям смены, своим и серверным
  const closed = closeShift(c, { countedCash: 140 })
  assert.deepEqual([closed.cashIn, closed.cashOut, closed.expectedCash, closed.difference], [40, 0, 140, 0])
})

test('закрытие смены отвергнуто: смена снова открыта, внесённое не теряется и не задваивается', () => {
  const db = apteka()
  openedShift(db)
  createCashMove(ctx(db), { kind: 'in', amount: 40 })
  ackOp(db, opOf(db, 'cash.move'))
  createCashMove(ctx(db), { kind: 'out', amount: 10 })
  const closed = closeShift(ctx(db), { countedCash: 130 })
  assert.deepEqual([closed.cashIn, closed.cashOut, closed.expectedCash], [40, 10, 130])
  rejectOp(db, opOf(db, 'shift.close'), 'Недопустимая дата: закрытие смены')
  assert.ok(myOpenShift(db, 'kassa-1'))
  assert.deepEqual(till(db), [40, 10])
  const again = closeShift(ctx(db), { countedCash: 130 })
  assert.deepEqual([again.cashIn, again.cashOut, again.expectedCash, again.difference], [40, 10, 130, 0])
})

// ── Переводы ──

test('продажа переводом: сервис обязателен, в чеке и в смене — по сервисам; возврат переводом берёт сервис чека', () => {
  const db = apteka()
  const c = ctx(db)
  openShift(c, { openingCash: 0 })
  refused(() => checkout(c, { payment: 'transfer', items: [{ productId: 'nur', qty: 1 }] }), 400, 'Укажите сервис перевода')
  refused(() => checkout(c, { payment: 'transfer', payVia: '   ', items: [{ productId: 'nur', qty: 1 }] }), 400, 'Укажите сервис перевода')
  assert.equal(listDocs(db, 'sale').length, 0)

  const dc = checkout(c, { payment: 'transfer', payVia: ' DC ', items: [{ productId: 'nur', qty: 1 }] })
  assert.deepEqual([dc.payment, dc.payVia, dc.total], ['transfer', 'DC', 150])
  assert.equal(opOf(db, 'sale').payload.sale.payVia, 'DC', 'серверу сервис перевода тоже нужен')
  const alif = checkout(c, { payment: 'transfer', payVia: 'Alif', items: [{ productId: 'nur', qty: 2 }] })
  // У наличных и карты сервиса нет, что бы ни прислало окно
  const cash = checkout(c, { payment: 'cash', payVia: 'DC', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(cash.payVia, null)
  checkout(c, { payment: 'card', items: [{ productId: 'nur', qty: 1 }] })

  // Возврат по чеку с переводом — тем же сервисом, если кассир не назвал другой
  const back = createReturn(c, { saleId: dc.id, items: [{ productId: 'nur', units: 1 }] })
  assert.deepEqual([back.refund, back.refundVia, back.total], ['transfer', 'DC', 150])
  const other = createReturn(c, { saleId: alif.id, refund: 'transfer', refundVia: 'Эсхата', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(other.refundVia, 'Эсхата')
  // Наличными по чеку с переводом — сервиса нет
  const inCash = createReturn(c, { saleId: alif.id, refund: 'cash', items: [{ productId: 'nur', units: 1 }] })
  assert.deepEqual([inCash.refund, inCash.refundVia], ['cash', null])
  assert.equal(opOf(db, 'return').payload.ret.refundVia, 'DC')

  // Смена: переводы — отдельно и по сервисам, в ящик они не попадают;
  // наличный возврат ушёл из ящика
  const closed = closeShift(c, { countedCash: 0 })
  assert.deepEqual(
    [closed.salesCash, closed.salesCard, closed.salesTransfer, closed.transferBy, closed.totalSales, closed.refundCash, closed.refundTotal, closed.expectedCash, closed.difference],
    [150, 150, 450, { DC: 150, Alif: 300 }, 750, 150, 450, 0, 0],
  )
  assert.equal(closed.count, 4)
})

// ── Приход в долг ──

test('приход в долг: поставщик из справочника, долг не больше суммы; долг владельца растёт сразу и не задваивается после приёма', () => {
  const db = apteka()
  const c = ctx(db)
  // Справочник — как его отдаёт сервер: владельцу с долгами, кассиру без
  assert.deepEqual(suppliersList(db, true), [
    { id: 'sup-2', name: 'Авиценна-трейд', phone: '', note: 'по вторникам', createdAt: '2026-09-01T08:00:00.000Z', openingDebt: 0, debt: 0 },
    { id: 'sup-1', name: 'Фарм-опт', phone: '+992 900 11 22 33', note: '', createdAt: '2026-09-01T08:00:00.000Z', openingDebt: 500, debt: 500 },
  ])
  assert.deepEqual(Object.keys(suppliersList(db, false)[0]), ['id', 'name', 'phone', 'note', 'createdAt'])

  const a = createArrival(c, { supplierId: 'sup-1', debt: 120, items: [{ productId: 'nur', qty: 2, cost: 100, expiryDate: EXP }] })
  assert.deepEqual([a.supplier, a.supplierId, a.debt, a.total, a.userId, a.user], ['Фарм-опт', 'sup-1', 120, 200, 'user-1', { id: 'user-1', name: 'kassir' }])
  const op = opOf(db, 'arrival')
  assert.deepEqual([op.payload.arrival.supplierId, op.payload.arrival.debt], ['sup-1', 120])
  assert.equal(debtOf(db, 'sup-1'), 620, 'неотправленный приход в долг должен быть виден в долге сразу')
  assert.equal(debtOf(db, 'sup-2'), 0)

  // Больше суммы прихода в долг не бывает, меньше нуля — тоже
  assert.equal(createArrival(c, { supplierId: 'sup-2', debt: 999, items: [{ productId: 'nur', qty: 1, cost: 50, expiryDate: EXP }] }).debt, 50)
  refused(() => createArrival(c, { supplierId: 'sup-2', debt: -5, items: [{ productId: 'nur', qty: 1, cost: 50, expiryDate: EXP }] }), 400, 'Долг: не меньше 0')
  assert.equal(debtOf(db, 'sup-2'), 50)
  // Долг без поставщика из справочника — не долг: записать его не на кого
  const free = createArrival(c, { supplier: 'Склад', debt: 10, items: [{ productId: 'nur', qty: 1, cost: 50, expiryDate: EXP }] })
  assert.deepEqual([free.supplier, free.supplierId, free.debt], ['Склад', null, 0])
  // Поставщика, которого касса не знает, без связи не завести — приход ждёт интернета
  refused(() => createArrival(c, { supplierId: 'sup-9', debt: 1, items: [{ productId: 'nur', qty: 1, cost: 50, expiryDate: EXP }] }), 400, 'Поставщик не найден')
  refused(() => createArrival(c, { supplierId: 'sup-1', debt: 'много', items: [{ productId: 'nur', qty: 1, cost: 50, expiryDate: EXP }] }), 400, 'Долг: только число')
  assert.equal(listDocs(db, 'arrival').length, 3)

  // Сервер принял первый приход, а свежей копии поставщика ещё нет — долг на месте
  ackOp(db, op)
  assert.equal(debtOf(db, 'sup-1'), 620, 'после приёма долг прихода пропал')
  ackOp(db, op)
  assert.equal(debtOf(db, 'sup-1'), 620)
  // Пришла копия поставщика — в ней приход уже посчитан
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 620 }) })
  assert.equal(debtOf(db, 'sup-1'), 620, 'принятый приход посчитан дважды')
  // Владелец оплатил 100 на сайте — касса узнаёт из копии
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 520 }) }, '110')
  assert.equal(debtOf(db, 'sup-1'), 520)

  // Отвергнутый приход в долг не считается
  const second = ops(db).filter((o) => o.type === 'arrival')[0]
  rejectOp(db, second, 'Недостаточно прав')
  assert.equal(debtOf(db, 'sup-2'), 0)
  assert.deepEqual(touchedBy(second), ['arrivals', 'products', 'suppliers'])
})

// ── Справочники с сервера и обновление программы ──

test('поставщики и сервисы перевода приходят с сервера; обмен кассира долги владельца не стирает', () => {
  const db = apteka()
  // Кассир получил поставщиков без долгов — то, что знал владелец, остаётся
  const changed = delta(db, { suppliers: up({ id: 'sup-1', name: 'Фарм-опт ООО', phone: '', note: '', createdAt: '2026-09-01T08:00:00.000Z' }) })
  assert.ok(changed.includes('suppliers'), 'окно должно перечитать поставщиков: ' + changed)
  const sup = suppliersList(db, true).find((s) => s.id === 'sup-1')
  assert.deepEqual([sup.name, sup.debt, sup.openingDebt], ['Фарм-опт ООО', 500, 500])
  // Новый поставщик, которого получал только кассир: долг неизвестен, а не ноль
  delta(db, { suppliers: up({ id: 'sup-3', name: 'Новый', phone: '', note: '', createdAt: '2026-10-01T08:00:00.000Z' }) }, '110')
  assert.equal(suppliersList(db, true).find((s) => s.id === 'sup-3').debt, null)
  // Владелец получил его с долгом
  delta(db, { suppliers: up({ id: 'sup-3', name: 'Новый', phone: '', note: '', openingDebt: 0, debt: 7, createdAt: '2026-10-01T08:00:00.000Z' }) }, '120')
  assert.equal(suppliersList(db, true).find((s) => s.id === 'sup-3').debt, 7)
  // Удалили на сайте — нет и здесь
  delta(db, { suppliers: { upsert: [], remove: ['sup-3'] } }, '130')
  assert.ok(!suppliersList(db, true).some((s) => s.id === 'sup-3'))

  // Сервисы перевода — в порядке сервера
  assert.deepEqual(payServicesList(db).map((s) => s.name), ['Alif', 'DC', 'Эсхата'])
  const more = delta(db, { payServices: { upsert: [{ id: 'paysvc-9', name: 'Humo', ord: 0, createdAt: '2026-10-01T08:00:00.000Z' }], remove: ['paysvc-2'] } }, '140')
  assert.ok(more.includes('payServices'))
  assert.deepEqual(payServicesList(db).map((s) => s.name), ['Humo', 'Alif', 'Эсхата'])

  // Полная загрузка заменяет оба списка целиком
  applyPull(db, { full: true, cursor: '200', data: { products: up(), sales: up(), suppliers: up(SUPPLIERS[1]), payServices: up(PAY_SERVICES[0]) } }, { now: NOW })
  assert.deepEqual(suppliersList(db, true).map((s) => s.id), ['sup-2'])
  assert.deepEqual(payServicesList(db).map((s) => s.name), ['Alif'])
})

test('обновление программы с версии 1.0.1: появляются поставщики и сервисы перевода, первый обмен — полный, неотправленное на месте', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'apteka-till-')), 'p.db')
  // Версия 1.0.1: два шага схемы, касса уже обменивалась с сервером
  let db = openDb(file, PHARMACY_SCHEMA.slice(0, 2))
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('suppliers', 'pay_services')").n, 0)
  setMeta(db, 'cursor', '500')
  setMeta(db, 'wcursor', '500')
  setMeta(db, 'loaded', '1')
  db.prepare("INSERT INTO docs (kind, id, date, body, sync) VALUES ('sale', 's1', '2026-10-01T00:00:00.000Z', '{}', 'pending')").run()
  db.close()

  // Версия 1.0.2 открывает ту же базу
  db = openDb(file, PHARMACY_SCHEMA)
  assert.deepEqual(rows(db, 'SELECT * FROM suppliers'), [])
  assert.deepEqual(rows(db, 'SELECT * FROM pay_services'), [])
  // Обе отметки сброшены: поставщиков и сервисы сервер отдаёт всем, но по прежней
  // отметке они уже «прошли». Загруженной база остаётся — без связи работать можно
  assert.equal(getMeta(db, 'cursor'), null)
  assert.equal(getMeta(db, 'wcursor'), null)
  assert.equal(getMeta(db, 'loaded'), '1')
  assert.equal(row(db, "SELECT sync FROM docs WHERE id = 's1'").sync, 'pending')
  db.close()
  // Повторный запуск шаг заново не выполняет
  db = openDb(file, PHARMACY_SCHEMA)
  setMeta(db, 'cursor', '600')
  db.close()
  db = openDb(file, PHARMACY_SCHEMA)
  assert.equal(getMeta(db, 'cursor'), '600')
  db.close()
})

// ── Что касса отвечает сама и кому ──

test('поставщики и сервисы — всем, оплаты поставщикам — владельцу, внести и изъять — и кассиру', () => {
  const db = apteka()
  const call = (method, path, user, body) => {
    const found = matchLocal(method, path)
    assert.ok(found, `${method} ${path} должен обслуживаться локально`)
    return found.handler({ ...ctx(db, user ? { user } : {}), query: found.query, params: found.params, body })
  }
  assert.deepEqual(call('GET', '/suppliers', CASHIER).map((s) => [s.name, s.debt]), [['Авиценна-трейд', undefined], ['Фарм-опт', undefined]])
  assert.deepEqual(call('GET', '/suppliers').map((s) => [s.name, s.debt]), [['Авиценна-трейд', 0], ['Фарм-опт', 500]])
  assert.deepEqual(call('GET', '/pay-services', CASHIER).map((s) => s.name), ['Alif', 'DC', 'Эсхата'])
  refused(() => call('GET', '/supplier-payments', CASHIER), 403, 'Недостаточно прав')
  assert.deepEqual(call('GET', '/supplier-payments'), [])

  // Кассир за своей кассой: смена, внесение, журнал
  assert.deepEqual(call('GET', '/shifts/cash-sources', CASHIER), [])
  const shift = call('POST', '/shifts/open', CASHIER, { openingCash: 30 })
  assert.deepEqual(call('GET', '/shifts/cash-sources', CASHIER), [{ shiftId: shift.id, deviceId: 'kassa-1', deviceName: '', openedAt: shift.openedAt }])
  const m = call('POST', '/shifts/cash', CASHIER, { kind: 'in', amount: 20, note: 'размен' })
  assert.deepEqual([m.kind, m.amount, m.shiftId, m.user], ['in', 20, shift.id, { id: 'user-2', name: 'nilufar' }])
  assert.deepEqual(call('GET', '/cash-moves?days=180', CASHIER), [m])
  assert.deepEqual([call('GET', '/shifts', CASHIER)[0].cashIn, call('GET', '/shifts', CASHIER)[0].cashOut], [20, 0])
  // Оплата поставщику с сервера пришла в журнал — владелец видит её у себя
  delta(db, { supplierPayments: up({ id: 'sp-1', supplierId: 'sup-1', amount: 100, date: iso(NOW), note: '', fromCash: false, shiftId: null, user: { id: 'u', name: 'hoz' } }) })
  assert.deepEqual(call('GET', '/supplier-payments').map((p) => p.id), ['sp-1'])
})
