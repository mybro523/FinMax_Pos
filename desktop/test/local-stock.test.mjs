// ── Остатки: партии, сроки, журнал движений ──
//
// Правила те же, что на сервере: товар лежит партиями, списывается с ближайшего
// срока, продажа берёт только годное. Сверх серверного здесь проверяется главное
// для работы без интернета: сделанное на кассе не теряется и не задваивается,
// когда с сервера приходит свежий остаток.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { productsList } from '../src/local/catalog.mjs'
import { inTx } from '../src/local/db.mjs'
import { applySnapshot, batchesFromCard } from '../src/local/snapshot.mjs'
import { move, productById, rebuildStock, unitsOf, weightedPackCost } from '../src/local/stock.mjs'
import { day, DAY, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

// Три настоящие партии одного товара: просроченная, близкая и дальняя
function threeBatches() {
  const p = product({ id: 'asp', name: 'Аспирин', stock: 0, looseUnits: 0, unitsPerPack: 1, cost: 10, price: 15 })
  const db = pharmacy({
    products: [p],
    batches: [
      { id: 'b-old', productId: 'asp', units: 4, cost: 10, expiryDate: day('2026-10-03'), createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'b-near', productId: 'asp', units: 5, cost: 10, expiryDate: day('2026-11-01'), createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'b-far', productId: 'asp', units: 6, cost: 12, expiryDate: day('2027-05-01'), createdAt: '2026-09-15T00:00:00.000Z' },
    ],
  })
  return db
}

const batchUnits = (db, id) => row(db, 'SELECT units FROM batches WHERE id = ?', id)?.units
const take = (db, m, now = NOW) => inTx(db, () => move(db, { opId: 'op', kind: 'sale', ...m }, { now }))

test('карточка товара выводится из партий: остаток, просрочка, ближайший срок', () => {
  const db = threeBatches()
  const [p] = productsList(db, NOW)
  assert.equal(p.stock, 15)
  assert.equal(p.expiredUnits, 4)
  assert.deepEqual(unitsOf(db, 'asp', NOW), { units: 15, expired: 4 })
  // Назавтра после 1 ноября просроченной станет и вторая партия — без единой операции
  const later = Date.parse('2026-11-02T10:00:00.000Z')
  assert.equal(productsList(db, later)[0].expiredUnits, 9)
})

test('продажа берёт годную партию с ближайшим сроком и не трогает просрочку', () => {
  const db = threeBatches()
  const { taken } = take(db, { productId: 'asp', units: -7, skipExpired: true })
  assert.deepEqual(
    taken.map((t) => [t.batchId, t.units]),
    [
      ['b-near', 5],
      ['b-far', 2],
    ],
  )
  assert.equal(batchUnits(db, 'b-old'), 4, 'просроченная партия ушла покупателю')
  assert.equal(batchUnits(db, 'b-far'), 4)
  // Ближайший срок в карточке — по тому, что осталось на полке (включая просрочку)
  assert.equal(productById(db, 'asp').expiryDate, day('2026-10-03'))
})

test('списание берёт всё подряд, начиная с просроченного', () => {
  const db = threeBatches()
  const { taken } = take(db, { productId: 'asp', units: -6, kind: 'writeoff' })
  assert.deepEqual(
    taken.map((t) => [t.batchId, t.units, t.expiryDate]),
    [
      ['b-old', 4, day('2026-10-03')],
      ['b-near', 2, day('2026-11-01')],
    ],
  )
  assert.equal(productById(db, 'asp').expiryDate, day('2026-11-01'))
})

test('не хватило товара — отказ теми же словами, что у сервера', () => {
  const db = threeBatches()
  // Годных 11, просрочено 4: продать 12 нельзя, и кассир должен понять почему
  refused(
    () => take(db, { productId: 'asp', units: -12, skipExpired: true }),
    400,
    '«Аспирин»: годных 11 шт, просрочено 4 шт. Просроченное продавать нельзя — уберите его с полки и спишите.',
  )
  refused(() => take(db, { productId: 'asp', units: -16, kind: 'writeoff' }), 400, 'Недостаточно «Аспирин» на складе (есть 15 шт)')
  // Отказ ничего не оставил после себя: ни движения в журнале, ни изменённой партии
  assert.equal(rows(db, 'SELECT * FROM stock_moves').length, 0)
  assert.equal(unitsOf(db, 'asp', NOW).units, 15)
})

test('без срока — в конец очереди; при равном сроке раньше уходит старшая партия', () => {
  const p = product({ id: 'bint', stock: 0 })
  const db = pharmacy({
    products: [p],
    batches: [
      { id: 'no-date', productId: 'bint', units: 3, cost: 1, expiryDate: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'younger', productId: 'bint', units: 3, cost: 1, expiryDate: day('2027-01-01'), createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'older', productId: 'bint', units: 3, cost: 1, expiryDate: day('2027-01-01'), createdAt: '2026-03-01T00:00:00.000Z' },
    ],
  })
  const { taken } = take(db, { productId: 'bint', units: -7, skipExpired: true })
  assert.deepEqual(
    taken.map((t) => [t.batchId, t.units]),
    [
      ['older', 3],
      ['younger', 3],
      ['no-date', 1],
    ],
  )
})

test('возврат на полку: та же цена и срок — в ту же партию, иначе новая', () => {
  const db = threeBatches()
  const back = (m) => inTx(db, () => move(db, { opId: 'ret', kind: 'return', productId: 'asp', arrivalId: null, ...m }, { now: NOW }))
  back({ units: 2, costC: 1000, expiryDate: day('2026-11-01') })
  assert.equal(batchUnits(db, 'b-near'), 7, 'штуки должны были лечь в существующую партию')
  assert.equal(rows(db, 'SELECT * FROM batches').length, 3)

  // Другая цена — другая партия, даже при том же сроке
  const { batchId } = back({ units: 1, costC: 1100, expiryDate: day('2026-11-01') })
  assert.equal(rows(db, 'SELECT * FROM batches').length, 4)
  const b = row(db, 'SELECT * FROM batches WHERE id = ?', batchId)
  assert.equal(b.units, 1)
  assert.equal(b.sUnits, null, 'партия, заведённая на кассе, помечается как неизвестная серверу')
  assert.equal(unitsOf(db, 'asp', NOW).units, 18)
})

test('средняя закупочная цена считается в штуках, а не в упаковках', () => {
  // Пример из серверного кода: в упаковке 20 таблеток, на складе 0 пачек и 15
  // таблеток по 100 за пачку; привезли пачку по 200. По упаковкам вышло бы 200,
  // по штукам — (0,75 × 100 + 200) / 1,75 ≈ 157,14
  const cost = weightedPackCost({ stock: 0, looseUnits: 15, unitsPerPack: 20, cost: 100, addPacks: 1, addValue: 200 })
  assert.equal(cost.toDecimalPlaces(2).toString(), '157.14')
  // Пустая полка: цена прихода становится ценой товара
  assert.equal(weightedPackCost({ stock: 0, looseUnits: 0, unitsPerPack: 1, cost: 50, addPacks: 4, addValue: 120 }).toString(), '30')
  // Ни остатка, ни прихода — цена прежняя
  assert.equal(weightedPackCost({ stock: 0, looseUnits: 0, unitsPerPack: 1, cost: 50, addPacks: 0, addValue: 0 }).toString(), '50')
})

// ── Журнал движений поверх свежего остатка с сервера ──

test('свежий остаток с сервера не стирает проданное на кассе', () => {
  const p = product({ id: 'par', stock: 10, unitsPerPack: 1 })
  const db = pharmacy({ products: [p] })
  take(db, { productId: 'par', units: -3, skipExpired: true })
  assert.equal(productsList(db, NOW)[0].stock, 7)

  // Сервер о продаже ещё не знает и снова присылает 10. Остаток на кассе — по-прежнему 7
  applySnapshot(db, { products: [p] }, { now: NOW })
  assert.equal(productsList(db, NOW)[0].stock, 7, 'проданное без связи «вернулось» на полку')

  // На другой кассе продали ещё 4: сервер присылает 6. Здесь — 6 минус свои 3
  applySnapshot(db, { products: [{ ...p, stock: 6 }] }, { now: NOW })
  assert.equal(productsList(db, NOW)[0].stock, 3)
})

test('принятое сервером движение второй раз не вычитается', () => {
  const p = product({ id: 'par', stock: 10, unitsPerPack: 1 })
  const db = pharmacy({ products: [p] })
  take(db, { productId: 'par', units: -3, skipExpired: true })
  // Сервер принял продажу: движение помечено, а в его остатке она уже учтена (7)
  db.prepare('UPDATE stock_moves SET synced = 1').run()
  applySnapshot(db, { products: [{ ...p, stock: 7 }] }, { now: NOW })
  assert.equal(productsList(db, NOW)[0].stock, 7, 'продажа вычтена дважды')
})

test('две кассы продали один и тот же последний товар: остаток ноль, недостача записана', () => {
  const p = product({ id: 'last', stock: 1, unitsPerPack: 1 })
  const db = pharmacy({ products: [p] })
  take(db, { productId: 'last', units: -1, skipExpired: true })
  // Пока связи не было, вторая касса продала ту же упаковку: на сервере уже 0
  applySnapshot(db, { products: [{ ...p, stock: 0 }] }, { now: NOW })
  const [view] = productsList(db, NOW)
  assert.equal(view.stock, 0, 'остаток не может уйти в минус на экране')
  assert.equal(productById(db, 'last').oversold, 1, 'проданное сверх остатка должно быть видно')
  // Недостача не копится от повторных сверок
  applySnapshot(db, { products: [{ ...p, stock: 0, minStock: 1 }] }, { now: NOW })
  assert.equal(productById(db, 'last').oversold, 1)
})

test('приход без связи: после сверки с сервером партия и средняя цена на месте', () => {
  const p = product({ id: 'amo', stock: 2, unitsPerPack: 10, looseUnits: 5, cost: 100, price: 150 })
  const db = pharmacy({ products: [p] })
  // Привезли 3 упаковки по 130 со своим сроком
  inTx(db, () =>
    move(
      db,
      { opId: 'arr', kind: 'arrival', productId: 'amo', units: 30, costC: 13000, expiryDate: day('2028-01-01'), arrivalId: 'a1', wPacks: 3, wValue: '390' },
      { now: NOW },
    ),
  )
  const check = () => {
    const [v] = productsList(db, NOW)
    assert.equal(v.stock, 5)
    assert.equal(v.looseUnits, 5)
    // (25 шт × 10 + 390) / 55 шт × 10 = 116,3636… → 116,36
    assert.equal(v.cost, 116.36)
  }
  check()
  // Сервер о приходе ещё не знает и присылает старую карточку — приход не теряется
  applySnapshot(db, { products: [p] }, { now: NOW })
  check()
  assert.equal(rows(db, "SELECT * FROM batches WHERE arrivalId = 'a1'").length, 1)
  // Проиграть журнал ещё раз — ничего не изменится (без накопления)
  rebuildStock(db)
  check()
})

test('проигрывание журнала оценивает срок на момент продажи, а не на сегодня', () => {
  // Партия годна до 4 октября. Продали 4-го — законно. Сверка пришла 6-го,
  // когда партия уже просрочена: продажа всё равно должна вычесться из неё
  const p = product({ id: 'srok', stock: 5, unitsPerPack: 1, expiryDate: day('2026-10-04') })
  const db = pharmacy({ products: [p] })
  take(db, { productId: 'srok', units: -2, skipExpired: true })
  const later = NOW + 2 * DAY
  applySnapshot(db, { products: [{ ...p, expiredUnits: 5 }] }, { now: later })
  assert.equal(productsList(db, later)[0].stock, 3)
  assert.equal(productById(db, 'srok').oversold, 0)
})

test('товар убрали из справочника, пока его продажа ждала отправки — сверка не падает', () => {
  const p = product({ id: 'gone', stock: 5 })
  const db = pharmacy({ products: [p] })
  take(db, { productId: 'gone', units: -1, skipExpired: true })
  assert.doesNotThrow(() => applySnapshot(db, { products: [] }, { now: NOW }))
  assert.equal(productsList(db, NOW).length, 0)
})

// ── Пока сервер не отдаёт партии: партии из карточки ──

test('из карточки получаются годная и просроченная партии', () => {
  const card = product({ id: 'x', stock: 3, looseUnits: 4, unitsPerPack: 10, expiredUnits: 0, expiryDate: day('2027-03-01'), cost: 50 })
  assert.deepEqual(
    batchesFromCard(card, NOW).map((b) => [b.id, b.units, b.expiryDate, b.costC]),
    [['card-g:x', 34, day('2027-03-01'), 5000]],
  )

  // Часть просрочена: ближайший срок относится к ней, про годную сервер молчит
  const mixed = { ...card, expiredUnits: 14, expiryDate: day('2026-09-01') }
  assert.deepEqual(
    batchesFromCard(mixed, NOW).map((b) => [b.id, b.units, b.expiryDate]),
    [
      ['card-e:x', 14, day('2026-09-01')],
      ['card-g:x', 20, null],
    ],
  )

  // Просрочено «больше, чем лежит» не бывает — подрезаем
  const all = batchesFromCard({ ...card, expiredUnits: 999, expiryDate: day('2026-09-01') }, NOW)
  assert.deepEqual(all.map((b) => [b.id, b.units]), [['card-e:x', 34]])

  // Просрочка есть, а срок сервер не прислал — партия всё равно считается негодной
  const [e] = batchesFromCard({ ...card, expiredUnits: 1, expiryDate: null }, NOW)
  assert.ok(e.expiryDate < '2026-10-03T19:00:00.000Z')

  assert.deepEqual(batchesFromCard({ ...card, stock: 0, looseUnits: 0 }, NOW), [])
})

test('карточка с просрочкой: касса продаёт только годное', () => {
  const p = product({ id: 'mix', name: 'Микс', stock: 10, unitsPerPack: 1, expiredUnits: 4, expiryDate: day('2026-09-01') })
  const db = pharmacy({ products: [p] })
  const [v] = productsList(db, NOW)
  assert.equal(v.stock, 10)
  assert.equal(v.expiredUnits, 4)
  refused(
    () => take(db, { productId: 'mix', units: -7, skipExpired: true }),
    400,
    '«Микс»: годных 6 шт, просрочено 4 шт. Просроченное продавать нельзя — уберите его с полки и спишите.',
  )
  assert.equal(take(db, { productId: 'mix', units: -6, skipExpired: true }).taken[0].batchId, 'card-g:mix')
})
