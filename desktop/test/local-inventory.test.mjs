// ── Инвентаризация без интернета (версия 1.4.15) ──
//
// Лист пересчёта заводится, считается, применяется и удаляется прямо на кассе — теми же
// проверками и текстами, что на сайте. Насчитанное лежит поправками по строкам поверх копии
// сервера (sheet.mjs): по строке остаётся самое позднее по времени, каждая правка уходит на
// сервер своей операцией. Применение — пересчёт на момент применения: остаток посчитанных
// товаров становится насчитанным сразу. Отказ сервера (лист применили на сайте раньше)
// возвращает и лист, и остатки. Две кассы по сети считают один лист вместе.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal } from '../src/local/api.mjs'
import { productsList } from '../src/local/catalog.mjs'
import { listDocs } from '../src/local/docs.mjs'
import { LAN_MAX_ENTRY_BYTES, lanBeforePull, lanCatchUp, lanEntriesSince, lanGen, lanNextGen, lanReceive, waitsForPeer } from '../src/local/lan.mjs'
import {
  applyInventory,
  createInventory,
  deleteInventory,
  inventoriesList,
  inventoryOne,
  MAX_OFFLINE_LINES,
  NO_PRODUCTS_IN_SCOPE,
  saveCounts,
  SHEET_APPLIED,
  SHEET_APPLIED_NO_DELETE,
  SHEET_NOT_FOUND,
  TOO_MANY_LINES,
} from '../src/local/ops/inventory.mjs'
import { ackOp, describeOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { ctx, DAY, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

const shop = () =>
  pharmacy({
    products: [
      product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10, category: 'Таблетки' }),
      product({ id: 'bint', name: 'Бинт', barcode: '4600000000024', cost: 50, price: 80, stock: 4, unitsPerPack: 10, looseUnits: 5, category: 'Перевязка', expiryDate: null }),
    ],
  })
const ops = (db) => pendingOps(db, 100)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const up = (...list) => ({ upsert: list, remove: [] })
const stockOf = (db, id) => {
  const p = productsList(db, NOW).find((x) => x.id === id)
  return p.stock * (p.unitsPerPack || 1) + (p.looseUnits || 0)
}
const lineOf = (sheet, productId) => sheet.items.find((i) => i.productId === productId)
const syncOf = (db) => row(db, "SELECT sync FROM docs WHERE kind = 'inventory'").sync

// Две кассы одного магазина по местной сети: владелец за каждой
const owner = (deviceId, now = NOW) => ({ deviceId, now, user: { accountId: 'acc-' + deviceId, id: 'u-' + deviceId, name: deviceId, role: 'founder' } })
const at = (db, deviceId, now) => ctx(db, owner(deviceId, now))
function pair() {
  const a = shop()
  const b = shop()
  const sent = { a: 0, b: 0 }
  // Обмен по сети в обе стороны — как его делает программа
  const swap = () => {
    lanCatchUp(a, { deviceId: 'A', now: NOW })
    lanCatchUp(b, { deviceId: 'B', now: NOW })
    const fromA = lanEntriesSince(a, sent.a, { wide: true })
    const fromB = lanEntriesSince(b, sent.b, { wide: true })
    sent.a = fromA.upTo
    sent.b = fromB.upTo
    lanReceive(b, fromA.entries, { now: NOW, gen: lanGen(b) })
    lanReceive(a, fromB.entries, { now: NOW, gen: lanGen(a) })
  }
  return { a, b, swap }
}
// Лист заведён на кассе A и уже принят сервером; на B он пришёл с сервера
function sharedSheet(a, b) {
  const sheet = createInventory(at(a, 'A', NOW), { scope: 'all' })
  ackOp(a, opOf(a, 'inventory.create'), { status: 'ok', docId: sheet.id })
  applyPull(b, { full: false, cursor: '1', data: { inventories: up(sheet) } }, { now: NOW })
  return sheet
}

test('лист заводится без связи: все товары или категория, «по учёту» — полка этой кассы', () => {
  const db = shop()
  const all = createInventory(ctx(db), { scope: 'all' })
  assert.deepEqual(all.items.map((i) => [i.name, i.expectedUnits, i.actualUnits]), [['Бинт', 45, null], ['Нурофен', 10, null]])
  assert.deepEqual([all.status, all.scope, all.user.name], ['draft', 'all', 'kassir'])
  const op = opOf(db, 'inventory.create')
  assert.equal(op.payload.inventory.id, all.id)
  assert.deepEqual(op.payload.inventory.items.map((i) => [i.productId, i.expectedUnits, i.cost]), [['bint', 45, 50], ['nur', 10, 100]])
  assert.equal(syncOf(db), 'pending')
  const cat = createInventory(ctx(db), { scope: 'Таблетки' })
  assert.deepEqual(cat.items.map((i) => i.name), ['Нурофен'])
  refused(() => createInventory(ctx(db), { scope: 'Нет такой' }), 400, NO_PRODUCTS_IN_SCOPE)
  assert.deepEqual(inventoriesList(db).map((x) => x.scope).sort(), ['all', 'Таблетки'])
})

test('пересчёт сохраняется черновиком: на сервер и в поправку — только изменённые строки; лист — целиком', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  const nur = lineOf(sheet, 'nur')
  const saved = saveCounts(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 8 }] })
  assert.equal(lineOf(saved, 'nur').actualUnits, 8)
  assert.equal(saved.items.length, 2)
  assert.equal(inventoryOne(db, sheet.id).items.find((i) => i.id === nur.id).actualUnits, 8)
  const op = opOf(db, 'inventory.count')
  assert.deepEqual([op.payload.id, op.payload.items, op.payload.ref], [sheet.id, [{ id: nur.id, actualUnits: 8 }], { kind: 'inventory', id: sheet.id }])
  // Поправка — одна строка, а не лист целиком; основа листа не тронута
  const edit = row(db, "SELECT action, data FROM row_edits WHERE tbl = 'doc:inventory'")
  assert.equal(edit.action, 'lines')
  assert.deepEqual(JSON.parse(edit.data).lines, [{ id: nur.id, actualUnits: 8, at: new Date(NOW).toISOString() }])
  assert.equal(lineOf(JSON.parse(row(db, "SELECT body FROM docs WHERE kind = 'inventory'").body), 'nur').actualUnits, null)
  // Заведение ещё не отправлено — лист остаётся «ждущим»
  assert.equal(syncOf(db), 'pending')
  // То же число ещё раз — операции нет
  saveCounts(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 8 }] })
  assert.equal(ops(db).filter((o) => o.type === 'inventory.count').length, 1)
  // На складе пока ничего не изменилось
  assert.equal(stockOf(db, 'nur'), 10)
  refused(() => saveCounts(ctx(db), 'net-takogo', { items: [{ id: nur.id, actualUnits: 1 }] }), 400, SHEET_NOT_FOUND)
})

test('применение без связи: остатки — как насчитали, сразу; «по учёту» — что было на полке', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  const nur = lineOf(sheet, 'nur')
  const bint = lineOf(sheet, 'bint')
  saveCounts(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 7 }] })
  // Бинт досчитали прямо перед применением — он уходит вместе с ним
  const applied = applyInventory(ctx(db), sheet.id, { items: [{ id: bint.id, actualUnits: 50 }] })
  assert.equal(applied.status, 'applied')
  assert.deepEqual([stockOf(db, 'nur'), stockOf(db, 'bint')], [7, 50])
  assert.deepEqual([lineOf(applied, 'nur').expectedUnits, lineOf(applied, 'bint').expectedUnits], [10, 45])
  assert.deepEqual(inventoryOne(db, sheet.id), applied)
  const op = opOf(db, 'inventory.apply')
  assert.deepEqual(op.payload.items, [{ id: bint.id, actualUnits: 50 }])
  refused(() => applyInventory(ctx(db), sheet.id, {}), 400, SHEET_APPLIED)
  refused(() => saveCounts(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 1 }] }), 400, SHEET_APPLIED)
  refused(() => deleteInventory(ctx(db), sheet.id), 400, SHEET_APPLIED_NO_DELETE)
  assert.deepEqual(describeOp(op, () => sheet).detail.counted, 1)
})

test('две строки одного товара (карточки объединили на сайте) — насчитанное складывается, как у сервера', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  ackOp(db, opOf(db, 'inventory.create'), { status: 'ok', docId: sheet.id })
  // Сервер перенёс строку лишней карточки к основной: в листе теперь две строки «Нурофена»
  const twin = { ...lineOf(sheet, 'bint'), id: 'line-twin', productId: 'nur', name: 'Нурофен (дубль)', expectedUnits: 0 }
  applyPull(db, { full: false, cursor: '2', data: { inventories: up({ ...sheet, items: [...sheet.items, twin] }) } }, { now: NOW })
  const nur = lineOf(sheet, 'nur')
  applyInventory(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 6 }, { id: 'line-twin', actualUnits: 3 }] })
  assert.equal(stockOf(db, 'nur'), 9)
})

test('сервер принял — насчитанное в основе листа сразу; свежая копия сервера ложится основой, неотправленное — поверх', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  ackOp(db, opOf(db, 'inventory.create'), { status: 'ok', docId: sheet.id })
  assert.equal(syncOf(db), 'synced')
  const nur = lineOf(sheet, 'nur')
  const bint = lineOf(sheet, 'bint')
  saveCounts(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 9 }] })
  assert.equal(syncOf(db), 'edited')
  // Пришла копия сервера без этого пересчёта, зато с бинтом, посчитанным на сайте: она —
  // основа, а неотправленный пересчёт лежит поверх
  applyPull(db, { full: false, cursor: '100', data: { inventories: up({ ...sheet, items: sheet.items.map((i) => (i.id === bint.id ? { ...i, actualUnits: 44 } : i)) }) } }, { now: NOW })
  assert.deepEqual([lineOf(inventoryOne(db, sheet.id), 'nur').actualUnits, lineOf(inventoryOne(db, sheet.id), 'bint').actualUnits], [9, 44])
  assert.equal(syncOf(db), 'edited')
  // Сервер принял — до его следующего ответа число уже в основе
  ackOp(db, opOf(db, 'inventory.count'), { status: 'ok', docId: sheet.id })
  assert.equal(syncOf(db), 'synced')
  assert.equal(lineOf(JSON.parse(row(db, "SELECT body FROM docs WHERE kind = 'inventory'").body), 'nur').actualUnits, 9)
  assert.equal(lineOf(inventoryOne(db, sheet.id), 'nur').actualUnits, 9)
  // Сервер принял, но строку не записал (её позже посчитали на сайте) — касса заберёт всё заново
  saveCounts(ctx(db), sheet.id, { items: [{ id: bint.id, actualUnits: 1 }] })
  ackOp(db, opOf(db, 'inventory.count'), { status: 'ok', docId: null })
  assert.equal(row(db, "SELECT value FROM meta WHERE key = 'needFull'")?.value, '1')
  assert.equal(lineOf(inventoryOne(db, sheet.id), 'bint').actualUnits, 44)
})

test('сервер отверг применение (лист применили на сайте): остатки и лист — как были', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  ackOp(db, opOf(db, 'inventory.create'), { status: 'ok', docId: sheet.id })
  const nur = lineOf(sheet, 'nur')
  applyInventory(ctx(db), sheet.id, { items: [{ id: nur.id, actualUnits: 3 }] })
  assert.equal(stockOf(db, 'nur'), 3)
  rejectOp(db, opOf(db, 'inventory.apply'), SHEET_APPLIED)
  // Лист — сразу; остаток вернётся при ближайшем обмене (пересчёт полки)
  const back = inventoryOne(db, sheet.id)
  assert.deepEqual([back.status, lineOf(back, 'nur').actualUnits], ['draft', null])
  assert.equal(syncOf(db), 'synced')
  applyPull(db, { full: false, cursor: '100', data: {} }, { now: NOW })
  assert.equal(stockOf(db, 'nur'), 10)
})

test('удаление незаконченного листа — без связи; отказ сервера — лист возвращается', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  ackOp(db, opOf(db, 'inventory.create'), { status: 'ok', docId: sheet.id })
  saveCounts(ctx(db), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 4 }] })
  deleteInventory(ctx(db), sheet.id)
  assert.deepEqual(listDocs(db, 'inventory'), [])
  assert.equal(inventoryOne(db, sheet.id), null)
  // Пока удаление ждёт, свежая копия сервера лист не возвращает
  applyPull(db, { full: false, cursor: '5', data: { inventories: up(sheet) } }, { now: NOW })
  assert.equal(inventoryOne(db, sheet.id), null)
  rejectOp(db, opOf(db, 'inventory.delete'), SHEET_APPLIED_NO_DELETE)
  assert.equal(lineOf(inventoryOne(db, sheet.id), 'nur').actualUnits, 4)
  // Удалили на сайте — лист уходит и с кассы, вместе с неотправленным пересчётом
  applyPull(db, { full: false, cursor: '6', data: { inventories: { upsert: [], remove: [sheet.id] } } }, { now: NOW })
  assert.equal(inventoryOne(db, sheet.id), null)
})

test('права — как на сайте: смотреть, пересчитывать, применять', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: 'all' })
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassa', role: 'cashier', permissions: ['pos.sell', 'inventory.view', 'inventory.count'] }
  const call = (method, path, body, user) => {
    const m = matchLocal(method, path)
    return m.handler({ ...ctx(db, { user }), params: m.params, query: m.query, body })
  }
  assert.equal(call('GET', '/inventory', {}, cashier).length, 1)
  const nur = lineOf(sheet, 'nur')
  assert.equal(lineOf(call('PATCH', '/inventory/' + sheet.id, { items: [{ id: nur.id, actualUnits: 5 }] }, cashier), 'nur').actualUnits, 5)
  refused(() => call('POST', '/inventory/' + sheet.id + '/apply', {}, cashier), 403, 'Недостаточно прав')
  const nobody = { ...cashier, permissions: ['pos.sell'] }
  refused(() => call('GET', '/inventory', {}, nobody), 403, 'Недостаточно прав')
  // Давний лист, которого на кассе нет, — у сервера
  assert.deepEqual(call('GET', '/inventory/davniy', {}, cashier), { __remote: true })
})

test('по сети: лист и применение уходят и соседу с правами, и кассиру — остатки сходятся', () => {
  const a = shop()
  const wide = shop()
  const narrow = shop()
  const sheet = createInventory(at(a, 'A', NOW), { scope: 'all' })
  const nur = lineOf(sheet, 'nur')
  applyInventory(at(a, 'A', NOW), sheet.id, { items: [{ id: nur.id, actualUnits: 6 }] })
  lanCatchUp(a, { deviceId: 'A', now: NOW })
  for (const [to, isWide] of [[wide, true], [narrow, false]]) {
    const out = lanEntriesSince(a, 0, { wide: isWide })
    lanReceive(to, out.entries, { now: NOW, gen: lanGen(to) })
    assert.equal(stockOf(to, 'nur'), 6)
    const there = inventoryOne(to, sheet.id)
    assert.deepEqual([there.status, lineOf(there, 'nur').actualUnits], ['applied', 6])
  }
})

test('две кассы считают один лист по сети: у каждой — строки обеих; применение — по всем', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  swap()
  saveCounts(at(a, 'A', NOW + 1000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 7 }] })
  saveCounts(at(b, 'B', NOW + 2000), sheet.id, { items: [{ id: lineOf(sheet, 'bint').id, actualUnits: 15 }] })
  swap()
  for (const db of [a, b]) {
    const s = inventoryOne(db, sheet.id)
    assert.deepEqual([lineOf(s, 'nur').actualUnits, lineOf(s, 'bint').actualUnits], [7, 15])
  }
  applyInventory(at(a, 'A', NOW + 3000), sheet.id, {})
  assert.deepEqual([stockOf(a, 'nur'), stockOf(a, 'bint')], [7, 15])
  swap()
  assert.deepEqual([stockOf(b, 'nur'), stockOf(b, 'bint')], [7, 15])
  assert.equal(inventoryOne(b, sheet.id).status, 'applied')
  // B уже не может ни считать, ни применить — лист закрыт и у неё
  refused(() => saveCounts(at(b, 'B', NOW + 4000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 1 }] }), 400, SHEET_APPLIED)
})

test('одну строку посчитали на двух кассах — остаётся более поздний по времени пересчёт', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  const nur = lineOf(sheet, 'nur').id
  // На B посчитали позже, но до A это дошло раньше её собственной правки… и наоборот
  saveCounts(at(b, 'B', NOW + 5000), sheet.id, { items: [{ id: nur, actualUnits: 9 }] })
  saveCounts(at(a, 'A', NOW + 1000), sheet.id, { items: [{ id: nur, actualUnits: 4 }] })
  swap()
  assert.equal(lineOf(inventoryOne(a, sheet.id), 'nur').actualUnits, 9)
  assert.equal(lineOf(inventoryOne(b, sheet.id), 'nur').actualUnits, 9)
})

test('применение уносит строки соседа, которые сервер, может быть, ещё не получил', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  const bint = lineOf(sheet, 'bint').id
  saveCounts(at(b, 'B', NOW + 2000), sheet.id, { items: [{ id: bint, actualUnits: 15 }] })
  swap()
  applyInventory(at(a, 'A', NOW + 3000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 8 }] })
  const op = opOf(a, 'inventory.apply')
  assert.deepEqual(op.payload.items, [
    { id: lineOf(sheet, 'nur').id, actualUnits: 8 },
    { id: bint, actualUnits: 15, at: new Date(NOW + 2000).toISOString() },
  ])
  assert.equal(stockOf(a, 'bint'), 15)
  assert.equal(waitsForPeer(a, op), false)
})

for (const madeOffline of [false, true]) {
  test(`лист применён на сервере — применение соседа не накладывается второй раз (лист заведён ${madeOffline ? 'без связи' : 'на сервере'})`, () => {
    const a = shop()
    const b = shop()
    const sheet = createInventory(at(b, 'B', NOW), { scope: 'all' })
    if (!madeOffline) {
      ackOp(b, opOf(b, 'inventory.create'), { status: 'ok', docId: sheet.id })
      applyPull(a, { full: false, cursor: '1', data: { inventories: up(sheet) } }, { now: NOW })
    }
    applyInventory(at(b, 'B', NOW + 1000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 7 }] })
    lanCatchUp(b, { deviceId: 'B', now: NOW })
    lanReceive(a, lanEntriesSince(b, 0, { wide: true }).entries, { now: NOW, gen: lanGen(a) })
    assert.equal(stockOf(a, 'nur'), 7)
    // B отправила, сервер применил лист: у него 7. Обмен A с сервером приходит раньше
    // известия от B «сервер принял»
    const applied = inventoryOne(b, sheet.id)
    const data = { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 7, category: 'Таблетки' })), inventories: up(applied) }
    lanBeforePull(a, data, { startedGen: lanNextGen(a), now: NOW })
    applyPull(a, { full: false, cursor: '2', data }, { now: NOW })
    assert.equal(stockOf(a, 'nur'), 7)
    assert.equal(inventoryOne(a, sheet.id).status, 'applied')
  })
}

test('применение соседа пришло, когда лист здесь уже применён по данным сервера, — остатки не задваиваются', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  applyInventory(at(b, 'B', NOW + 1000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 7 }] })
  // До A раньше дошли данные сервера: лист применён, «Нурофена» 7
  const applied = inventoryOne(b, sheet.id)
  const data = { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 7, category: 'Таблетки' })), inventories: up(applied) }
  lanBeforePull(a, data, { startedGen: lanNextGen(a), now: NOW })
  applyPull(a, { full: false, cursor: '2', data }, { now: NOW })
  swap()
  assert.equal(stockOf(a, 'nur'), 7)
  assert.equal(row(a, "SELECT state FROM lan_log WHERE type = 'inventory.apply'").state, 'confirmed')
})

test('пересчёт соседа, пришедший после применения здесь, лист не меняет', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  const nur = lineOf(sheet, 'nur').id
  applyInventory(at(a, 'A', NOW + 3000), sheet.id, { items: [{ id: nur, actualUnits: 5 }] })
  saveCounts(at(b, 'B', NOW + 4000), sheet.id, { items: [{ id: nur, actualUnits: 9 }] })
  swap()
  assert.equal(lineOf(inventoryOne(a, sheet.id), 'nur').actualUnits, 5)
  assert.equal(stockOf(a, 'nur'), 5)
})

test('большой лист: поправка и запись для соседа — только изменённые строки; без связи — не больше 10 000 товаров', () => {
  const list = Array.from({ length: 3000 }, (_, n) => product({ id: 'cm' + String(n).padStart(23, '0'), name: 'Парацетамол 500мг таблетки №20 ' + n, stock: 10 }))
  const a = pharmacy({ products: list })
  const sheet = createInventory(at(a, 'A', NOW), { scope: 'all' })
  ackOp(a, opOf(a, 'inventory.create'), { status: 'ok', docId: sheet.id })
  for (let n = 0; n < 5; n++) saveCounts(at(a, 'A', NOW + n), sheet.id, { items: [{ id: sheet.items[n].id, actualUnits: 5 }] })
  const edits = rows(a, "SELECT length(data) AS n FROM row_edits WHERE tbl = 'doc:inventory'")
  assert.equal(edits.length, 5)
  assert.ok(edits.every((e) => e.n < 300), JSON.stringify(edits))
  lanCatchUp(a, { deviceId: 'A', now: NOW })
  const counts = rows(a, "SELECT length(body) AS n FROM lan_log WHERE type = 'inventory.count'")
  assert.equal(counts.length, 5)
  assert.ok(counts.every((e) => e.n < 1000), JSON.stringify(counts))
  // Само заведение такого листа (3000 строк) по сети проходит
  const made = createInventory(at(a, 'A', NOW), { scope: 'all' })
  lanCatchUp(a, { deviceId: 'A', now: NOW })
  const entry = lanEntriesSince(a, 0, { wide: true, limit: 500 }).entries.find((e) => e.type === 'inventory.create' && JSON.parse(e.body).effects.docs[0].body.id === made.id)
  assert.ok(entry && Buffer.byteLength(JSON.stringify(entry.body)) < LAN_MAX_ENTRY_BYTES)
  // Больше 10 000 товаров одним листом без связи — по категориям
  const huge = pharmacy({ products: Array.from({ length: MAX_OFFLINE_LINES + 1 }, (_, n) => product({ id: 'h' + n, name: 'Т' + n })) })
  // С интернетом такой лист заведёт сервер; без него — этот текст (шлюз)
  assert.deepEqual(createInventory(ctx(huge), { scope: 'all' }), { __remote: true, __offline: TOO_MANY_LINES })
})

test('журнал: применённые листы уходят по дню применения, незаконченные — никогда; принятые поправки — через 45 дней', () => {
  const db = shop()
  const base = createInventory(ctx(db), { scope: 'all' })
  ackOp(db, opOf(db, 'inventory.create'), { status: 'ok', docId: base.id })
  const old = (id, appliedAt, status = 'applied') => ({ ...base, id, date: new Date(NOW - 400 * DAY).toISOString(), status, appliedAt })
  applyPull(
    db,
    {
      full: false,
      cursor: '3',
      data: { inventories: up(old('gone', new Date(NOW - 200 * DAY).toISOString()), old('fresh', new Date(NOW - 10 * DAY).toISOString()), old('draft-old', null, 'draft')) },
    },
    { now: NOW },
  )
  // Пересчёт полтора месяца назад, принятый сервером
  saveCounts(ctx(db, { now: NOW - 50 * DAY }), base.id, { items: [{ id: lineOf(base, 'nur').id, actualUnits: 2 }] })
  ackOp(db, opOf(db, 'inventory.count'), { status: 'ok', docId: base.id })
  assert.equal(rows(db, 'SELECT 1 FROM row_edits').length, 1)
  applyPull(db, { full: false, cursor: '4', data: {} }, { now: NOW + DAY + 1 })
  assert.deepEqual(inventoriesList(db).map((s) => s.id).sort(), [base.id, 'draft-old', 'fresh'].sort())
  assert.equal(rows(db, 'SELECT 1 FROM row_edits').length, 0)
})

// ── Находки ревью (1.4.15) ──
// Данные сервера — как их кладёт шлюз: сначала обмен по сети узнаёт, что уже принято
function serverPull(db, data) {
  lanBeforePull(db, data, { startedGen: lanNextGen(db), now: NOW })
  applyPull(db, { full: false, cursor: String(Math.random()), data }, { now: NOW })
}
const nurAt = (stock) => product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock, category: 'Таблетки' })

test('применение соседа, когда листа здесь нет (или он здесь удалён), не задваивается после данных сервера', () => {
  for (const variant of ['нет листа', 'удалён здесь']) {
    const { a, b, swap } = pair()
    const site = createInventory(at(shop(), 'SITE', NOW), { scope: 'all' })
    applyPull(b, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
    if (variant === 'удалён здесь') {
      applyPull(a, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
      deleteInventory(at(a, 'A', NOW + 500), site.id)
    }
    applyInventory(at(b, 'B', NOW + 1000), site.id, { items: [{ id: lineOf(site, 'nur').id, actualUnits: 7 }] })
    swap()
    assert.equal(stockOf(a, 'nur'), 7, variant)
    // Сервер применил лист B (у него 7); известие от B до A ещё не дошло
    const applied = { ...site, status: 'applied', appliedAt: new Date(NOW + 1000).toISOString(), items: site.items.map((i) => (i.productId === 'nur' ? { ...i, actualUnits: 7 } : i)) }
    serverPull(a, { products: up(nurAt(7)), inventories: up(applied) })
    assert.equal(stockOf(a, 'nur'), 7, variant + ': после данных сервера')
  }
})

test('товары, заведённые соседом и ещё не известные серверу, в лист без связи не попадают — очередь не ждёт соседа', () => {
  const { a, b, swap } = pair()
  const made = matchLocal('POST', '/products')
  const fresh = made.handler({ ...at(b, 'B', NOW), params: made.params, query: made.query, body: { name: 'Новинка соседа', barcode: '4600000009999', cost: 10, price: 20, stock: 3, unitsPerPack: 1, unit: 'шт', category: 'Таблетки' } })
  swap()
  assert.ok(productsList(a, NOW).some((p) => p.id === fresh.id), 'товар соседа пришёл по сети')
  const sheet = createInventory(at(a, 'A', NOW), { scope: 'all' })
  assert.equal(sheet.items.some((i) => i.productId === fresh.id), false)
  assert.equal(waitsForPeer(a, opOf(a, 'inventory.create')), false)
})

test('удаление, которое сервер не провёл (лист считали позже), не мешает пересчёту соседа', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  deleteInventory(at(a, 'A', NOW + 1000), sheet.id)
  // Сервер принял удаление, но ничего не сделал: лист позже посчитали — он остался
  ackOp(a, opOf(a, 'inventory.delete'), { status: 'ok', docId: null })
  applyPull(a, { full: true, cursor: '9', data: { inventories: up(sheet) } }, { now: NOW })
  assert.equal(inventoryOne(a, sheet.id).id, sheet.id)
  saveCounts(at(b, 'B', NOW + 3000), sheet.id, { items: [{ id: lineOf(sheet, 'bint').id, actualUnits: 30 }] })
  swap()
  assert.equal(lineOf(inventoryOne(a, sheet.id), 'bint').actualUnits, 30)
})

test('пересчёт соседа, сделанный раньше уже принятого сервером, его не перекрывает', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  const X = lineOf(sheet, 'nur').id
  saveCounts(at(b, 'B', NOW + 1000), sheet.id, { items: [{ id: X, actualUnits: 9 }] })
  swap()
  saveCounts(at(a, 'A', NOW + 2000), sheet.id, { items: [{ id: X, actualUnits: 4 }] })
  ackOp(a, opOf(a, 'inventory.count'), { status: 'ok', docId: sheet.id })
  assert.equal(lineOf(inventoryOne(a, sheet.id), 'nur').actualUnits, 4)
  // Копия сервера: в строке 4, посчитано в момент A
  const copy = { ...sheet, items: sheet.items.map((i) => (i.id === X ? { ...i, actualUnits: 4, countedAt: new Date(NOW + 2000).toISOString() } : i)) }
  applyPull(a, { full: false, cursor: '7', data: { inventories: up(copy) } }, { now: NOW })
  assert.equal(lineOf(inventoryOne(a, sheet.id), 'nur').actualUnits, 4)
  applyInventory(at(a, 'A', NOW + 3000), sheet.id, {})
  assert.equal(stockOf(a, 'nur'), 4)
  assert.deepEqual(opOf(a, 'inventory.apply').payload.items, [])
})

test('движение соседа, сделанное до пересчёта, который сервер уже провёл, второй раз не вычитается', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  // B без интернета списала 1 «Нурофен» за полсекунды до применения на A
  const wo = matchLocal('POST', '/writeoffs')
  wo.handler({ ...at(b, 'B', NOW + 500), params: wo.params, query: wo.query, body: { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] } })
  swap()
  assert.equal(stockOf(a, 'nur'), 9)
  applyInventory(at(a, 'A', NOW + 1000), sheet.id, { items: [{ id: lineOf(sheet, 'nur').id, actualUnits: 5 }] })
  assert.equal(stockOf(a, 'nur'), 5)
  // Сервер провёл применение A: у него 5, лист применён; списание B до него ещё не дошло
  ackOp(a, opOf(a, 'inventory.apply'), { status: 'ok', docId: sheet.id })
  const applied = { ...inventoryOne(a, sheet.id), appliedAt: new Date(NOW + 1000).toISOString() }
  serverPull(a, { products: up(nurAt(5)), inventories: up(applied) })
  assert.equal(stockOf(a, 'nur'), 5)
})

test('пересчёт соседа, пришедший раньше самого листа, ложится, когда лист придёт', () => {
  const { a, b, swap } = pair()
  const site = createInventory(at(shop(), 'SITE', NOW), { scope: 'all' })
  applyPull(b, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
  saveCounts(at(b, 'B', NOW + 1000), site.id, { items: [{ id: lineOf(site, 'bint').id, actualUnits: 30 }] })
  swap()
  assert.equal(inventoryOne(a, site.id), null)
  applyPull(a, { full: false, cursor: '2', data: { inventories: up(site) } }, { now: NOW })
  assert.equal(lineOf(inventoryOne(a, site.id), 'bint').actualUnits, 30)
  applyInventory(at(a, 'A', NOW + 2000), site.id, {})
  assert.equal(stockOf(a, 'bint'), 30)
  assert.deepEqual(opOf(a, 'inventory.apply').payload.items, [{ id: lineOf(site, 'bint').id, actualUnits: 30, at: new Date(NOW + 1000).toISOString() }])
})

test('сервер принял своё применение — строки соседа в применённом листе остаются', () => {
  const { a, b, swap } = pair()
  const sheet = sharedSheet(a, b)
  saveCounts(at(b, 'B', NOW + 1000), sheet.id, { items: [{ id: lineOf(sheet, 'bint').id, actualUnits: 30 }] })
  swap()
  applyInventory(at(a, 'A', NOW + 2000), sheet.id, {})
  ackOp(a, opOf(a, 'inventory.apply'), { status: 'ok', docId: sheet.id })
  const s = inventoryOne(a, sheet.id)
  assert.deepEqual([s.status, lineOf(s, 'bint').actualUnits], ['applied', 30])
})

test('лист применили на сайте: остаток и лист пришли одним ответом — движение соседа до пересчёта не вычитается второй раз', () => {
  const { a, b, swap } = pair()
  const site = createInventory(at(shop(), 'SITE', NOW), { scope: 'all' })
  applyPull(a, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
  applyPull(b, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
  const wo = matchLocal('POST', '/writeoffs')
  wo.handler({ ...at(b, 'B', NOW + 500), params: wo.params, query: wo.query, body: { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] } })
  swap()
  assert.equal(stockOf(a, 'nur'), 9)
  const applied = { ...site, status: 'applied', appliedAt: new Date(NOW + 1000).toISOString(), items: site.items.map((i) => (i.productId === 'nur' ? { ...i, actualUnits: 5 } : i)) }
  serverPull(a, { products: up(nurAt(5)), inventories: up(applied) })
  assert.equal(stockOf(a, 'nur'), 5)
  // Пересчёт соседа по этому листу ещё ждёт отправки — пересчёт сервера всё равно в силе
  saveCounts(at(b, 'B', NOW + 2000), site.id, { items: [{ id: lineOf(site, 'bint').id, actualUnits: 7 }] })
  swap()
  serverPull(a, { products: up(nurAt(5)) })
  assert.equal(stockOf(a, 'nur'), 5)
})

test('движение соседа, пришедшее по сети уже после пересчёта, который сервер провёл, на полку не ложится', () => {
  const a = shop()
  const b = shop()
  const site = createInventory(at(shop(), 'SITE', NOW), { scope: 'all' })
  applyPull(a, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
  applyPull(b, { full: false, cursor: '1', data: { inventories: up(site) } }, { now: NOW })
  const wo = matchLocal('POST', '/writeoffs')
  wo.handler({ ...at(b, 'B', NOW + 500), params: wo.params, query: wo.query, body: { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] } })
  const applied = { ...site, status: 'applied', appliedAt: new Date(NOW + 1000).toISOString(), items: site.items.map((i) => (i.productId === 'nur' ? { ...i, actualUnits: 5 } : i)) }
  serverPull(a, { products: up(nurAt(5)), inventories: up(applied) })
  lanCatchUp(b, { deviceId: 'B', now: NOW })
  lanReceive(a, lanEntriesSince(b, 0, { wide: true }).entries, { now: NOW, gen: lanGen(a) })
  assert.equal(stockOf(a, 'nur'), 5)
  serverPull(a, {})
  assert.equal(stockOf(a, 'nur'), 5)
})
