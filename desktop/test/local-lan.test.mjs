// ── Обмен кассами по местной сети: журнал и чужие операции ──
//
// Две настоящие локальные базы — касса кассира (A) и компьютер владельца (B). Интернета
// нет: продажа на A должна появиться у B (журнал, отчёты, остаток), а когда интернет
// вернётся и сервер примет продажу, у B не должно быть ни задвоения остатка, ни потери.
// Проверяем каждый путь: сервер прислал документ; касса A сообщила «принято»; сервер
// отверг; операция так и не дошла. И урезанный журнал для кассы без прав на деньги.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { getMeta, q } from '../src/local/db.mjs'
import { listDocs, listShifts } from '../src/local/docs.mjs'
import {
  lanAskFull,
  lanBeforePull,
  lanCatchUp,
  lanEntriesSince,
  lanFate,
  lanGen,
  lanNextGen,
  lanPeerProgress,
  lanPeerSeen,
  lanPeer,
  lanPrune,
  lanReceive,
  lanWideHere,
  redact,
  waitsForPeer,
} from '../src/local/lan.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { createCustomer } from '../src/local/ops/customer.mjs'
import { createExpense } from '../src/local/ops/expense.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift } from '../src/local/ops/shift.mjs'
import { createWriteOff } from '../src/local/ops/writeoff.mjs'
import { ackOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { unitsOf } from '../src/local/stock.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { ctx, DAY, NOW, pharmacy, product, row } from '../test-support/pharmacy.mjs'

const A = 'kassa-A'
const B = 'kassa-B'
const shop = () => pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
const atA = (db, over = {}) => ctx(db, { deviceId: A, user: { accountId: 'acc-k', id: 'u-kassir', name: 'kassir', role: 'cashier', permissions: ['pos.sell'] }, ...over })
const atB = (db, over = {}) => ctx(db, { deviceId: B, user: { accountId: 'acc-o', id: 'u-owner', name: 'admin', role: 'founder' }, ...over })
const units = (db) => unitsOf(db, 'nur', NOW).units
const opOf = (db, type) => pendingOps(db, 100).find((o) => o.type === type)

// Всё новое из журнала одной кассы — в другую (wide: получатель видит деньги магазина)
function pass(from, fromId, to, { since = 0, wide = true } = {}) {
  lanCatchUp(from, { deviceId: fromId, now: NOW })
  const out = lanEntriesSince(from, since, { wide })
  const r = lanReceive(to, out.entries, { now: NOW, gen: lanGen(to) })
  return { ...r, upTo: out.upTo, entries: out.entries }
}
// Обмен с сервером на кассе: номер обмена — до запроса, поправки — до приёма данных
function serverPull(db, data, startedGen = lanNextGen(db)) {
  lanBeforePull(db, data, { startedGen, now: NOW })
  return applyPull(db, { full: false, cursor: String(1000 + startedGen), data }, { now: NOW })
}
const up = (...list) => ({ upsert: list, remove: [] })

test('продажа кассира без интернета появляется у владельца: журнал и остаток', () => {
  const a = shop()
  const b = shop()
  const sale = checkout(atA(a), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  assert.equal(units(a), 3)

  const r = pass(a, A, b)
  assert.ok(r.changed.includes('sales'))
  assert.ok(r.changed.includes('products'))
  // У владельца — тот же чек с пометкой «от соседней кассы» и остаток за вычетом проданного
  const got = listDocs(b, 'sale')
  assert.deepEqual(got.map((s) => s.id), [sale.id])
  assert.equal(got[0].total, 300)
  assert.equal(row(b, 'SELECT sync FROM docs WHERE kind = ? AND id = ?', 'sale', sale.id).sync, 'peer')
  assert.equal(units(b), 3)
  // Своих неотправленных операций у владельца не появилось: отправит касса A
  assert.equal(pendingOps(b, 100).length, 0)

  // Повтор той же передачи ничего не задваивает
  pass(a, A, b)
  assert.equal(units(b), 3)
  assert.equal(listDocs(b, 'sale').length, 1)
})

test('сервер прислал документ — поправка снимается, остаток не задваивается', () => {
  const a = shop()
  const b = shop()
  const sale = checkout(atA(a), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  pass(a, A, b)
  assert.equal(units(b), 3)

  // Касса A отправила продажу, сервер принял. Владелец получает от сервера и чек, и
  // остаток, в котором продажа уже учтена (3). Поправку надо снять, иначе было бы 1
  serverPull(b, { sales: up({ ...sale }), products: up(product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 3 })) })
  assert.equal(units(b), 3)
  assert.equal(row(b, 'SELECT sync FROM docs WHERE kind = ? AND id = ?', 'sale', sale.id).sync, 'synced')
  assert.equal(row(b, 'SELECT state FROM lan_log WHERE id = ?', opOf(a, 'sale').id).state, 'confirmed')
  assert.equal(row(b, 'SELECT COUNT(*) AS n FROM stock_moves WHERE synced = 0').n, 0)
})

test('касса A сообщила «сервер принял»: поправка снимается обменом, начатым после известия', () => {
  const a = shop()
  const b = shop()
  checkout(atA(a), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  const first = pass(a, A, b)
  // Владелец начал обмен с сервером ДО известия: в его данных продажи ещё может не быть
  const before = lanNextGen(b)

  const op = opOf(a, 'sale')
  ackOp(a, op)
  assert.equal(lanFate(a, op.id, 'ok', null, { deviceId: A, now: NOW }), true)
  const r = pass(a, A, b, { since: first.upTo })
  assert.equal(r.kickSync, true)

  // Этот обмен начат до известия — его данные снимали без продажи: поправка остаётся
  serverPull(b, { products: up(product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })) }, before)
  assert.equal(units(b), 3)
  // Следующий обмен — уже с продажей внутри: поправка снимается
  serverPull(b, { products: up(product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 3 })) })
  assert.equal(units(b), 3)
  assert.equal(row(b, 'SELECT state FROM lan_log WHERE id = ?', op.id).state, 'confirmed')
})

test('сервер отверг продажу соседа — у владельца её больше нет', () => {
  const a = shop()
  const b = shop()
  checkout(atA(a), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  const first = pass(a, A, b)
  assert.equal(units(b), 3)
  const op = opOf(a, 'sale')
  rejectOp(a, op, 'Недостаточно прав')
  lanFate(a, op.id, 'rejected', 'Недостаточно прав', { deviceId: A, now: NOW })
  const r = pass(a, A, b, { since: first.upTo })
  assert.ok(r.changed.includes('sales'))
  assert.equal(listDocs(b, 'sale').length, 0)
  assert.equal(units(b), 5)
  assert.equal(row(b, 'SELECT state FROM lan_log WHERE id = ?', op.id).state, 'rejected')
})

test('чужая операция, не дошедшая до сервера за две недели, снимается', () => {
  const a = shop()
  const b = shop()
  checkout(atA(a), { items: [{ productId: 'nur', qty: 1 }], payment: 'cash' })
  pass(a, A, b)
  assert.equal(units(b), 4)
  assert.equal(lanPrune(b, NOW + 15 * DAY), true)
  assert.equal(units(b), 5)
  assert.equal(listDocs(b, 'sale').length, 0)
})

test('кассе без прав на деньги журнал уходит урезанным; остатки всё равно сходятся', () => {
  const owner = shop()
  const kassa = shop()
  createExpense(atB(owner), { category: 'Аренда', amount: 500 })
  createWriteOff(atB(owner), { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })
  lanCatchUp(owner, { deviceId: B, now: NOW })

  const forKassa = lanEntriesSince(owner, 0, { wide: false })
  // Расход не уходит вовсе, у списания — только движение остатка
  assert.equal(forKassa.entries.length, 1)
  assert.equal(forKassa.entries[0].type, 'writeoff')
  assert.equal(forKassa.entries[0].redacted, 1)
  assert.equal(JSON.parse(forKassa.entries[0].body).effects.docs.length, 0)
  // Пропущенный расход в отметку «докуда» входит: повторно не пойдёт
  assert.equal(forKassa.upTo, 2)

  lanReceive(kassa, forKassa.entries, { now: NOW, gen: 0 })
  assert.equal(units(kassa), 4)
  assert.equal(listDocs(kassa, 'writeoff').length, 0)
  assert.equal(listDocs(kassa, 'expense').length, 0)

  // За кассу сел владелец: журнал целиком — списание появляется, остаток прежний
  const full = lanEntriesSince(owner, 0, { wide: true })
  lanReceive(kassa, full.entries, { now: NOW, gen: 0 })
  assert.equal(listDocs(kassa, 'writeoff').length, 1)
  assert.equal(listDocs(kassa, 'expense').length, 1)
  assert.equal(units(kassa), 4)
})

test('урезание: расходы и доходы — никогда, у остального — без документов с деньгами', () => {
  const e = { kind: 'op', type: 'expense', wide: 1, body: JSON.stringify({ effects: { docs: [{ kind: 'expense', body: { id: 'x' } }] } }) }
  assert.equal(redact(e), null)
  assert.equal(redact({ ...e, type: 'income' }), null)
  const fate = { kind: 'fate', body: '{}' }
  assert.equal(redact(fate), fate)
  const sale = { kind: 'op', type: 'sale', wide: 0, body: '{}' }
  assert.equal(redact(sale), sale)
})

test('возврат по чеку соседней кассы ждёт, пока сосед отправит чек', () => {
  const a = shop()
  const b = shop()
  const sale = checkout(atA(a), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  pass(a, A, b)
  // Покупатель вернул товар на компьютере владельца
  createReturn(atB(b), { saleId: sale.id, refund: 'cash', items: [{ productId: 'nur', units: 1, restock: true }] })
  const ret = opOf(b, 'return')
  assert.equal(waitsForPeer(b, ret), true)
  assert.equal(units(b), 4)
  // Сервер принял чек соседа — возврат можно отправлять
  serverPull(b, { sales: up({ ...sale }), products: up(product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 3 })) })
  assert.equal(waitsForPeer(b, ret), false)
  // Остаток: сервер 3 (после продажи) + свой непринятый возврат 1
  assert.equal(units(b), 4)
})

test('клиент и долг, заведённые у соседа, видны и ждут его отправки', () => {
  const a = shop()
  const b = shop()
  const c = createCustomer(atA(a), { name: 'Фаррух', phone: '900', debt: 0 })
  checkout(atA(a, { user: { accountId: 'acc-k', id: 'u-kassir', name: 'kassir', role: 'founder' } }), {
    items: [{ productId: 'nur', qty: 1 }],
    payment: 'debt',
    customerId: c.id,
  })
  pass(a, A, b)
  const got = row(b, 'SELECT * FROM customers WHERE id = ?', c.id)
  assert.equal(got.local, 2)
  assert.equal(got.debtC, 15000)
  // Погашение долга этого клиента у владельца ждёт, пока сосед отправит клиента
  assert.equal(waitsForPeer(b, { type: 'debt.pay', payload: { payment: { customerId: c.id } } }), true)
})

test('смена соседа: закрытая приходит закрытой и не «открывается» старой копией сервера', () => {
  const a = shop()
  const b = shop()
  const shift = openShift(atA(a), { openingCash: 100 })
  const first = pass(a, A, b)
  // Открытую чужую смену владелец не видит (её касса — не его)
  assert.equal(listShifts(b, B).length, 0)
  closeShift(atA(a), { countedCash: 100 })
  pass(a, A, b, { since: first.upTo })
  const closed = listShifts(b, B)
  assert.equal(closed.length, 1)
  assert.ok(closed[0].closedAt)
  // Сервер знает смену только открытой (закрытие касса A ещё не отправила)
  serverPull(b, { shifts: up({ ...shift, closedAt: null }) })
  assert.ok(listShifts(b, B)[0]?.closedAt, 'закрытая смена соседа не должна стать открытой')
})

test('своя операция, вернувшаяся от соседа, не задваивается', () => {
  const a = shop()
  const b = shop()
  checkout(atA(a), { items: [{ productId: 'nur', qty: 1 }], payment: 'cash' })
  pass(a, A, b)
  // B пересылает всё, что знает, — в том числе продажу A — обратно на A
  const back = lanEntriesSince(b, 0, { wide: true })
  assert.equal(back.entries.length, 1)
  lanReceive(a, back.entries, { now: NOW, gen: 0 })
  assert.equal(units(a), 4)
  assert.equal(listDocs(a, 'sale').length, 1)
})

test('цена из прихода у соседа меняется и здесь', () => {
  const a = shop()
  const b = shop()
  // Приход с новой ценой продажи на кассе A
  createArrival(atA(a, { user: { accountId: 'acc-k', id: 'u-kassir', name: 'kassir', role: 'founder' } }), {
    items: [{ productId: 'nur', qty: 2, cost: 110, price: 180 }],
  })
  pass(a, A, b)
  assert.equal(row(b, 'SELECT priceC FROM products WHERE id = ?', 'nur').priceC, 18000)
  assert.equal(units(b), 7)
})

test('соседи: адрес, права и докуда передано', () => {
  const b = shop()
  lanPeerSeen(b, { deviceId: A, name: 'Касса 1', address: '192.168.1.5', port: 47810, wide: false, ok: true, now: NOW })
  lanPeerProgress(b, A, { sentUpTo: 7, gotUpTo: 3 })
  assert.deepEqual(
    (({ name, address, port, sentUpTo, gotUpTo, wide }) => ({ name, address, port, sentUpTo, gotUpTo, wide }))(lanPeer(b, A)),
    { name: 'Касса 1', address: '192.168.1.5', port: 47810, sentUpTo: 7, gotUpTo: 3, wide: 0 },
  )
  // Отклик поиска без прав не стирает известное о правах
  lanPeerSeen(b, { deviceId: A, name: '', address: '192.168.1.6', port: 47810, now: NOW })
  assert.equal(lanPeer(b, A).address, '192.168.1.6')
  assert.equal(lanPeer(b, A).name, 'Касса 1')
  // Владелец сел за эту кассу — журналы соседей нужны целиком
  lanAskFull(b)
  assert.equal(lanPeer(b, A).gotUpTo, 0)
})

test('права этого компьютера: есть ли тот, кому видны деньги', () => {
  const core = openDb(':memory:', CORE_SCHEMA)
  q(core, "INSERT INTO accounts (id, login, role, pharmacyCode, seenAt, permissions) VALUES ('a1', 'kassir', 'cashier', 'SHOP', '', '[\"pos.sell\"]')").run()
  assert.equal(lanWideHere(core, 'SHOP'), false)
  q(core, "INSERT INTO accounts (id, login, role, pharmacyCode, seenAt, permissions) VALUES ('a2', 'admin', 'founder', 'SHOP', '', '')").run()
  assert.equal(lanWideHere(core, 'SHOP'), true)
  assert.equal(lanWideHere(core, 'OTHER'), false)
})

test('журнал помнит, докуда очередь уже записана', () => {
  const a = shop()
  checkout(atA(a), { items: [{ productId: 'nur', qty: 1 }], payment: 'cash' })
  assert.equal(lanCatchUp(a, { deviceId: A, now: NOW }), 1)
  assert.equal(lanCatchUp(a, { deviceId: A, now: NOW }), 0)
  assert.equal(getMeta(a, 'lanOutboxSeq'), '1')
})

