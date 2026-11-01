// ── Весовой товар в упаковке без интернета (версия 1.5.12) ──
//
// Мешок муки 50 кг по 190: касса без связи продаёт мешки по цене мешка, отдельные
// килограммы — по своей цене за 1 кг (4) или по расчёту (3,80). Чек помнит единицу и цену
// килограмма; приход может поменять упаковку товара (килограмм → мешок), и остаток при этом
// не меняется — он в граммах. Строки приходов и возвратов поставщику несут свою упаковку.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { productsList } from '../src/local/catalog.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { updateProduct } from '../src/local/ops/products.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { createSupplierReturn } from '../src/local/ops/supplierreturn.mjs'
import { arrivalView, updateArrival } from '../src/local/ops/arrivaledit.mjs'
import { grossOf, ownPieceC, opensPack, packFor, lineUpp, costCInPack } from '../src/local/piece.mjs'
import { unitsOf } from '../src/local/stock.mjs'
import { ctx, NOW, pharmacy, product, row, rows } from '../test-support/pharmacy.mjs'

// «Орди якум» в мешках по 50 кг (2 мешка + 10 кг), своя цена килограмма 4. «Сахар» — на вес
function shop() {
  const muka = product({ id: 'muka', name: 'Орди якум', unit: 'кг', unitsPerPack: 50_000, price: 190, cost: 185, stock: 2, looseUnits: 10_000, piecePrice: 4, expiryDate: null })
  const sahar = product({ id: 'sahar', name: 'Сахар', unit: 'кг', unitsPerPack: 1000, price: 12, cost: 10, stock: 30, looseUnits: 0, expiryDate: null })
  return pharmacy({ products: [muka, sahar] })
}
const prod = (db, id) => productsList(db, NOW).find((p) => p.id === id)
const outbox = (db) => rows(db, 'SELECT type, payload FROM outbox ORDER BY seq').map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
const lastOp = (db, type) => outbox(db).filter((o) => o.type === type).pop()

test('формула кассы: своя цена — за 1 кг и только у мешка; упаковка дробного — не меньше килограмма', () => {
  const muka = { unit: 'кг', unitsPerPack: 50_000, price: 190, piecePrice: 4 }
  assert.equal(grossOf({ ...muka, qty: 1, pieces: 2000 }).toNumber(), 198)
  assert.equal(grossOf({ ...muka, qty: 0, pieces: 2000 }).toNumber(), 8)
  assert.equal(grossOf({ ...muka, piecePrice: null, qty: 0, pieces: 2000 }).toNumber(), 7.6)
  assert.equal(ownPieceC({ unit: 'кг', unitsPerPack: 1000, pieceC: 400 }), null, 'без мешка своей цены нет')
  assert.equal(ownPieceC({ unit: 'кг', unitsPerPack: 50_000, pieceC: 400 }), 400)
  assert.equal(opensPack({ unit: 'кг', unitsPerPack: 1000 }), false)
  assert.equal(packFor('кг', 300), 1000)
  assert.equal(lineUpp({}, { unit: 'кг', unitsPerPack: 50_000 }), 1000, 'прежнее окно — килограммами')
  assert.equal(lineUpp({ unitsPerPack: 50_000 }, { unit: 'кг', unitsPerPack: 1000 }), 50_000)
  assert.equal(costCInPack(18_500, 1000, 50_000), 925_000)
})

test('карточка с сервера: мешок и своя цена за 1 кг, остаток «2 уп + 10 кг»', () => {
  const db = shop()
  const m = prod(db, 'muka')
  assert.deepEqual([m.unitsPerPack, m.stock, m.looseUnits, m.piecePrice], [50_000, 2, 10_000, 4])
  assert.equal(row(db, "SELECT pieceC FROM products WHERE id = 'muka'").pieceC, 400)
})

test('продажа без связи: «1 уп + 2 кг» = 190 + 8; единица и цена килограмма — снимком в чеке и в операции', () => {
  const db = shop()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'muka', qty: 1, pieces: 2000 }] })
  assert.equal(sale.total, 198)
  assert.deepEqual([sale.items[0].unit, sale.items[0].piecePrice, sale.items[0].unitsPerPack], ['кг', 4, 50_000])
  const op = lastOp(db, 'sale')
  assert.equal(op.payload.sale.items[0].unit, 'кг')
  assert.equal(op.payload.sale.items[0].piecePrice, 4)
  // Со склада ушло 52 кг: было 110
  assert.equal(unitsOf(db, 'muka', NOW).units, 58_000)
  // Весовой без мешка — как раньше: 2 кг × 12
  const s2 = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'sahar', qty: 0, pieces: 2000 }] })
  assert.equal(s2.total, 24)
  assert.equal(s2.items[0].piecePrice, null)
})

test('возврат без связи: отдельные килограммы — по своей цене, сверх них — из мешка', () => {
  const db = shop()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'muka', qty: 1, pieces: 2000 }] })
  const r1 = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'muka', units: 2000 }] })
  assert.equal(r1.total, 8)
  const r2 = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'muka', units: 1000 }] })
  assert.equal(r2.total, 3.8, 'отдельные уже вернули — килограмм из мешка по расчёту')
  assert.throws(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'muka', units: 50_000 }] }), /уже возвращено 3 из 52 кг/)
})

test('приход без связи меняет упаковку: «на вес» → мешок 50 кг; остаток в граммах прежний, средняя цена — по мешку', () => {
  const db = shop()
  // Сахар на вес: 30 кг по 10 за кг. Пришло 2 мешка по 50 кг, 450 за мешок, продаём по 600
  const a = createArrival(ctx(db), {
    supplier: 'Склад',
    items: [{ productId: 'sahar', qty: 2, pieces: 0, unitsPerPack: 50_000, packChanged: true, cost: 450, price: 600, piecePrice: 13 }],
  })
  const s = prod(db, 'sahar')
  assert.equal(s.unitsPerPack, 50_000)
  assert.deepEqual([s.stock, s.looseUnits], [2, 30_000], '130 кг = 2 мешка + 30 кг')
  assert.equal(s.price, 600)
  assert.equal(s.piecePrice, 13, 'своя цена за 1 кг — у мешка она уже бывает')
  // Строка помнит упаковку, операция несёт её и отметку смены упаковки
  assert.equal(a.items[0].unitsPerPack, 50_000)
  const op = lastOp(db, 'arrival')
  assert.equal(op.payload.arrival.items[0].unitsPerPack, 50_000)
  assert.equal(op.payload.arrival.items[0].packChanged, true)
  assert.equal(a.total, 900)
  // Смена упаковки — правкой карточки под номером прихода: свежие данные сервера её не затрут
  assert.ok(rows(db, "SELECT data FROM row_edits WHERE tbl = 'products' AND rowId = 'sahar'").some((r) => JSON.parse(r.data).set?.unitsPerPack === 50_000))
})

test('приход строкой прежнего окна у товара с мешком: килограммами, цена партии — за мешок', () => {
  const db = shop()
  // Без упаковки строки: 3 кг по 4 за кг
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'muka', qty: 3, pieces: 0, cost: 4 }] })
  assert.equal(unitsOf(db, 'muka', NOW).units, 113_000)
  const batch = rows(db, "SELECT costC FROM batches WHERE productId = 'muka' AND arrivalId IS NOT NULL").pop()
  assert.equal(batch.costC, 20_000, '4 за кг — это 200 за мешок')
})

test('убрали мешок в приходе — своя цена за 1 кг уходит вместе с ним', () => {
  const db = shop()
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'muka', qty: 5, pieces: 0, unitsPerPack: 1000, packChanged: true, cost: 4 }] })
  const m = prod(db, 'muka')
  assert.equal(m.unitsPerPack, 1000)
  assert.equal(m.piecePrice, null)
  assert.deepEqual([m.stock, m.looseUnits], [115, 0], '115 кг на вес')
})

test('правка прихода: строка читается по своей упаковке и уходит с ней', () => {
  const db = shop()
  const a = createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'muka', qty: 2, pieces: 0, unitsPerPack: 50_000, cost: 185 }] })
  const v = arrivalView(db, a.id)
  assert.equal(v.items[0].unitsPerPack, 50_000)
  updateArrival(ctx(db), a.id, { items: [{ id: a.items[0].id, qty: 3, pieces: 0, unitsPerPack: 50_000, cost: 185 }] })
  assert.equal(unitsOf(db, 'muka', NOW).units, 260_000, '110 кг + 3 мешка')
  const op = lastOp(db, 'arrival.update')
  assert.equal(op.payload.arrival.items[0].unitsPerPack, 50_000)
})

test('карточка без связи: мешок задали без правки остатка — остаток прежний, правка помечена «знает мешки»', () => {
  const db = shop()
  updateProduct(ctx(db), 'sahar', { unit: 'кг', unitsPerPack: 50_000, piecePrice: 13 })
  const s = prod(db, 'sahar')
  assert.equal(s.unitsPerPack, 50_000)
  assert.equal(unitsOf(db, 'sahar', NOW).units, 30_000, 'граммы те же')
  const op = lastOp(db, 'product.update')
  assert.equal(op.payload.drobPack, true)
  assert.equal(op.payload.stock, null, 'остаток не правили — пересчёта нет')
  // Своя цена за кг без мешка не держится
  updateProduct(ctx(db), 'sahar', { unit: 'кг', unitsPerPack: 1000 })
  assert.equal(prod(db, 'sahar').piecePrice, null)
})

test('возврат поставщику мешками: строка несёт упаковку, со склада — граммами', () => {
  const db = shop()
  const r = createSupplierReturn(ctx(db), { supplierId: 'sup-1', refund: 'card', items: [{ productId: 'muka', qty: 1, pieces: 5000, unitsPerPack: 50_000, price: 180 }] })
  assert.equal(r.total, 198, '180 за мешок × 1,1')
  assert.equal(r.items[0].unitsPerPack, 50_000)
  assert.equal(unitsOf(db, 'muka', NOW).units, 55_000)
  assert.equal(lastOp(db, 'supplier.return').payload.ret.items[0].unitsPerPack, 50_000)
})
