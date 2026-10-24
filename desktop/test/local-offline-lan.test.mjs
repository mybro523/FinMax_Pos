// ── Обмен кассами по сети: справочники и правки документов ──
//
// С версии 1.4.14 кассы передают друг другу без интернета и правки справочников: новый
// товар (вместе с начальным остатком), поставщика, категорию, правку цены, оплату
// поставщику, удаление расхода. У соседа правка лежит поправкой — до приёма сервером
// или до отказа. Операция, которая ссылается на товар, заведённый соседом, ждёт, пока
// сосед отправит свой товар: иначе сервер не узнал бы, о каком товаре речь.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { productsList, categoriesList } from '../src/local/catalog.mjs'
import { listDocs, listShifts } from '../src/local/docs.mjs'
import { lanBeforePull, lanCatchUp, lanEntriesSince, lanFate, lanGen, lanNextGen, lanReceive, redact, waitsForPeer } from '../src/local/lan.mjs'
import { getMeta } from '../src/local/db.mjs'
import { createExpense } from '../src/local/ops/expense.mjs'
import { deleteExpense, updateExpense } from '../src/local/ops/docedits.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { arrivalView, deleteArrival, updateArrival } from '../src/local/ops/arrivaledit.mjs'
import { createProduct, updateProduct } from '../src/local/ops/products.mjs'
import { updateCategory } from '../src/local/ops/refs.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { openShift, shiftView } from '../src/local/ops/shift.mjs'
import { createSupplier, paySupplier } from '../src/local/ops/supplierops.mjs'
import { ackOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { suppliersList } from '../src/local/suppliers.mjs'
import { ctx, NOW, pharmacy, product, row, SUPPLIERS } from '../test-support/pharmacy.mjs'

const A = 'kassa-A'
const B = 'kassa-B'
const shop = () => pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', price: 150, cost: 100, stock: 5, category: 'Таблетки' })] })
const owner = { accountId: 'acc-o', id: 'u-owner', name: 'admin', role: 'founder' }
const atA = (db) => ctx(db, { deviceId: A, user: owner })
const atB = (db) => ctx(db, { deviceId: B, user: { accountId: 'acc-k', id: 'u-kassir', name: 'kassir', role: 'cashier', permissions: ['pos.sell', 'shift.open'] } })
const ownerAtB = (db) => ctx(db, { deviceId: B, user: { ...owner, accountId: 'acc-o2', id: 'u-owner2' } })
const prods = (db) => productsList(db, NOW).map((p) => [p.name, p.stock, p.price])
const up = (...list) => ({ upsert: list, remove: [] })

function pass(from, fromId, to, { wide = true } = {}) {
  lanCatchUp(from, { deviceId: fromId, now: NOW })
  const out = lanEntriesSince(from, 0, { wide })
  return lanReceive(to, out.entries, { now: NOW, gen: lanGen(to) })
}
function serverPull(db, data, startedGen = lanNextGen(db)) {
  lanBeforePull(db, data, { startedGen, now: NOW })
  return applyPull(db, { full: false, cursor: String(1000 + startedGen), data }, { now: NOW })
}

test('новый товар соседа — со своим остатком; продажа его товара ждёт, пока сосед отправит товар', () => {
  const a = shop()
  const b = shop()
  const p = createProduct(atA(a), { name: 'Анальгин', barcode: '4600000000031', price: 30, cost: 20, stock: 6 })
  const r = pass(a, A, b)
  assert.ok(r.changed.includes('products'))
  assert.deepEqual(prods(b), [['Анальгин', 6, 30], ['Нурофен', 5, 150]])

  // Кассир на B продаёт товар соседа — операция ждёт: сервер этот товар ещё не знает
  openShift(atB(b), { openingCash: 0 })
  checkout(atB(b), { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })
  assert.equal(productsList(b, NOW).find((x) => x.id === p.id).stock, 4)
  const sale = pendingOps(b, 10).find((o) => o.type === 'sale')
  assert.equal(waitsForPeer(b, sale), true)

  // A отправила товар, сервер принял, A сообщила об этом — после обмена B продажа уходит
  const op = pendingOps(a, 10).find((o) => o.type === 'product.create')
  ackOp(a, op, { status: 'ok', docId: p.id })
  lanFate(a, op.id, 'ok', null, { deviceId: A, now: NOW })
  pass(a, A, b)
  serverPull(b, { products: up(product({ id: p.id, name: 'Анальгин', barcode: '4600000000031', price: 30, cost: 20, stock: 6 })) })
  assert.equal(waitsForPeer(b, sale), false)
  // Остаток соседского товара у B — с сервера и со своей продажей, без задвоения
  assert.equal(productsList(b, NOW).find((x) => x.id === p.id).stock, 4)
  assert.equal(row(b, "SELECT COUNT(*) AS n FROM row_edits WHERE synced = 0").n, 0)
})

test('правка цены и переименование категории у соседа; отказ сервера — всё возвращается', () => {
  const a = shop()
  const b = shop()
  updateProduct(atA(a), 'nur', { price: 170 })
  updateCategory(atA(a), 'cat1', { name: 'Лекарства' })
  pass(a, A, b)
  assert.deepEqual(prods(b), [['Нурофен', 5, 170]])
  assert.equal(productsList(b, NOW)[0].category, 'Лекарства')
  assert.ok(categoriesList(b).some((c) => c.name === 'Лекарства'))
  // Свежие данные сервера у B (он о правке не знает) — поправка соседа остаётся
  serverPull(b, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', price: 150, cost: 100, stock: 5, category: 'Таблетки' })) })
  assert.deepEqual(prods(b), [['Нурофен', 5, 170]])
  // Сервер отверг правку цены — A сообщила, у B цена прежняя
  const op = pendingOps(a, 10).find((o) => o.type === 'product.update')
  lanFate(a, op.id, 'rejected', 'Недостаточно прав', { deviceId: A, now: NOW })
  pass(a, A, b)
  assert.deepEqual(prods(b), [['Нурофен', 5, 150]])
})

test('оплата поставщику и удаление расхода — владельцу целиком, кассиру без денег', () => {
  const a = shop()
  const wideB = shop()
  const narrowB = shop()
  const sup = createSupplier(atA(a), { name: 'Хлебозавод', openingDebt: 100 })
  paySupplier(atA(a), 'sup-1', { amount: 200 })
  const e = createExpense(atA(a), { category: 'Аренда', amount: 50 })
  deleteExpense(atA(a), e.id)
  pass(a, A, wideB, { wide: true })
  assert.equal(suppliersList(wideB, true).find((s) => s.id === 'sup-1').debt, 300)
  assert.equal(suppliersList(wideB, true).find((s) => s.id === sup.id).debt, 100)
  assert.deepEqual(listDocs(wideB, 'expense'), [])
  // Кассе без прав: поставщик — без долга, оплата и расход не уходят вовсе
  pass(a, A, narrowB, { wide: false })
  const brief = suppliersList(narrowB, false).find((s) => s.id === sup.id)
  assert.deepEqual([brief.name, 'debt' in brief], ['Хлебозавод', false])
  assert.equal(row(narrowB, 'SELECT sDebtC FROM suppliers WHERE id = ?', sup.id).sDebtC, null)
  assert.equal(row(narrowB, "SELECT COUNT(*) AS n FROM docs WHERE kind IN ('supplierpayment', 'expense')").n, 0)
  // Урезание само по себе: из поставщика уходят деньги, из списка — оплата
  lanCatchUp(a, { deviceId: A, now: NOW })
  const entries = lanEntriesSince(a, 0, { wide: true }).entries
  const created = entries.find((x) => x.type === 'supplier.create')
  const cut = redact(created)
  assert.equal(JSON.parse(cut.body).effects.edits.rows[0].data.row.sDebtC, undefined)
  assert.equal(redact(entries.find((x) => x.type === 'supplier.pay')), null)
})

test('оплата поставщику с соседней кассы: после подтверждения долг как у сервера — без второго вычета', () => {
  const a = shop()
  const b = shop()
  paySupplier(atA(a), 'sup-1', { amount: 100 })
  pass(a, A, b)
  assert.equal(suppliersList(b, true).find((s) => s.id === 'sup-1').debt, 400)
  // A отправила, сервер принял
  const op = pendingOps(a, 10).find((o) => o.type === 'supplier.pay')
  ackOp(a, op, { status: 'ok', docId: op.payload.payment.id })
  lanFate(a, op.id, 'ok', null, { deviceId: A, now: NOW })
  // B успела забрать у сервера поставщика уже с этой оплатой — раньше, чем узнала, что её приняли
  serverPull(b, { suppliers: up({ ...SUPPLIERS[0], debt: 400 }) })
  // Известие пришло; следующий обмен B — без поставщика (он с тех пор не менялся)
  pass(a, A, b)
  serverPull(b, {})
  assert.equal(suppliersList(b, true).find((s) => s.id === 'sup-1').debt, 400, 'оплата соседа вычтена второй раз')
  assert.equal(row(b, 'SELECT COUNT(*) AS n FROM adj_moves WHERE synced = 0').n, 0)
})

test('правка документа соседа: ждёт, пока сосед отправит документ, и не пропадает молча', () => {
  const a = shop()
  const b = shop()
  const e = createExpense(atA(a), { category: 'Аренда', amount: 50 })
  pass(a, A, b)
  assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'peer')
  // Владелец на B поправил расход, заведённый на A, — документ по-прежнему «от соседа»
  updateExpense(ownerAtB(b), e.id, { amount: 70 })
  assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'peer')
  const edit = pendingOps(b, 10).find((o) => o.type === 'expense.update')
  assert.equal(waitsForPeer(b, edit), true, 'правка ушла бы раньше заведения и пропала бы')
  // A отправила расход, сервер принял, A сообщила
  const op = pendingOps(a, 10).find((o) => o.type === 'expense')
  ackOp(a, op, { status: 'ok', docId: e.id })
  lanFate(a, op.id, 'ok', null, { deviceId: A, now: NOW })
  pass(a, A, b)
  serverPull(b, { expenses: up({ ...e, server: true }) })
  assert.equal(waitsForPeer(b, edit), false)
  assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'edited')
  assert.equal(listDocs(b, 'expense')[0].amount, 70, 'серверная копия без правки B не заменяет её')
})

test('отказ правки соседа: документ возвращается «от соседа», а не становится своим неотправленным', () => {
  const a = shop()
  const b = shop()
  const e = createExpense(atA(a), { category: 'Аренда', amount: 50 })
  updateExpense(atA(a), e.id, { amount: 80 })
  pass(a, A, b)
  assert.equal(listDocs(b, 'expense')[0].amount, 80)
  const created = pendingOps(a, 10).find((o) => o.type === 'expense')
  const edited = pendingOps(a, 10).find((o) => o.type === 'expense.update')
  ackOp(a, created, { status: 'ok', docId: e.id })
  rejectOp(a, edited, 'Расход не найден')
  lanCatchUp(a, { deviceId: A, now: NOW })
  pass(a, A, b)
  assert.equal(listDocs(b, 'expense')[0].amount, 50)
  assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'peer')
  assert.equal(row(b, "SELECT COUNT(*) AS n FROM docs WHERE sync = 'pending'").n, 0)
  // Заведение подтвердилось — документ обычный
  serverPull(b, { expenses: up({ ...e, server: true }) })
  assert.equal(row(b, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'synced')
})

test('правка прихода на соседней кассе не возвращает на полку то, что здесь из него продали', () => {
  const a = shop()
  const b = shop()
  // Приход 10 шт со сроком раньше остатка на полке — продажа возьмёт из него
  const arr = createArrival(atA(a), { supplier: 'Склад', items: [{ productId: 'nur', qty: 10, cost: 90, expiryDate: '2026-12-31' }] })
  pass(a, A, b)
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 15)
  // Кассир на B продал 3 из этого прихода
  openShift(atB(b), { openingCash: 0 })
  checkout(atB(b), { payment: 'cash', items: [{ productId: 'nur', qty: 3 }] })
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 12)
  // A, ещё не зная о продаже, правит приход: 15 вместо 10
  const v = arrivalView(a, arr.id)
  updateArrival(atA(a), arr.id, { items: [{ id: v.items[0].id, qty: 15, cost: 90 }] })
  assert.equal(productsList(a, NOW).find((p) => p.id === 'nur').stock, 20)
  pass(a, A, b)
  pass(b, B, a)
  // Как посчитает сервер: в приходе было 10, продано 3, стало 15 — на полке от него 12, всего 17
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 17, 'у B проданное вернулось на полку')
  assert.equal(productsList(a, NOW).find((p) => p.id === 'nur').stock, 17)
})

const debtOf = (db, id) => suppliersList(db, true).find((s) => s.id === id)?.debt
const syncedShiftAt = (db, c) => {
  const sh = openShift(c, { openingCash: 500 })
  ackOp(db, pendingOps(db, 100).find((o) => o.type === 'shift.open'), { status: 'ok', docId: sh.id })
  return sh
}

test('правка соседа к документу, который здесь сервер уже знает: долг — с разницей правки, без задвоения', () => {
  const a = shop()
  const b = shop()
  const arr = createArrival(atA(a), { supplierId: 'sup-1', debt: 100, items: [{ productId: 'nur', qty: 1, cost: 100 }] })
  pass(a, A, b)
  // У A заведение приняли; у B документ ещё «от соседа» — B правит его без поправки суммы
  ackOp(a, pendingOps(a, 10).find((o) => o.type === 'arrival'), { status: 'ok', docId: arr.id })
  assert.equal(debtOf(a, 'sup-1'), 600)
  const v = arrivalView(b, arr.id)
  updateArrival(ownerAtB(b), arr.id, { supplierId: 'sup-1', debt: 50, items: [{ id: v.items[0].id, qty: 1, cost: 100 }] })
  pass(b, B, a)
  assert.equal(listDocs(a, 'arrival')[0].debt, 50)
  assert.equal(debtOf(a, 'sup-1'), 550, 'правка соседа видна в документе, но не в долге')
})

test('свой документ ещё не принят (ответ потерялся), а сосед правит его с поправкой суммы — здесь сумма одна', () => {
  const a = shop()
  const b = shop()
  const sh = syncedShiftAt(a, atA(a))
  const e = createExpense(atA(a), { category: 'Аренда', amount: 40, fromCash: true })
  // B узнал расход от сервера (A его отправила, а ответ до A не дошёл) и поправил: 40 → 60
  serverPull(b, { expenses: up({ ...e, server: true }) })
  updateExpense(ownerAtB(b), e.id, { amount: 60 })
  pass(b, B, a)
  const view = shiftView(a, listShifts(a, A).find((x) => x.id === sh.id))
  assert.equal(view.expenseCash, 60, 'сумма документа и поправка соседа посчитаны дважды')
})

test('сосед удалил неотправленный приход, оплаченный из ящика этой кассы: деньги в смене остаются', () => {
  const a = shop()
  const b = shop()
  const sh = syncedShiftAt(a, atA(a))
  const arr = createArrival(atA(a), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 100, items: [{ productId: 'nur', qty: 1, cost: 100 }] })
  const view = () => shiftView(a, listShifts(a, A).find((x) => x.id === sh.id))
  assert.equal(view().supplierCash, 100)
  pass(a, A, b)
  deleteArrival(ownerAtB(b), arr.id)
  pass(b, B, a)
  assert.equal(row(a, "SELECT sync FROM docs WHERE kind = 'arrival'").sync, 'deleted')
  assert.equal(view().supplierCash, 100, 'оплату из ящика сервер всё равно заведёт')
  // Заведение приняли — деньги переходят в сумму смены сервера, а не пропадают
  ackOp(a, pendingOps(a, 10).find((o) => o.type === 'arrival'), { status: 'ok', docId: arr.id })
  assert.equal(view().supplierCash, 100)
})

test('отвергнутый документ чужая правка не воскрешает', () => {
  const a = shop()
  const b = shop()
  const e = createExpense(atA(a), { category: 'Аренда', amount: 40 })
  pass(a, A, b)
  rejectOp(a, pendingOps(a, 10).find((o) => o.type === 'expense'), 'Недостаточно прав')
  updateExpense(ownerAtB(b), e.id, { amount: 70 })
  pass(b, B, a)
  assert.equal(row(a, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'rejected')
  assert.equal(listDocs(a, 'expense').length, 0)
})

test('приход, поправленный соседом, отвергнут при заведении: лишнего товара на полке нет', () => {
  const a = shop()
  const b = shop()
  const arr = createArrival(atA(a), { supplier: 'Склад', items: [{ productId: 'nur', qty: 10, cost: 90 }] })
  pass(a, A, b)
  const v = arrivalView(b, arr.id)
  updateArrival(ownerAtB(b), arr.id, { items: [{ id: v.items[0].id, qty: 15, cost: 90 }] })
  pass(b, B, a)
  rejectOp(a, pendingOps(a, 10).find((o) => o.type === 'arrival'), 'Поставщик не найден')
  lanCatchUp(a, { deviceId: A, now: NOW })
  pass(a, A, b)
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 5, 'у B на полке товар из ничего')
  // У A полка пересчитывается при ближайшем обмене после отказа
  serverPull(a, {})
  assert.equal(productsList(a, NOW).find((p) => p.id === 'nur').stock, 5, 'у A на полке товар из ничего')
})

test('запись соседа пришла поздно, а документ уже с сервера и поправлен здесь: остаток не задваивается', () => {
  const a = shop()
  const b = shop()
  const arr = createArrival(atA(a), { supplier: 'Склад', items: [{ productId: 'nur', qty: 10, cost: 90 }] })
  lanCatchUp(a, { deviceId: A, now: NOW })
  const op = pendingOps(a, 10).find((o) => o.type === 'arrival')
  ackOp(a, op, { status: 'ok', docId: arr.id })
  lanFate(a, op.id, 'ok', null, { deviceId: A, now: NOW })
  // B забрал приход у сервера и поправил его — и только потом увидел A по сети
  serverPull(b, {
    arrivals: up({ ...arr, server: true }),
    products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', price: 150, cost: 95, stock: 15, category: 'Таблетки' })),
    batches: up(
      { id: 'b-old', productId: 'nur', units: 5, cost: 100, expiryDate: null, arrivalId: null, createdAt: '2026-09-01T08:00:00.000Z' },
      { id: 'b-arr', productId: 'nur', units: 10, cost: 90, expiryDate: null, arrivalId: arr.id, createdAt: '2026-10-04T10:00:00.000Z' },
    ),
  })
  const v = arrivalView(b, arr.id)
  updateArrival(ownerAtB(b), arr.id, { items: [{ id: v.items[0].id, qty: 12, cost: 90 }] })
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 17)
  pass(a, A, b)
  assert.equal(productsList(b, NOW).find((p) => p.id === 'nur').stock, 17, 'приход соседа лёг второй раз')
})

test('урезанная запись соседа пришла целиком: своя более поздняя правка того же прихода остаётся', () => {
  const b = shop()
  const c = shop()
  const atC = (db) => ctx(db, { deviceId: 'kassa-C', user: { ...owner, accountId: 'acc-c', id: 'u-c' } })
  const a0 = createArrival(ownerAtB(b), { supplierId: 'sup-1', debt: 100, items: [{ productId: 'nur', qty: 2, cost: 100 }] })
  ackOp(b, pendingOps(b, 10).find((o) => o.type === 'arrival'), { status: 'ok', docId: a0.id })
  applyPull(c, { full: false, cursor: '5', data: { arrivals: up({ ...a0 }), suppliers: up({ ...SUPPLIERS[0], debt: 600 }) } }, { now: NOW })
  const v = arrivalView(b, a0.id)
  updateArrival(ownerAtB(b), a0.id, { supplierId: 'sup-1', debt: 50, items: [{ id: v.items[0].id, qty: 2, cost: 100 }] })
  pass(b, B, c, { wide: false })
  const vc = arrivalView(c, a0.id)
  updateArrival(atC(c), a0.id, { supplierId: 'sup-1', debt: 20, items: [{ id: vc.items[0].id, qty: 2, cost: 100 }] })
  pass(b, B, c, { wide: true })
  assert.equal(listDocs(c, 'arrival')[0].debt, 20, 'поздняя правка этой кассы перекрыта старой правкой соседа')
})

test('новый товар соседа пришёл с сервера — операции с ним не ждут известия от соседа', () => {
  const a = shop()
  const b = shop()
  const p = createProduct(atA(a), { name: 'Новинка', barcode: '4600000000048', price: 30, cost: 20, stock: 6 })
  pass(a, A, b)
  openShift(atB(b), { openingCash: 0 })
  checkout(atB(b), { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  const sale = pendingOps(b, 10).find((o) => o.type === 'sale')
  assert.equal(waitsForPeer(b, sale), true)
  // A отправила товар и выключилась, не успев сообщить; B забрала у сервера этот товар
  serverPull(b, { products: up(product({ id: p.id, name: 'Новинка', barcode: '4600000000048', price: 30, cost: 20, stock: 6 })) })
  assert.equal(waitsForPeer(b, sale), false)
  assert.equal(productsList(b, NOW).find((x) => x.id === p.id).stock, 5, 'остаток: 6 с сервера − 1 своя продажа')
})

test('удалён здесь, пока заведение ждёт ответа; правку соседа отвергли — документ не возвращается', () => {
  const a = shop()
  const b = shop()
  const sh = syncedShiftAt(a, atA(a))
  const e = createExpense(atA(a), { category: 'Аренда', amount: 40, fromCash: true })
  serverPull(b, { expenses: up({ ...e, server: true }) })
  updateExpense(ownerAtB(b), e.id, { amount: 60 })
  pass(b, B, a)
  deleteExpense(atA(a), e.id)
  const edit = pendingOps(b, 10).find((o) => o.type === 'expense.update')
  rejectOp(b, edit, 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.')
  pass(b, B, a)
  assert.equal(row(a, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'deleted')
  assert.equal(listDocs(a, 'expense').length, 0)
  const view = shiftView(a, listShifts(a, A).find((x) => x.id === sh.id))
  assert.equal(view.expenseCash, 0, 'удалённый расход снова посчитан')
})

test('приход удалён здесь, заведение отвергнуто; правка соседа (сделанная раньше) не возвращает его', () => {
  const a = shop()
  const b = shop()
  const arr = createArrival(atA(a), { supplier: 'Склад', items: [{ productId: 'nur', qty: 10, cost: 90 }] })
  pass(a, A, b)
  const v = arrivalView(b, arr.id)
  updateArrival(ownerAtB(b), arr.id, { items: [{ id: v.items[0].id, qty: 15, cost: 90 }] })
  deleteArrival(atA(a), arr.id)
  rejectOp(a, pendingOps(a, 10).find((o) => o.type === 'arrival'), 'Поставщик не найден')
  pass(b, B, a)
  serverPull(a, {})
  assert.equal(listDocs(a, 'arrival').length, 0, 'отвергнутый и удалённый приход снова в журнале')
  assert.equal(productsList(a, NOW).find((p) => p.id === 'nur').stock, 5, 'товар из ничего')
})

test('приход, оплаченный из ящика, удалён здесь; правка соседа пришла позже: деньги в смене, призрака в журнале нет', () => {
  const a = shop()
  const b = shop()
  const sh = syncedShiftAt(a, atA(a))
  const arr = createArrival(atA(a), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 100, items: [{ productId: 'nur', qty: 10, cost: 100 }] })
  const view = () => shiftView(a, listShifts(a, A).find((x) => x.id === sh.id))
  pass(a, A, b)
  const v = arrivalView(b, arr.id)
  updateArrival(ownerAtB(b), arr.id, { items: [{ id: v.items[0].id, qty: 15, cost: 100 }] })
  deleteArrival(atA(a), arr.id)
  pass(b, B, a)
  assert.equal(row(a, "SELECT sync FROM docs WHERE kind = 'arrival'").sync, 'deleted')
  assert.equal(view().supplierCash, 100)
  assert.equal(productsList(a, NOW).find((p) => p.id === 'nur').stock, 5)
  // A отправила: заведение и удаление приняты; сервер убрал приход
  const made = pendingOps(a, 10).find((o) => o.type === 'arrival')
  const del = pendingOps(a, 10).find((o) => o.type === 'arrival.delete')
  ackOp(a, made, { status: 'ok', docId: arr.id })
  ackOp(a, del, { status: 'ok', docId: arr.id })
  assert.equal(listDocs(a, 'arrival').length, 0)
  assert.equal(row(a, "SELECT COUNT(*) AS n FROM docs WHERE kind = 'arrival'").n, 0, 'удалённый приход остался в базе')
  assert.equal(view().supplierCash, 100)
})

test('урезанная запись соседа о документе, которого здесь нет; потом целиком — поправка суммы не теряется', () => {
  const b = shop()
  const c = shop()
  const a0 = createArrival(ownerAtB(b), { supplierId: 'sup-1', debt: 100, items: [{ productId: 'nur', qty: 2, cost: 100 }] })
  ackOp(b, pendingOps(b, 10).find((o) => o.type === 'arrival'), { status: 'ok', docId: a0.id })
  // У C прихода нет, а долг поставщика — как у сервера (с этим приходом)
  applyPull(c, { full: false, cursor: '5', data: { suppliers: up({ ...SUPPLIERS[0], debt: 600 }) } }, { now: NOW })
  const v = arrivalView(b, a0.id)
  updateArrival(ownerAtB(b), a0.id, { supplierId: 'sup-1', debt: 50, items: [{ id: v.items[0].id, qty: 2, cost: 100 }] })
  pass(b, B, c, { wide: false })
  pass(b, B, c, { wide: true })
  assert.equal(debtOf(c, 'sup-1'), 550, 'поправка долга из полной записи потерялась')
  assert.equal(listDocs(c, 'arrival').length, 0, 'из правки завёлся документ, которого здесь не было')
})

test('сосед сообщил «принято, но сервер ничего не сделал» — касса забирает всё заново', () => {
  const a = shop()
  const b = shop()
  updateProduct(atA(a), 'nur', { price: 170 })
  pass(a, A, b)
  assert.deepEqual(prods(b), [['Нурофен', 5, 170]])
  // На сайте цену поправили позже — сервер оставил свою, правке A ответил «ничего не сделано»
  const op = pendingOps(a, 10).find((o) => o.type === 'product.update')
  ackOp(a, op, { status: 'ok', docId: null })
  assert.equal(getMeta(a, 'needFull'), '1')
  lanCatchUp(a, { deviceId: A, now: NOW })
  pass(a, A, b)
  assert.equal(getMeta(b, 'needFull'), '1', 'сосед так и показывал бы цену, которую сервер не принял')
})
