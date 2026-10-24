// ── Правка и удаление документов без интернета ──
//
// Расход, доход, внесение и изъятие, возврат поставщику, приход — с версии 1.4.14 касса
// правит и удаляет их сама. Документ ложится поправкой: «поправлен здесь» или «удалён
// здесь», — и данными сервера не заменяется, пока сервер правку не принял. Суммы, которые
// сервер ведёт сам (расходы из кассы в смене, долг поставщику), касса досчитывает — и ни
// в одном состоянии (ждёт, принято, свежие данные пришли, отказ) не теряет и не задваивает.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal, pendingInPeriod } from '../src/local/api.mjs'
import { listDocs, listShifts } from '../src/local/docs.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { arrivalView, deleteArrival, updateArrival } from '../src/local/ops/arrivaledit.mjs'
import { createCashMove } from '../src/local/ops/cash.mjs'
import { CLOSED_SHIFT_REFUND, deleteCashMove, deleteExpense, deleteIncome, deleteSupplierReturn, SHIFT_CLOSED, SHIFT_CLOSED_CASH, updateExpense, updateIncome } from '../src/local/ops/docedits.mjs'
import { createExpense } from '../src/local/ops/expense.mjs'
import { createIncome } from '../src/local/ops/income.mjs'
import { closeShift, openShift, shiftView } from '../src/local/ops/shift.mjs'
import { createSupplierReturn } from '../src/local/ops/supplierreturn.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { ackOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { productsList } from '../src/local/catalog.mjs'
import { suppliersList } from '../src/local/suppliers.mjs'
import { ctx, NOW, pharmacy, product, refused, row, SUPPLIERS } from '../test-support/pharmacy.mjs'

const shop = (snap = {}) =>
  pharmacy({
    products: [
      product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10 }),
      product({ id: 'bint', name: 'Бинт', barcode: '4600000000024', cost: 50, price: 80, stock: 4, unitsPerPack: 10, looseUnits: 5, expiryDate: null }),
    ],
    ...snap,
  })
const ops = (db) => pendingOps(db, 100)
const lastOp = (db) => ops(db).at(-1)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const up = (...list) => ({ upsert: list, remove: [] })
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
const prod = (db, id) => productsList(db, NOW).find((p) => p.id === id)
const debtOf = (db, id) => suppliersList(db, true).find((s) => s.id === id)?.debt
const syncedShift = (db) => {
  const s = openShift(ctx(db), { openingCash: 500 })
  ackOp(db, opOf(db, 'shift.open'), { status: 'ok', docId: s.id })
  return s
}
const view = (db, id) => shiftView(db, listShifts(db, 'kassa-1').find((x) => x.id === id))

// ════════════════════════ Расход ════════════════════════

test('расход, который сервер уже знает: правка и удаление — сразу, наличные в смене — разницей', () => {
  const db = shop()
  const shift = syncedShift(db)
  const e = createExpense(ctx(db), { category: 'Транспорт', amount: 40, fromCash: true })
  ackOp(db, opOf(db, 'expense'), { status: 'ok', docId: e.id })
  // Сервер прислал смену уже с этим расходом и сам расход
  delta(db, { shifts: up({ ...view(db, shift.id), deviceId: 'kassa-1', expenseCash: 40 }), expenses: up({ ...e, server: true }) })
  assert.equal(view(db, shift.id).expenseCash, 40)

  const patched = updateExpense(ctx(db), e.id, { amount: 25, note: 'такси' })
  assert.deepEqual([patched.amount, patched.note], [25, 'такси'])
  assert.equal(view(db, shift.id).expenseCash, 25)
  const op = lastOp(db)
  assert.equal(op.type, 'expense.update')
  assert.deepEqual([op.payload.set, op.payload.base, op.payload.ref], [{ amount: 25, note: 'такси' }, { amount: 40, note: '' }, { kind: 'expense', id: e.id }])
  // Свежая копия сервера (без правки) документ не заменяет
  delta(db, { expenses: up({ ...e, server: true }) })
  assert.equal(listDocs(db, 'expense')[0].amount, 25)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'edited')

  // Сервер принял — разница переходит в сумму смены, документ ждёт серверной копии
  ackOp(db, op, { status: 'ok', docId: e.id })
  assert.equal(view(db, shift.id).expenseCash, 25)
  delta(db, { shifts: up({ ...view(db, shift.id), deviceId: 'kassa-1', expenseCash: 25 }), expenses: up({ ...e, amount: 25, note: 'такси', server: true }) })
  assert.equal(view(db, shift.id).expenseCash, 25)
  assert.equal(listDocs(db, 'expense')[0].server, true)

  deleteExpense(ctx(db), e.id)
  assert.deepEqual(listDocs(db, 'expense'), [])
  assert.equal(view(db, shift.id).expenseCash, 0)
  assert.equal(lastOp(db).type, 'expense.delete')
  // Отказ сервера — расход вернулся, деньги в смене тоже
  rejectOp(db, lastOp(db), 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.')
  assert.equal(listDocs(db, 'expense')[0].amount, 25)
  assert.equal(view(db, shift.id).expenseCash, 25)
})

test('расход, внесённый без связи и поправленный до отправки: заведение принято, правка ждёт — сумма смены ровно одна', () => {
  const db = shop()
  const shift = syncedShift(db)
  const e = createExpense(ctx(db), { category: 'Транспорт', amount: 40, fromCash: true })
  updateExpense(ctx(db), e.id, { amount: 60 })
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'pending')
  assert.equal(view(db, shift.id).expenseCash, 60)
  // Сервер принял заведение (40) — правка ещё в очереди. Документ «поправлен здесь», а
  // разница правки (+20) — её поправкой суммы: не 40 + 60 и не одни 40
  ackOp(db, opOf(db, 'expense'), { status: 'ok', docId: e.id })
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'edited')
  assert.equal(view(db, shift.id).expenseCash, 60)
  // Пришла смена с сервера — с заведением, но без правки
  delta(db, { shifts: up({ ...view(db, shift.id), deviceId: 'kassa-1', expenseCash: 40 }), expenses: up({ ...e, server: true }) })
  assert.equal(view(db, shift.id).expenseCash, 60)
  assert.equal(listDocs(db, 'expense')[0].amount, 60, 'серверная копия без правки не заменяет поправленный здесь')
  deleteExpense(ctx(db), e.id)
  assert.deepEqual(ops(db).map((o) => o.type), ['expense.update', 'expense.delete'])
  assert.equal(view(db, shift.id).expenseCash, 0)
})

test('заведение принято, а правку сервер отверг: документ — как у сервера, ничего не «ждёт» и не считается дважды', () => {
  const db = shop()
  const shift = syncedShift(db)
  const e = createExpense(ctx(db), { category: 'Транспорт', amount: 40, fromCash: true })
  updateExpense(ctx(db), e.id, { amount: 60 })
  ackOp(db, opOf(db, 'expense'), { status: 'ok', docId: e.id })
  rejectOp(db, opOf(db, 'expense.update'), 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.')
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'synced')
  assert.equal(listDocs(db, 'expense')[0].amount, 40)
  assert.equal(view(db, shift.id).expenseCash, 40, 'сервер знает расход в 40 — столько и в смене')
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM docs WHERE sync = 'pending'").n, 0, 'документ не должен остаться «неотправленным» навсегда')
  // Полная копия сервера заменяет его как обычный
  applyPull(db, { full: true, cursor: '200', data: { expenses: up({ ...e, amount: 40, note: 'с сайта', server: true }), shifts: up({ ...view(db, shift.id), deviceId: 'kassa-1', expenseCash: 40 }) } }, { now: NOW })
  assert.equal(listDocs(db, 'expense')[0].note, 'с сайта')
  assert.equal(view(db, shift.id).expenseCash, 40)
})

test('две правки известного серверу документа: первую приняли, вторую отвергли — документ снова обычный', () => {
  const db = shop()
  syncedShift(db)
  const x = createIncome(ctx(db), { category: 'Аренда', amount: 300 })
  ackOp(db, opOf(db, 'income'), { status: 'ok', docId: x.id })
  updateIncome(ctx(db), x.id, { note: 'один' })
  updateIncome(ctx(db), x.id, { note: 'два' })
  ackOp(db, opOf(db, 'income.update'), { status: 'ok', docId: x.id })
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'income'").sync, 'edited', 'вторая правка ещё ждёт')
  rejectOp(db, opOf(db, 'income.update'), 'Доход не найден')
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'income'").sync, 'synced')
  assert.equal(listDocs(db, 'income')[0].note, 'один')
  // Свежая копия сервера (правку там поправили ещё раз) — ложится
  delta(db, { incomes: up({ ...x, note: 'с сайта', server: true }) })
  assert.equal(listDocs(db, 'income')[0].note, 'с сайта')
})

test('приход в долг, поправленный до отправки: заведение принято — долг поставщику ровно один раз', () => {
  const db = shop({ suppliers: SUPPLIERS })
  const a = createArrival(ctx(db), { supplierId: 'sup-1', debt: 100, items: [{ productId: 'nur', qty: 1, cost: 100 }] })
  assert.equal(debtOf(db, 'sup-1'), 600)
  const v = arrivalView(db, a.id)
  updateArrival(ctx(db), a.id, { supplierId: 'sup-1', debt: 200, items: [{ id: v.items[0].id, qty: 2, cost: 100 }] })
  assert.equal(debtOf(db, 'sup-1'), 700)
  ackOp(db, opOf(db, 'arrival'), { status: 'ok', docId: a.id })
  assert.equal(debtOf(db, 'sup-1'), 700, 'заведение (100) — в долг сервера, правка (+100) — своей поправкой')
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'arrival'").sync, 'edited')
  // Пришёл поставщик с сервера — с заведением, без правки
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 600 }) })
  assert.equal(debtOf(db, 'sup-1'), 700)
  // Правку приняли — разница переходит в долг сервера
  ackOp(db, opOf(db, 'arrival.update'), { status: 'ok', docId: a.id })
  assert.equal(debtOf(db, 'sup-1'), 700)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'arrival'").sync, 'synced')
})

test('приход, удалённый до отправки: деньги из ящика числятся за заведением, а не за удалением', () => {
  const db = shop({ suppliers: SUPPLIERS })
  const shift = syncedShift(db)
  const a = createArrival(ctx(db), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 100, items: [{ productId: 'nur', qty: 1, cost: 100 }] })
  const paid = view(db, shift.id).supplierCash
  assert.equal(paid, 100)
  deleteArrival(ctx(db), a.id)
  assert.equal(view(db, shift.id).supplierCash, paid, 'деньги из ящика уже отданы')
  ackOp(db, opOf(db, 'arrival'), { status: 'ok', docId: a.id })
  assert.equal(view(db, shift.id).supplierCash, paid)
  // Удаление сервер отверг — оплата, записанная с приходом, у него осталась
  rejectOp(db, opOf(db, 'arrival.delete'), 'Приход не найден')
  assert.equal(view(db, shift.id).supplierCash, paid)
})

test('расход: закрытая смена, статья не из списка, кассир — отказ теми же словами, что у сервера', () => {
  const db = shop()
  syncedShift(db)
  const e = createExpense(ctx(db), { category: 'Транспорт', amount: 40, fromCash: true })
  refused(() => updateExpense(ctx(db), e.id, { category: 'Ремонт' }), 400, 'Этой статьи расходов уже нет в списке — добавьте её в настройках')
  closeShift(ctx(db), { countedCash: 460 })
  refused(() => updateExpense(ctx(db), e.id, { amount: 1 }), 400, SHIFT_CLOSED)
  refused(() => deleteExpense(ctx(db), e.id), 400, SHIFT_CLOSED)
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassa', role: 'cashier', permissions: ['expenses.create'] }
  const found = matchLocal('PATCH', '/expenses/' + e.id)
  refused(() => found.handler({ ...ctx(db, { user: cashier }), params: found.params, query: {}, body: { amount: 1 } }), 403, 'Недостаточно прав')
})

// ════════════════════════ Доход, внесение ════════════════════════

test('доход: правка и удаление без связи', () => {
  const db = shop()
  const x = createIncome(ctx(db), { category: 'Аренда', amount: 300 })
  const y = updateIncome(ctx(db), x.id, { amount: 350, category: 'Услуги' })
  assert.deepEqual([y.amount, y.category], [350, 'Услуги'])
  refused(() => updateIncome(ctx(db), x.id, { category: 'Нет такой' }), 400, 'Этой статьи доходов уже нет в списке — добавьте её в настройках')
  deleteIncome(ctx(db), x.id)
  assert.deepEqual(listDocs(db, 'income'), [])
  assert.deepEqual(ops(db).map((o) => o.type), ['income', 'income.update', 'income.delete'])
})

test('внесение и изъятие: отмена без связи — из смены сразу; закрытая смена — нельзя', () => {
  const db = shop()
  const shift = syncedShift(db)
  const m = createCashMove(ctx(db), { kind: 'in', amount: 100 })
  createCashMove(ctx(db), { kind: 'out', amount: 30 })
  assert.deepEqual([view(db, shift.id).cashIn, view(db, shift.id).cashOut], [100, 30])
  deleteCashMove(ctx(db), m.id)
  assert.deepEqual([view(db, shift.id).cashIn, view(db, shift.id).cashOut], [0, 30])
  const m2 = createCashMove(ctx(db), { kind: 'in', amount: 5 })
  closeShift(ctx(db), { countedCash: 475 })
  refused(() => deleteCashMove(ctx(db), m2.id), 400, SHIFT_CLOSED_CASH)
})

// ════════════════════════ Возврат поставщику ════════════════════════

test('возврат поставщику, который сервер уже знает: удаление возвращает товар в те же партии и долг', () => {
  const db = shop()
  const r = createSupplierReturn(ctx(db), { supplierId: 'sup-1', refund: 'debt', items: [{ productId: 'nur', qty: 3, price: 90 }] })
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [7, 230])
  ackOp(db, opOf(db, 'supplier.return'), { status: 'ok', docId: r.id })
  // Сервер прислал свои данные: долг и остаток уже с возвратом
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 230 }), supplierReturns: up({ ...r, server: true }), products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 7 })) })
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [7, 230])

  deleteSupplierReturn(ctx(db), r.id)
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [10, 500])
  assert.deepEqual(listDocs(db, 'supplierreturn'), [])
  // Свежие данные сервера (он об удалении не знает) — удаление держится
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 230 }), supplierReturns: up({ ...r, server: true }) })
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [10, 500])
  assert.deepEqual(listDocs(db, 'supplierreturn'), [])
  // Принял — данные сервера уже без возврата
  ackOp(db, lastOp(db), { status: 'ok', docId: r.id })
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 500 }), supplierReturns: { upsert: [], remove: [r.id] }, products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10 })) })
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [10, 500])
})

test('возврат поставщику, ещё не отправленный: удаление возвращает всё, ничего не задваивая; «в кассу» закрытой смены — нельзя', () => {
  const db = shop()
  const r = createSupplierReturn(ctx(db), { supplierId: 'sup-1', refund: 'debt', items: [{ productId: 'nur', qty: 2, price: 90 }] })
  deleteSupplierReturn(ctx(db), r.id)
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [10, 500])
  assert.deepEqual(ops(db).map((o) => o.type), ['supplier.return', 'supplierReturn.delete'])
  syncedShift(db)
  const cash = createSupplierReturn(ctx(db), { supplierId: 'sup-1', refund: 'cash', items: [{ productId: 'nur', qty: 1, price: 90 }] })
  closeShift(ctx(db), { countedCash: 590 })
  refused(() => deleteSupplierReturn(ctx(db), cash.id), 400, CLOSED_SHIFT_REFUND)
})

// ════════════════════════ Приход ════════════════════════

test('приход: окно правки знает проданное; правка и удаление двигают склад, цену закупки и долг', () => {
  const db = shop()
  syncedShift(db)
  const a = createArrival(ctx(db), { supplierId: 'sup-1', debt: 200, items: [{ productId: 'nur', qty: 4, cost: 50 }] })
  assert.deepEqual([prod(db, 'nur').stock, debtOf(db, 'sup-1')], [14, 700])
  ackOp(db, opOf(db, 'arrival'), { status: 'ok', docId: a.id })
  // Сервер прислал всё уже с приходом: партия прихода, долг, средняя цена (10×100 + 4×50)/14
  delta(db, {
    arrivals: up({ ...a, server: true }),
    suppliers: up({ ...SUPPLIERS[0], debt: 700 }),
    products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 85.71, price: 150, stock: 14 })),
    batches: up(
      { id: 'b-old', productId: 'nur', units: 10, cost: 100, expiryDate: null, arrivalId: null, createdAt: '2026-09-01T08:00:00.000Z' },
      { id: 'b-arr', productId: 'nur', units: 4, cost: 50, expiryDate: null, arrivalId: a.id, createdAt: '2026-10-04T10:00:00.000Z' },
    ),
  })
  // Продали одну пачку — из партии прихода (она тоже бессрочная, но заведена позже → вторая)
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 11 }] })
  let v = arrivalView(db, a.id)
  assert.deepEqual([v.items[0].soldUnits, v.items[0].minQty], [1, 1])
  refused(() => updateArrival(ctx(db), a.id, { items: [{ id: a.items[0].id, qty: 0, cost: 50 }] }), 400, 'В приходе не осталось ни одной позиции. Чтобы убрать его целиком, удалите приход.')
  updateArrival(ctx(db), a.id, { supplierId: 'sup-1', debt: 60, items: [{ id: a.items[0].id, qty: 2, cost: 60 }] })
  // На полке: 0 старых + (2 − 1 проданная) = 1 пачка прихода
  assert.equal(prod(db, 'nur').stock, 1)
  assert.equal(prod(db, 'nur').cost, 60)
  // Долг: был 200 по приходу, стал 60
  assert.equal(debtOf(db, 'sup-1'), 560)
  v = arrivalView(db, a.id)
  assert.deepEqual([v.total, v.debt, v.items[0].qty], [120, 60, 2])
  const op = lastOp(db)
  assert.equal(op.type, 'arrival.update')
  assert.deepEqual(op.payload.arrival.items, [{ id: a.items[0].id, qty: 2, pieces: 0, cost: 60 }])

  deleteArrival(ctx(db), a.id)
  assert.equal(prod(db, 'nur').stock, 0)
  assert.equal(debtOf(db, 'sup-1'), 500)
  assert.deepEqual(listDocs(db, 'arrival'), [])
  // Отказ сервера в удалении — приход и всё вокруг на месте
  rejectOp(db, lastOp(db), 'Приход не найден')
  // Остаток пересчитывает ближайший обмен — он идёт сразу за отказом
  delta(db, {})
  assert.equal(prod(db, 'nur').stock, 1)
  assert.equal(debtOf(db, 'sup-1'), 560)
  assert.equal(listDocs(db, 'arrival')[0].total, 120)
})

test('приход ниже проданного не поправить — тем же текстом, что у сервера', () => {
  const db = shop({ products: [product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 0 })] })
  syncedShift(db)
  const a = createArrival(ctx(db), { items: [{ productId: 'nur', qty: 5, cost: 50 }] })
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 3 }] })
  refused(
    () => updateArrival(ctx(db), a.id, { items: [{ id: a.items[0].id, qty: 2, cost: 50 }] }),
    400,
    '«Нурофен»: из этого прихода уже продано 3 шт (3 уп). Меньше проданного поставить нельзя — этого товара на полке уже нет.',
  )
})

test('давний период с сервера: поправленное здесь заменяет его копию, удалённое — убирает', () => {
  const db = shop()
  const x = createIncome(ctx(db), { category: 'Аренда', amount: 300 })
  ackOp(db, opOf(db, 'income'), { status: 'ok', docId: x.id })
  updateIncome(ctx(db), x.id, { amount: 1 })
  const y = createIncome(ctx(db), { category: 'Услуги', amount: 5 })
  ackOp(db, ops(db).find((o) => o.type === 'income'), { status: 'ok', docId: y.id })
  deleteIncome(ctx(db), y.id)
  const mine = pendingInPeriod(db, 'income', { from: null, to: null })
  assert.deepEqual(mine.map((d) => [d.id, d.amount, !!d.__deleted]).sort(), [[x.id, 1, false], [y.id, 5, true]].sort())
})

test('закрытие смены отвергнуто: суммы смены без неотправленных правок и оплат — не дважды', () => {
  const db = shop({ suppliers: SUPPLIERS })
  const shift = syncedShift(db)
  const e = createExpense(ctx(db), { category: 'Транспорт', amount: 40, fromCash: true })
  ackOp(db, opOf(db, 'expense'), { status: 'ok', docId: e.id })
  delta(db, { shifts: up({ ...view(db, shift.id), deviceId: 'kassa-1', expenseCash: 40 }), expenses: up({ ...e, server: true }) })
  updateExpense(ctx(db), e.id, { amount: 60 })
  createArrival(ctx(db), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 30, items: [{ productId: 'nur', qty: 1, cost: 30 }] })
  assert.deepEqual([view(db, shift.id).expenseCash, view(db, shift.id).supplierCash], [60, 30])
  closeShift(ctx(db), { countedCash: 410 })
  rejectOp(db, opOf(db, 'shift.close'), 'Смена уже закрыта на сайте')
  const reopened = view(db, shift.id)
  assert.equal(reopened.closedAt, null)
  assert.deepEqual([reopened.expenseCash, reopened.supplierCash], [60, 30], 'неотправленное посчитано дважды')
})
