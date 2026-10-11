// ── Локальная база и ответы сервера ──
//
// Две вещи, на которых держится «ничего не теряется и ничего не задваивается»:
//   • что происходит с операцией кассы, когда сервер её принял или отверг;
//   • как в локальную базу ложится ответ сервера — целиком в первый раз и по одной
//     записи потом.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { customersList, deferredList, productsList } from '../src/local/catalog.mjs'
import { getMeta } from '../src/local/db.mjs'
import { listDocs, listShifts, myOpenShift } from '../src/local/docs.mjs'
import { ackOp, clearAttempts, hasUnconfirmed, markAttempt, pendingCount, pendingOps, rejectedCount, rejectedOps, rejectOp, sentOps, SHIFT_GONE } from '../src/local/outbox.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { createCustomer, payDebt } from '../src/local/ops/customer.mjs'
import { addDeferred, removeDeferred } from '../src/local/ops/deferred.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift } from '../src/local/ops/shift.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { ctx, customer, day, DAY, NOW, pharmacy, product, row, rows } from '../test-support/pharmacy.mjs'

function apteka(extra = {}) {
  const nur = product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })
  const par = product({ id: 'par', name: 'Парацетамол', unitsPerPack: 20, price: 200, cost: 120, stock: 9 })
  const db = pharmacy({ products: [nur, par], customers: [customer({ id: 'ivan', name: 'Иван', debt: 10 })], ...extra })
  return { db, nur, par }
}
const stock = (db, id) => productsList(db, NOW).find((p) => p.id === id)?.stock
// Частичный ответ сервера: «вот что изменилось»
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
const up = (...list) => ({ upsert: list, remove: [] })
const ops = (db) => pendingOps(db, 100)

// ── Очередь: сервер принял ──

test('сервер принял чек: он больше не «наш неотправленный» — ни документ, ни движения', () => {
  const { db, nur } = apteka()
  const sale = checkout(ctx(db), { payment: 'debt', customerId: 'ivan', items: [{ productId: 'nur', qty: 2 }] })
  const [op] = ops(db)
  assert.equal(pendingCount(db), 1)

  ackOp(db, op)
  assert.equal(pendingCount(db), 0)
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', sale.id).sync, 'synced')
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM stock_moves WHERE synced = 0').n, 0)
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM debt_moves WHERE synced = 0').n, 0)
  // До ответа сервера остаток на экране прежний: 5 − 2
  assert.equal(stock(db, 'nur'), 3)

  // Сервер присылает свой остаток (уже с этой продажей) и свой долг — вычитать и
  // прибавлять ещё раз нечего
  delta(db, { products: up({ ...nur, stock: 3 }), customers: up(customer({ id: 'ivan', name: 'Иван', debt: 310 })) })
  assert.equal(stock(db, 'nur'), 3, 'принятая продажа вычтена дважды')
  assert.equal(customersList(db)[0].debt, 310, 'принятый долг прибавлен дважды')
})

test('пока операция не принята, её документ серверной копией не заменяется; после — заменяется', () => {
  const { db } = apteka()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const copy = { ...sale, total: 150, server: true }
  delta(db, { sales: up(copy) })
  assert.equal(listDocs(db, 'sale')[0].server, undefined, 'вместе с документом в журнале лежат его движения — менять их порознь нельзя')

  ackOp(db, ops(db)[0])
  delta(db, { sales: up(copy) })
  assert.equal(listDocs(db, 'sale')[0].server, true)
  assert.equal(listDocs(db, 'sale').length, 1)
})

test('смена ждёт отправки, пока не ушли обе её операции — и открытие, и закрытие', () => {
  const { db } = apteka()
  const c = ctx(db)
  const shift = openShift(c, { openingCash: 10 })
  closeShift(c, { countedCash: 10 })
  const [open, close] = ops(db)
  assert.deepEqual([open.type, close.type], ['shift.open', 'shift.close'])

  ackOp(db, open)
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', shift.id).sync, 'pending', 'сервер знает смену открытой, а она уже закрыта')
  // Серверная копия (ещё открытая) не должна затереть закрытую
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1' }) })
  assert.ok(listShifts(db, 'kassa-1')[0].closedAt, 'закрытая смена «открылась» обратно')

  ackOp(db, close)
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', shift.id).sync, 'synced')
})

test('возврат со списанием, клиент, долг, штрихкоды — каждая операция гасит своё', () => {
  const { db } = apteka()
  const c = ctx(db)
  const sale = checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 2 }] })
  createReturn(c, { saleId: sale.id, items: [{ productId: 'nur', units: 1, restock: false }] })
  const petr = createCustomer(c, { name: 'Пётр' })
  payDebt(c, 'ivan', { amount: 4 })
  const code = addDeferred(c, { barcode: '4600000000017' })
  removeDeferred(c, code.id)

  for (const op of ops(db)) ackOp(db, op)
  assert.equal(pendingCount(db), 0)
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM docs WHERE sync <> 'synced'").n, 0, 'остались документы «ждёт отправки»')
  assert.equal(row(db, 'SELECT local FROM customers WHERE id = ?', petr.id).local, 0)
  // Убранный штрихкод сервер тоже убрал — отметка «убран здесь» больше не нужна
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM deferred').n, 0)
})

// ── Очередь: сервер отверг ──

test('сервер отверг приход: товар снимается с полки, закупочная цена возвращается, документ помечен', () => {
  const { db } = apteka()
  const arrival = createArrival(ctx(db), { items: [{ productId: 'nur', qty: 5, cost: 200, expiryDate: '2028-01-01' }] })
  assert.equal(stock(db, 'nur'), 10)
  assert.equal(productsList(db, NOW).find((p) => p.id === 'nur').cost, 150)

  rejectOp(db, ops(db)[0], 'Товар не найден: Нурофен')
  assert.equal(pendingCount(db), 0)
  assert.equal(rejectedCount(db), 1)
  assert.equal(rejectedOps(db)[0].error, 'Товар не найден: Нурофен')
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', arrival.id).sync, 'rejected')
  // Остаток пересчитывается при ближайшем обмене — даже если сервер ничего нового
  // про этот товар не прислал
  assert.equal(getMeta(db, 'needRebuild'), '1')
  assert.deepEqual(delta(db, {}), ['products'])
  assert.equal(stock(db, 'nur'), 5)
  assert.equal(productsList(db, NOW).find((p) => p.id === 'nur').cost, 100)
  assert.equal(getMeta(db, 'needRebuild'), '0')
})

test('сервер отверг продажу в долг: долг клиента возвращается к серверному', () => {
  const { db } = apteka()
  checkout(ctx(db), { payment: 'debt', customerId: 'ivan', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(customersList(db)[0].debt, 160)
  rejectOp(db, ops(db)[0], 'Клиент не найден')
  delta(db, {})
  assert.equal(customersList(db)[0].debt, 10)
  assert.equal(stock(db, 'nur'), 5)
})

test('отвергнутые штрихкоды: добавленный исчезает, убранный возвращается', () => {
  const { db } = apteka({ deferred: [{ id: 'd1', barcode: '4600000000001', createdAt: '2026-10-01T00:00:00.000Z' }] })
  const c = ctx(db)
  addDeferred(c, { barcode: '4600000000017' })
  removeDeferred(c, 'd1')
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['4600000000017'])
  for (const op of ops(db)) rejectOp(db, op, 'нет')
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['4600000000001'])
})

test('отправили, а ответа нет: касса помнит, что судьба операции неизвестна', () => {
  const { db } = apteka()
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(hasUnconfirmed(db), false, 'ещё не отправляли — неизвестности нет')
  markAttempt(db, ops(db), NOW)
  assert.equal(hasUnconfirmed(db), true)
  assert.equal(ops(db)[0].attempts, 1)
  // Сервер ответил определённо («не смог записать») — неизвестность снята, операция в очереди
  clearAttempts(db, ops(db))
  assert.equal(hasUnconfirmed(db), false)
  assert.equal(pendingCount(db), 1)
  // Принятая операция неизвестной не считается, сколько бы раз её ни слали
  markAttempt(db, ops(db), NOW)
  ackOp(db, ops(db)[0])
  assert.equal(hasUnconfirmed(db), false)
})

// ── Ответ сервера: по одной записи ──

test('частичный ответ: товар меняется, добавляется и удаляется — остальные не тронуты', () => {
  const { db, nur } = apteka()
  const changed = delta(db, {
    products: { upsert: [{ ...nur, price: 175, stock: 4 }, product({ id: 'ana', name: 'Анальгин', stock: 7 })], remove: ['par'] },
  })
  assert.deepEqual(changed, ['products'])
  const list = productsList(db, NOW)
  assert.deepEqual(list.map((p) => [p.name, p.stock, p.price]), [['Анальгин', 7, 150], ['Нурофен', 4, 175]])
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM batches WHERE productId = 'par'").n, 0, 'партии удалённого товара остались')
  assert.equal(getMeta(db, 'cursor'), '100', 'отметка «докуда получили» запомнена')
})

test('список товаров — по алфавиту, как бы они ни приходили', () => {
  const db = pharmacy({ products: [product({ id: 'c', name: 'Цитрамон' }), product({ id: 'a', name: 'аспирин' }), product({ id: 'b', name: 'Бинт №10' })] })
  assert.deepEqual(productsList(db, NOW).map((p) => p.name), ['аспирин', 'Бинт №10', 'Цитрамон'])
  delta(db, { products: up(product({ id: 'd', name: 'Бинт №2' }), product({ id: 'a', name: 'Ясень' })) })
  // Числа в названии сравниваются как числа: №2 раньше №10
  assert.deepEqual(productsList(db, NOW).map((p) => p.name), ['Бинт №2', 'Бинт №10', 'Цитрамон', 'Ясень'])
})

test('настоящие партии с сервера: срок и остаток у каждой свои; условные партии из карточки уходят', () => {
  const { db, nur } = apteka()
  assert.deepEqual(rows(db, "SELECT id FROM batches WHERE productId = 'nur'").map((b) => b.id), ['card-g:nur'])

  // Сервер завёл товару партии (первое же движение) — приходят и карточка, и партии
  delta(db, {
    products: up({ ...nur, stock: 5, expiredUnits: 2, expiryDate: day('2026-10-01') }),
    batches: up(
      { id: 'b1', productId: 'nur', units: 2, cost: 100, expiryDate: day('2026-10-01'), createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'b2', productId: 'nur', units: 3, cost: 100, expiryDate: day('2027-03-01'), createdAt: '2026-09-01T00:00:00.000Z' },
    ),
  })
  assert.deepEqual(rows(db, "SELECT id FROM batches WHERE productId = 'nur' ORDER BY id").map((b) => b.id), ['b1', 'b2'])
  const v = productsList(db, NOW).find((p) => p.id === 'nur')
  assert.deepEqual([v.stock, v.expiredUnits], [5, 2])

  // Партия продана на другой кассе до нуля, вторая удалена (приход убрали)
  delta(db, { products: up({ ...nur, stock: 0 }), batches: { upsert: [{ id: 'b1', productId: 'nur', units: 0, cost: 100 }], remove: ['b2'] } })
  assert.equal(stock(db, 'nur'), 0)
  // Партии настоящие (хоть и пустые) — из карточки ничего не выдумываем
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM batches WHERE id LIKE 'card-%' AND productId = 'nur'").n, 0)
})

test('свои продажи поверх настоящих партий: списывается ближайший годный срок, и после сверки тоже', () => {
  const nur = product({ id: 'nur', name: 'Нурофен', stock: 0 })
  const db = pharmacy({
    products: [nur],
    batches: [
      { id: 'near', productId: 'nur', units: 2, cost: 100, expiryDate: day('2026-12-01'), createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'far', productId: 'nur', units: 5, cost: 100, expiryDate: day('2027-12-01'), createdAt: '2026-09-01T00:00:00.000Z' },
    ],
  })
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 3 }] })
  const units = () => Object.fromEntries(rows(db, 'SELECT id, units FROM batches').map((b) => [b.id, b.units]))
  assert.deepEqual(units(), { near: 0, far: 4 })

  // На другой кассе продали одну упаковку из ближней партии: сервер прислал near = 1.
  // Наши три штуки проигрываются заново: одна из ближней, две из дальней
  delta(db, { batches: up({ id: 'near', productId: 'nur', units: 1, cost: 100, expiryDate: day('2026-12-01'), createdAt: '2026-08-01T00:00:00.000Z' }) })
  assert.deepEqual(units(), { near: 0, far: 3 })
  assert.equal(stock(db, 'nur'), 3)
})

test('частичный ответ: клиенты, штрихкоды и документы — по одной записи', () => {
  const { db } = apteka({ deferred: [{ id: 'd1', barcode: '111', createdAt: '2026-10-01T00:00:00.000Z' }] })
  const doc = (id, date) => ({ id, date, total: 1, cost: 0, profit: 1, payment: 'cash', items: [], customer: null, user: null })
  delta(db, { sales: up(doc('s1', '2026-10-01T00:00:00.000Z'), doc('s2', '2026-10-02T00:00:00.000Z')) })
  const changed = delta(db, {
    customers: { upsert: [customer({ id: 'olga', name: 'Ольга', debt: 55 })], remove: ['ivan'] },
    deferred: { upsert: [{ id: 'd2', barcode: '222', createdAt: '2026-10-02T00:00:00.000Z' }], remove: ['d1'] },
    sales: { upsert: [{ ...doc('s2', '2026-10-02T00:00:00.000Z'), total: 9 }], remove: ['s1'] },
    // Раздел пришёл, но в нём ничего не изменилось — окну об этом не сообщаем
    returns: { upsert: [], remove: [] },
  })
  assert.deepEqual(changed.sort(), ['customers', 'deferred', 'sales'])
  assert.deepEqual(customersList(db).map((c) => [c.name, c.debt]), [['Ольга', 55]])
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['222'])
  assert.deepEqual(listDocs(db, 'sale').map((s) => [s.id, s.total]), [['s2', 9]])
})

test('удаление с сервера не трогает то, что сделано здесь и ещё не отправлено', () => {
  const { db } = apteka()
  const c = ctx(db)
  const sale = checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const petr = createCustomer(c, { name: 'Пётр' })
  delta(db, { sales: { upsert: [], remove: [sale.id] }, customers: { upsert: [], remove: [petr.id] } })
  assert.equal(listDocs(db, 'sale').length, 1)
  assert.ok(customersList(db).some((x) => x.id === petr.id))
})

test('полный ответ отмечает базу готовой к работе; журнал списаний — только если пришёл', () => {
  const { db, nur } = apteka()
  assert.notEqual(getMeta(db, 'loaded'), '1', 'каталог без журналов — ещё не «всё загружено»')
  const all = (list) => ({ upsert: list, remove: [] })
  // Кассир: сервер списания не отдаёт
  applyPull(db, { full: true, cursor: '7', data: { products: all([nur]), sales: all([]) } }, { now: NOW })
  assert.equal(getMeta(db, 'loaded'), '1')
  assert.ok(!getMeta(db, 'wcursor'), 'владельцу при входе понадобится свой полный ответ')
  assert.equal(getMeta(db, 'cursor'), '7')
  // Владелец
  applyPull(db, { full: true, cursor: '9', data: { products: all([nur]), sales: all([]), writeoffs: all([]) } }, { now: NOW })
  assert.equal(getMeta(db, 'wcursor'), '9')
})

test('у журнала списаний своя отметка: обмены кассира её не двигают', () => {
  const { db, nur } = apteka()
  const all = (list) => ({ upsert: list, remove: [] })
  applyPull(db, { full: true, cursor: '10', data: { products: all([nur]), sales: all([]), writeoffs: all([]) } }, { now: NOW })
  // За кассой кассир: раздела списаний в ответах нет, общая отметка идёт вперёд
  delta(db, { products: up({ ...nur, stock: 4 }) }, '20')
  delta(db, {}, '30')
  assert.deepEqual([getMeta(db, 'cursor'), getMeta(db, 'wcursor')], ['30', '10'], 'по этой отметке владелец доберёт пропущенные списания')
  // Вернулся владелец: раздел пришёл — отметки снова вместе
  delta(db, { writeoffs: up() }, '40')
  assert.deepEqual([getMeta(db, 'cursor'), getMeta(db, 'wcursor')], ['40', '40'])
  // Кассир получил всё заново (журнал на сервере подчищен): прежние списания устарели целиком
  applyPull(db, { full: true, cursor: '50', data: { products: all([nur]), sales: all([]) } }, { now: NOW })
  assert.ok(!getMeta(db, 'wcursor'))
})

test('журналы не растут вечно: давние чеки касса у себя не держит', () => {
  const { db } = apteka()
  const doc = (id, daysAgo) => ({ id, date: new Date(NOW - daysAgo * DAY).toISOString(), total: 1, cost: 0, profit: 1, payment: 'cash', items: [], customer: null, user: null })
  delta(db, { sales: up(doc('свежий', 5), doc('у-границы', 59), doc('давний', 70)), returns: up({ ...doc('возврат', 70), refund: 'cash' }) })
  // Уборка — раз в сутки: сразу после первой она не повторяется
  assert.deepEqual(listDocs(db, 'sale').map((s) => s.id), ['свежий', 'у-границы', 'давний'])
  applyPull(db, { full: false, cursor: '101', data: {} }, { now: NOW + DAY + 1000 })
  assert.deepEqual(listDocs(db, 'sale').map((s) => s.id), ['свежий', 'у-границы'], 'чеки хранятся 60 дней')
  assert.equal(listDocs(db, 'return').length, 1, 'возвраты хранятся дольше — 180 дней')
})

test('принятое сервером касса хранит полтора месяца, а не принятое — пока не примут', () => {
  const { db } = apteka()
  const old = NOW - 50 * DAY
  // Полсотни дней назад: один чек сервер принял, другой отверг, третий так и ждёт
  const sell = () => checkout(ctx(db, { now: old }), { payment: 'debt', customerId: 'ivan', items: [{ productId: 'nur', qty: 1 }] })
  sell()
  sell()
  sell()
  const [accepted, refusedOp] = ops(db)
  ackOp(db, accepted)
  rejectOp(db, refusedOp, 'Суммы чека не сходятся с его позициями')
  // И свежий принятый чек — его срок ещё не вышел
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  ackOp(db, ops(db)[1])
  const states = () => rows(db, 'SELECT state, COUNT(*) AS n FROM outbox GROUP BY state ORDER BY state').map((r) => `${r.state}:${r.n}`)
  assert.deepEqual(states(), ['done:2', 'pending:1', 'rejected:1'])

  applyPull(db, { full: false, cursor: '101', data: {} }, { now: NOW + DAY + 1000 })
  assert.deepEqual(states(), ['done:1', 'pending:1', 'rejected:1'], 'давняя принятая операция убрана, остальные на месте')
  // Движения давнего принятого чека убраны, давнего неотправленного — целы:
  // по ним остаток считается заново при каждой сверке
  assert.deepEqual(
    rows(db, 'SELECT synced, COUNT(*) AS n FROM stock_moves GROUP BY synced ORDER BY synced').map((r) => [r.synced, r.n]),
    [[0, 1], [1, 1]],
  )
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM debt_moves WHERE synced = 0').n, 1)
  assert.equal(stock(db, 'nur'), 4, 'неотправленный чек по-прежнему учтён в остатке: 5 по словам сервера − 1')
})

// ── Товар без партий на сервере ──
// У товаров, заведённых до появления партий, остаток лежит только в карточке: касса
// выводит из неё условные партии. Приход, оформленный здесь и ещё не отправленный,
// добавляет свою партию — и она не должна выдать себя за серверную.

test('товар без партий на сервере и неотправленный приход: правка карточки на сайте не съедает остаток', () => {
  const kart = product({ id: 'kart', name: 'Бинт', stock: 10, price: 30, cost: 10 })
  const db = pharmacy({ products: [kart] })
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'kart', qty: 5, cost: 10, expiryDate: '2028-01-01' }] })
  assert.equal(stock(db, 'kart'), 15)

  // Владелец на сайте поменял цену — карточка приходит заново, партий у сервера по-прежнему нет
  delta(db, { products: up({ ...kart, price: 35 }) })
  assert.equal(stock(db, 'kart'), 15, 'остаток из карточки пропал: партию своего прихода касса приняла за серверную')
  // Продать можно всё, что лежит на полке
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'kart', qty: 12 }] })
  assert.equal(stock(db, 'kart'), 3)
})

test('тот же товар, а приход сервер отверг: остаётся остаток из карточки, а не ноль', () => {
  const kart = product({ id: 'kart', name: 'Бинт', stock: 10, price: 30, cost: 10 })
  const db = pharmacy({ products: [kart] })
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'kart', qty: 5, cost: 10, expiryDate: '2028-01-01' }] })
  const [op] = ops(db)
  rejectOp(db, op, 'Сумма прихода не сходится с его позициями')
  delta(db, { products: up({ ...kart, price: 35 }) })
  assert.equal(stock(db, 'kart'), 10)
  delta(db, { products: up({ ...kart, price: 36 }) }, '101')
  assert.equal(stock(db, 'kart'), 10)
})

// ── Что уходит на сервер ──

test('приход с дробной закупочной ценой: в документе — до дирама, на сервер — как ввели', () => {
  const { db } = apteka()
  const a = createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 3, cost: 33.333, expiryDate: '2028-01-01' }] })
  assert.equal(a.total, 100, '33,333 × 3 = 99,999 → 100.00')
  assert.equal(a.items[0].cost, 33.33, 'в документе цена до дирама')
  const [op] = ops(db)
  assert.equal(op.payload.arrival.total, 100)
  assert.equal(op.payload.arrival.items[0].cost, 33.333, 'сервер пересчитывает сумму сам: 33.33 × 3 дали бы 99.99 — и приход был бы отвергнут')
})

test('документ длиннее, чем принимает сервер, касса не оформляет', () => {
  const { db } = apteka()
  const items = Array.from({ length: 501 }, () => ({ productId: 'nur', qty: 1, cost: 1, expiryDate: '2028-01-01' }))
  assert.throws(() => createArrival(ctx(db), { supplier: 'Склад', items }), /не больше 500 в одном документе/)
  assert.equal(pendingCount(db), 0)
  // Ровно пятьсот — можно
  createArrival(ctx(db), { supplier: 'Склад', items: items.slice(0, 500) })
  assert.equal(pendingCount(db), 1)
})

test('числа больше тех, что примет сервер, касса не оформляет: отказ сейчас, а не от сервера потом', () => {
  const { db } = apteka()
  // Опечатка в количестве и в цене
  assert.throws(() => createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 100_000_000, cost: 1, expiryDate: '2028-01-01' }] }), /не больше 10000000/)
  assert.throws(() => createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 1, cost: 99_999_999_999, expiryDate: '2028-01-01' }] }), /не больше 9999999999\.99/)
  // Каждое число в пределах, а сумма документа — нет
  assert.throws(
    () => createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 100_000, cost: 5_000_000, expiryDate: '2028-01-01' }] }),
    /Сумма документа слишком велика/,
  )
  // Смена: наличные с лишними нулями сервер не примет — закрытие было бы отвергнуто
  openShift(ctx(db), { openingCash: 100 })
  assert.throws(() => closeShift(ctx(db), { countedCash: 100_000_000_000 }), /не больше 9999999999\.99/)
  assert.throws(() => payDebt(ctx(db), 'ivan', { amount: 1e12 }), /не больше/)
  assert.equal(pendingCount(db), 1, 'в очереди — только открытие смены: остальное не оформлено')
  assert.equal(stock(db, 'nur'), 5, 'и на полке ничего не изменилось')
  // Обычные числа проходят как раньше
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 1000, cost: 9_999_999.99, expiryDate: '2028-01-01' }] })
  assert.equal(closeShift(ctx(db), { countedCash: 9_999_999_999.99 }).countedCash, 9_999_999_999.99)
})

test('штук в строке и в упаковке — не больше, чем примет сервер; срок годности — с годом, который хранит база', () => {
  const big = product({ id: 'big', name: 'Вата', unitsPerPack: 500, price: 10, cost: 5, stock: 1 })
  // Карточка с прежних времён: сайт больше такое число штук в упаковке не сохранит
  const old = product({ id: 'old', name: 'Старая карточка', unitsPerPack: 200_000, price: 10, cost: 5, stock: 3 })
  const { db } = apteka()
  const also = pharmacy({ products: [big, old] })
  // Упаковки в пределах, штук в упаковке в пределах, а произведение — больше, чем
  // база хранит целым числом. Сервер отверг бы приход теми же словами — но позже
  assert.throws(
    () => createArrival(ctx(also), { supplier: 'Склад', items: [{ productId: 'big', qty: 4_000_001, cost: 1, expiryDate: '2028-01-01' }] }),
    /В приходе слишком большое количество/,
  )
  createArrival(ctx(also), { supplier: 'Склад', items: [{ productId: 'big', qty: 4_000_000, cost: 1, expiryDate: '2028-01-01' }] })
  assert.equal(pendingCount(also), 1, 'ровно два миллиарда штук — ещё можно')

  // Чек и возврат с товаром, у которого в карточке штук в упаковке больше допустимого
  assert.throws(() => checkout(ctx(also), { payment: 'cash', items: [{ productId: 'old', qty: 1 }] }), /«Старая карточка»: в карточке слишком много штук в упаковке/)
  assert.throws(() => createReturn(ctx(also), { refund: 'cash', items: [{ productId: 'old', units: 1 }] }), /слишком много штук в упаковке/)
  assert.equal(pendingCount(also), 1)

  // Лишняя цифра в годе: такой срок сервер не смог бы записать вовсе
  for (const expiryDate of ['20266-01-01', '+020266-01-01T00:00:00.000Z', '275760-09-12']) {
    assert.throws(() => createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 1, cost: 1, expiryDate }] }), /Срок годности: проверьте год/, expiryDate)
  }
  assert.throws(() => createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 1, cost: 1, expiryDate: '2026-13-45' }] }), /Некорректные данные запроса/)
  assert.equal(pendingCount(db), 0)
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 1, cost: 1, expiryDate: '9999-12-31' }] })
  assert.equal(pendingCount(db), 1)
})

test('сервер отверг закрытие смены: смена снова открыта, если у сервера она есть, — и остаётся отвергнутой, если её там нет', () => {
  const close = (db) => {
    const c = ctx(db)
    const shift = openShift(c, { openingCash: 100 })
    ackOp(db, ops(db)[0])
    closeShift(c, { countedCash: 100 })
    return { shift, op: ops(db)[0] }
  }
  // Смена у сервера есть и открыта (закрытие не принято по своим данным) — открыта и здесь
  const a = apteka().db
  const first = close(a)
  rejectOp(a, first.op, 'Недопустимая дата: закрытие смены')
  assert.equal(myOpenShift(a, ctx(a).deviceId)?.id, first.shift.id)
  assert.equal(row(a, "SELECT sync FROM docs WHERE kind = 'shift' AND id = ?", first.shift.id).sync, 'synced')

  // Такой смены для этой кассы у сервера нет — открывать её здесь заново нельзя
  for (const reason of SHIFT_GONE) {
    const b = apteka().db
    const gone = close(b)
    rejectOp(b, gone.op, reason)
    assert.equal(myOpenShift(b, ctx(b).deviceId) ?? null, null, reason)
    assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'shift' AND id = ?", gone.shift.id).sync, 'rejected', reason)
    assert.equal(rejectedCount(b), 1)
    // Новую смену открыть можно
    assert.ok(openShift(ctx(b), { openingCash: 50 }).id, reason)
  }
  // Тексты — слово в слово как у сервера (server/src/sync/sync.service.ts)
  assert.deepEqual(SHIFT_GONE, ['Смена не найдена', 'Эта смена открыта на другой кассе'])
})

test('операции, которые уходили на сервер, касса помнит и после сброса счётчика попыток', () => {
  const { db } = apteka()
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const [first, second] = ops(db)
  assert.deepEqual(sentOps(db).map((o) => o.id), [], 'ещё ничего не уходило')
  markAttempt(db, [first], NOW)
  // Сервер отказал во входе: счётчик попыток снимается, но операция-то уходила и раньше
  clearAttempts(db, [first])
  assert.equal(hasUnconfirmed(db), false)
  assert.deepEqual(sentOps(db).map((o) => o.id), [first.id], 'о ней надо спросить сервер при обмене')
  ackOp(db, first)
  assert.deepEqual(sentOps(db).map((o) => o.id), [])
  assert.equal(second.id !== first.id, true)
})

// ── Отвергнутое снято с учёта везде ──

test('отвергнутая смена: её нет ни в списке смен, ни в «открытых» — можно открыть новую', () => {
  const { db } = apteka()
  const shift = openShift(ctx(db), { openingCash: 100 })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.shiftId, shift.id)
  const [open] = ops(db)
  rejectOp(db, open, 'На этой кассе уже открыта другая смена')

  assert.deepEqual(listShifts(db, 'kassa-1'), [], 'окно берёт «открытую смену» из этого списка — отвергнутой в нём быть не должно')
  const fresh = openShift(ctx(db), { openingCash: 50 })
  assert.deepEqual(listShifts(db, 'kassa-1').map((s) => s.id), [fresh.id])
  // И закрывается она как обычная; чек отвергнутой смены в её итоги не попадает
  const closed = closeShift(ctx(db), { countedCash: 50 })
  assert.equal(closed.count, 0)
})

test('отвергнутый возврат и отвергнутый чек не видны в журналах и не входят в итоги смены', () => {
  const { db } = apteka()
  const shift = openShift(ctx(db), { openingCash: 0 })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 2 }] })
  for (const o of ops(db)) ackOp(db, o)
  createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'nur', units: 2 }] })
  const bad = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'par', qty: 1 }] })
  const [ret, badSale] = ops(db)
  rejectOp(db, ret, 'Чек не найден')
  rejectOp(db, badSale, 'Суммы чека не сходятся с его позициями')

  assert.deepEqual(listDocs(db, 'return'), [], 'окно считает «уже возвращено» по этому списку')
  assert.deepEqual(listDocs(db, 'sale').map((s) => s.id), [sale.id])
  const closed = closeShift(ctx(db), { countedCash: 300 })
  assert.equal(closed.count, 1, 'в итогах смены — только принятый чек')
  assert.equal(closed.totalSales, 300)
  assert.equal(closed.refundTotal, 0)
  assert.equal(shift.id, closed.id)
  // Владельцу отвергнутое по-прежнему видно — в своём списке
  assert.equal(rejectedCount(db), 2)
  assert.equal(bad.id.length > 0, true)
})

test('сервер прислал документ, который касса считала отвергнутым, — верна копия сервера', () => {
  const { db } = apteka()
  const shift = openShift(ctx(db), { openingCash: 100 })
  const [open] = ops(db)
  rejectOp(db, open, 'На этой кассе уже открыта другая смена')
  assert.deepEqual(listShifts(db, 'kassa-1'), [])
  // У сервера эта смена, оказывается, есть (отказ был на повторную отправку)
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', server: true }) })
  assert.deepEqual(listShifts(db, 'kassa-1').map((s) => s.id), [shift.id])
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', shift.id).sync, 'synced')
})

test('сервер принял чек, не тронув остаток (его пересчитали раньше): касса сходится с сервером', () => {
  // Касса без связи продала упаковку: у неё 4. Владелец на сайте пересчитал полку — 4.
  // Обмен принёс этот пересчёт РАНЬШЕ, чем чек дошёл до сервера (отправить его было нечем)
  const { db, nur } = apteka()
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  delta(db, { products: up({ ...nur, stock: 4 }) })
  assert.equal(stock(db, 'nur'), 3, 'пока чек не принят, он лежит поверх остатка сервера')

  // Чек принят: сервер записал его, а остаток не менял — пересчёт эту продажу уже учёл.
  // Товар в следующем ответе не придёт: на сервере он не менялся
  const [op] = ops(db)
  ackOp(db, op, { status: 'ok', docId: op.payload.sale.id })
  delta(db, {}, '101')
  assert.equal(stock(db, 'nur'), 4, 'поправка кассы осталась наложенной: у неё 3, у сервера 4')
})
