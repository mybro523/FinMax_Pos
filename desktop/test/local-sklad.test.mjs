// ── Склад магазина без интернета (1.8.0) ──
//
// Склад — отдельный запас рядом с полкой. Приход можно оформить на склад (полка и средняя
// закупочная не меняются), со склада товар переносят в магазин (ближайший срок первым, без
// срока — последними; на полку — партиями с теми же ценой и сроком, закупочная — как от
// прихода), остаток склада правят. Всё это касса делает сама и отправляет серверу очередью,
// а свежий склад сервера ложится основой, поверх которой проигрывается неотправленное.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal } from '../src/local/api.mjs'
import { listDocs } from '../src/local/docs.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { deleteArrival, SKLAD_ARRIVAL_EDIT, SKLAD_ARRIVAL_GONE, updateArrival } from '../src/local/ops/arrivaledit.mjs'
import { skladEdit, skladList, skladToShop } from '../src/local/ops/sklad.mjs'
import { ackOp, describeOp, pendingOps, rejectOp, touchedBy } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { rebuildStock, skladShort, skladUnitsOf, unitsOf } from '../src/local/stock.mjs'
import { ctx, day, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

const ops = (db) => pendingOps(db, 100)
const cost = (db, id) => row(db, 'SELECT costC FROM products WHERE id = ?', id).costC
const shelf = (db, id) => unitsOf(db, id, NOW).units
const call = (db, method, path, over = {}) => {
  const found = matchLocal(method, path)
  assert.ok(found, `маршрут ${method} ${path} не найден`)
  return found.handler({ db, now: NOW, deviceId: 'kassa-1', query: found.query, params: found.params, body: over.body, user: over.user })
}
const founder = { accountId: 'acc-1', id: 'user-1', name: 'admin', role: 'founder', permissions: [] }
const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassir', role: 'cashier', permissions: ['pos.sell', 'shift.view', 'shift.open'] }
const keeper = { accountId: 'acc-3', id: 'user-3', name: 'sklad', role: 'cashier', permissions: ['sklad.view', 'sklad.move'] }

// Склад, каким его знает сервер: три партии одного товара
const sklad = (pid) => [
  { id: 'sb-a', productId: pid, units: 4, cost: 60, expiryDate: day('2027-03-01'), arrivalId: null, createdAt: '2026-09-02T08:00:00.000Z' },
  { id: 'sb-b', productId: pid, units: 2, cost: 70, expiryDate: day('2027-01-01'), arrivalId: null, createdAt: '2026-09-03T08:00:00.000Z' },
  { id: 'sb-c', productId: pid, units: 5, cost: 50, expiryDate: null, arrivalId: null, createdAt: '2026-09-01T08:00:00.000Z' },
]

test('приход на склад: полка и закупочная не меняются, строки — партии склада', () => {
  const p = product({ stock: 10, cost: 100 })
  const db = pharmacy({ products: [p] })
  const a = createArrival(ctx(db), {
    supplier: 'Опт',
    place: 'sklad',
    items: [
      { productId: p.id, qty: 5, cost: 80, expiryDate: '2027-01-31' },
      { productId: p.id, qty: 3, cost: 90 },
    ],
  })
  assert.equal(a.place, 'sklad')
  assert.equal(a.total, 670)
  assert.equal(shelf(db, p.id), 10)
  assert.equal(cost(db, p.id), 10000)
  assert.equal(skladUnitsOf(db, p.id), 8)
  const list = skladList(db)
  assert.deepEqual(
    list.map((b) => [b.units, b.cost, b.expiryDate, b.arrivalId]).sort(),
    [
      [3, 90, null, a.id],
      [5, 80, '2027-01-31T00:00:00.000Z', a.id],
    ].sort(),
  )
  const [op] = ops(db)
  assert.equal(op.type, 'arrival')
  assert.equal(op.payload.arrival.place, 'sklad')
  assert.ok(touchedBy(op).includes('skladBatches'))
  // Пересборка (свежие данные сервера) даёт то же самое
  rebuildStock(db)
  assert.equal(skladUnitsOf(db, p.id), 8)
  assert.equal(shelf(db, p.id), 10)
  // Обычный приход по-прежнему — на полку
  const b = createArrival(ctx(db), { items: [{ productId: p.id, qty: 2, cost: 100 }] })
  assert.equal(b.place, 'shop')
  assert.equal(shelf(db, p.id), 12)
  assert.equal(skladUnitsOf(db, p.id), 8)
})

test('перенос в магазин: ближайший срок первым, без срока последним; закупочная — как от прихода', () => {
  const p = product({ stock: 10, cost: 100 })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  assert.equal(skladUnitsOf(db, p.id), 11)
  const doc = skladToShop(ctx(db), { items: [{ productId: p.id, units: 7 }], note: ' на витрину ' })
  assert.equal(doc.kind, 'toShop')
  assert.equal(doc.note, 'на витрину')
  // Сначала 01.01.2027 (2 шт), потом 01.03.2027 (4 шт), потом бессрочная (1 шт)
  assert.deepEqual(
    doc.items.map((i) => [i.units, i.cost, i.expiryDate]),
    [
      [2, 70, day('2027-01-01')],
      [4, 60, day('2027-03-01')],
      [1, 50, null],
    ],
  )
  assert.equal(doc.total, 430)
  assert.equal(shelf(db, p.id), 17)
  assert.equal(skladUnitsOf(db, p.id), 4)
  // 10×100 + 2×70 + 4×60 + 1×50 = 1430 за 17 шт → 84,12
  assert.equal(cost(db, p.id), 8412)
  // На полке — партии с ценой и сроком частей
  assert.deepEqual(
    rows(db, "SELECT units, costC, expiryDate FROM batches WHERE productId = ? AND note = 'со склада' ORDER BY costC", p.id).map((b) => [b.units, b.costC, b.expiryDate]),
    [
      [1, 5000, null],
      [4, 6000, day('2027-03-01')],
      [2, 7000, day('2027-01-01')],
    ],
  )
  assert.deepEqual(listDocs(db, 'skladmove'), [doc])
  const [op] = ops(db)
  assert.equal(op.type, 'sklad.toShop')
  assert.deepEqual(op.payload.items, [{ productId: p.id, units: 7 }])
  assert.equal(op.payload.id, doc.id)
  assert.equal(describeOp(op, () => doc).sum, 430)
  assert.deepEqual(touchedBy(op), ['skladBatches', 'skladMoves', 'products'])

  // Пересборка поверх тех же данных сервера — то же самое (номера партий те же)
  const before = rows(db, 'SELECT * FROM batches ORDER BY id')
  rebuildStock(db)
  assert.deepEqual(rows(db, 'SELECT * FROM batches ORDER BY id'), before)
  assert.equal(skladUnitsOf(db, p.id), 4)
  assert.equal(cost(db, p.id), 8412)

  // Тот же запрос второй раз (ключ повтора) — второго переноса нет
  const again = skladToShop(ctx(db), { clientId: 'mv-1', items: [{ productId: p.id, units: 1 }] })
  assert.equal(skladToShop(ctx(db), { clientId: 'mv-1', items: [{ productId: p.id, units: 1 }] }).id, again.id)
  assert.equal(skladUnitsOf(db, p.id), 3)
})

test('перенос: не хватает — отказ, ничего не меняется; один товар в списке дважды — считается вместе', () => {
  const p = product({ stock: 0, cost: 100, name: 'Мука' })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  refused(() => skladToShop(ctx(db), { items: [{ productId: p.id, units: 6 }, { productId: p.id, units: 6 }] }), 400, skladShort('Мука', 11))
  assert.equal(skladShort('Мука', 11), 'На складе не хватает: Мука (есть 11 шт)')
  assert.equal(skladUnitsOf(db, p.id), 11)
  assert.equal(shelf(db, p.id), 0)
  assert.equal(ops(db).length, 0)
  assert.equal(rows(db, 'SELECT * FROM stock_moves').length, 0)
  refused(() => skladToShop(ctx(db), { items: [{ productId: 'nope', units: 1 }] }), 400, 'Товар не найден')
  // Всё, что есть, — можно
  skladToShop(ctx(db), { items: [{ productId: p.id, units: 6 }, { productId: p.id, units: 5 }] })
  assert.equal(skladUnitsOf(db, p.id), 0)
  assert.equal(shelf(db, p.id), 11)
})

test('правка остатка склада: прибавка — новая партия, убавка — по сроку, без изменений — отказ', () => {
  const p = product({ stock: 0, cost: 100 })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  refused(() => skladEdit(ctx(db), { productId: p.id, units: 11 }), 400, 'Остаток не изменился')
  // Прибавка по нынешней закупочной
  const up = skladEdit(ctx(db), { productId: p.id, units: 15 })
  assert.equal(up.kind, 'edit')
  assert.deepEqual(up.items.map((i) => [i.units, i.cost]), [[4, 100]])
  assert.equal(up.total, 400)
  assert.equal(skladUnitsOf(db, p.id), 15)
  // Прибавка по своей цене и сроку
  skladEdit(ctx(db), { productId: p.id, units: 16, cost: 55, expiryDate: '2027-05-01' })
  assert.equal(row(db, "SELECT costC, expiryDate FROM sklad_batches WHERE costC = 5500").expiryDate, '2027-05-01T00:00:00.000Z')
  // Убавка: снимается ближайший срок (01.01.2027 — 2 шт), затем 01.03.2027
  const down = skladEdit(ctx(db), { productId: p.id, units: 13 })
  assert.equal(down.items[0].units, -3)
  assert.equal(row(db, "SELECT units FROM sklad_batches WHERE id = 'sb-b'").units, 0)
  assert.equal(row(db, "SELECT units FROM sklad_batches WHERE id = 'sb-a'").units, 3)
  assert.equal(skladUnitsOf(db, p.id), 13)
  // Полка не тронута
  assert.equal(shelf(db, p.id), 0)
  const last = ops(db).at(-1)
  assert.equal(last.type, 'sklad.edit')
  assert.equal(last.payload.units, 13)
  assert.equal(last.payload.productId, p.id)
  // Пересборка — то же
  rebuildStock(db)
  assert.equal(skladUnitsOf(db, p.id), 13)
})

test('приход на склад: не правится; удаляется, только пока товар целиком на складе', () => {
  const p = product({ stock: 0, cost: 100 })
  const db = pharmacy({ products: [p], suppliers: [{ id: 'sup-1', name: 'Опт-Маркет', openingDebt: 0, debt: 0, createdAt: '2026-09-01T08:00:00.000Z' }] })
  const a = createArrival(ctx(db), { supplierId: 'sup-1', place: 'sklad', items: [{ productId: p.id, qty: 5, cost: 80 }] })
  refused(() => updateArrival(ctx(db), a.id, { items: [{ id: a.items[0].id, qty: 4, cost: 80 }] }), 400, SKLAD_ARRIVAL_EDIT)
  skladToShop(ctx(db), { items: [{ productId: p.id, units: 1 }] })
  refused(() => deleteArrival(ctx(db), a.id), 400, SKLAD_ARRIVAL_GONE)
  assert.equal(skladUnitsOf(db, p.id), 4)

  const b = createArrival(ctx(db), { place: 'sklad', items: [{ productId: p.id, qty: 3, cost: 90 }] })
  assert.equal(skladUnitsOf(db, p.id), 7)
  deleteArrival(ctx(db), b.id)
  assert.equal(skladUnitsOf(db, p.id), 4)
  assert.equal(shelf(db, p.id), 1)
  rebuildStock(db)
  assert.equal(skladUnitsOf(db, p.id), 4)
  assert.equal(ops(db).at(-1).type, 'arrival.delete')
})

test('маршруты склада и права', () => {
  const p = product({ stock: 0 })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  assert.equal(call(db, 'GET', '/sklad', { user: founder }).length, 3)
  assert.throws(() => call(db, 'GET', '/sklad', { user: cashier }), { status: 403 })
  assert.throws(() => call(db, 'POST', '/sklad/to-shop', { user: cashier, body: { items: [{ productId: p.id, units: 1 }] } }), { status: 403 })
  assert.throws(() => call(db, 'GET', '/sklad/moves', { user: cashier }), { status: 403 })
  const moved = call(db, 'POST', '/sklad/to-shop', { user: keeper, body: { items: [{ productId: p.id, units: 2 }] } })
  assert.equal(moved.user.name, 'sklad')
  call(db, 'POST', '/sklad/edit', { user: keeper, body: { productId: p.id, units: 1 } })
  const journal = call(db, 'GET', '/sklad/moves', { user: keeper })
  assert.deepEqual(journal.map((d) => d.kind).sort(), ['edit', 'toShop'])
})

test('с сервера: склад — основа, неотправленное — поверх; принято — документ сервера заменяет свой', () => {
  const p = product({ stock: 0, cost: 100 })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  const doc = skladToShop(ctx(db), { items: [{ productId: p.id, units: 3 }] })
  assert.equal(skladUnitsOf(db, p.id), 8)
  // Сервер прислал свежий склад (кто-то на сайте добавил партию), операцию ещё не принял
  applyPull(db, { full: false, data: { skladBatches: { upsert: [{ id: 'sb-d', productId: p.id, units: 10, cost: 40, expiryDate: null, createdAt: '2026-10-01T08:00:00.000Z' }], remove: [] } } }, { now: NOW })
  // 11 + 10 у сервера, минус свои 3 (снова 01.01 и 01.03)
  assert.equal(skladUnitsOf(db, p.id), 18)
  assert.equal(shelf(db, p.id), 3)
  // Сервер принял перенос и прислал склад и полку уже с ним
  const [op] = ops(db)
  ackOp(db, op)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'skladmove'").sync, 'synced')
  applyPull(
    db,
    {
      full: false,
      data: {
        skladBatches: {
          upsert: [
            { id: 'sb-a', productId: p.id, units: 3, cost: 60, expiryDate: day('2027-03-01'), createdAt: '2026-09-02T08:00:00.000Z' },
            { id: 'sb-b', productId: p.id, units: 0, cost: 70, expiryDate: day('2027-01-01'), createdAt: '2026-09-03T08:00:00.000Z' },
          ],
          remove: [],
        },
        batches: { upsert: [{ id: 'srv-1', productId: p.id, units: 3, cost: 66.67, expiryDate: day('2027-01-01'), createdAt: NOW }], remove: [] },
        skladMoves: { upsert: [{ ...doc, user: { id: 'user-1', name: 'kassir' } }], remove: [] },
      },
    },
    { now: NOW },
  )
  assert.equal(skladUnitsOf(db, p.id), 18)
  assert.equal(shelf(db, p.id), 3)
  assert.equal(listDocs(db, 'skladmove').length, 1)
})

test('сервер не принял перенос — склад и полка возвращаются к тому, что знает сервер', () => {
  const p = product({ stock: 0, cost: 100 })
  const db = pharmacy({ products: [p], skladBatches: sklad(p.id) })
  skladToShop(ctx(db), { items: [{ productId: p.id, units: 5 }] })
  const [op] = ops(db)
  rejectOp(db, op, 'нет')
  rebuildStock(db)
  assert.equal(skladUnitsOf(db, p.id), 11)
  assert.equal(shelf(db, p.id), 0)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'skladmove'").sync, 'rejected')
  // Правку, после которой у сервера документа нет (остаток уже был таким), касса убирает
  skladEdit(ctx(db), { productId: p.id, units: 12 })
  const edit = ops(db).at(-1)
  ackOp(db, edit, { status: 'ok', docId: null })
  assert.equal(rows(db, "SELECT * FROM docs WHERE kind = 'skladmove' AND id = ?", edit.payload.id).length, 0)
})
