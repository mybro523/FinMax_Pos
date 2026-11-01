// ── Своя цена за 1 шт без интернета (версия 1.5.11) ──
//
// Владелец задаёт цену одной штуки сам — в приходе или в карточке. Касса без связи продаёт
// целые упаковки по цене упаковки, а отдельные штуки — по своей цене; чек помнит цену штуки
// (снимок), возврат считает по ней. Те же числа получит и сервер, когда чек до него дойдёт.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { productsList } from '../src/local/catalog.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { updateProduct } from '../src/local/ops/products.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { grossOf, ownPiece, ownPieceC, pieceCentsIn, refundOf } from '../src/local/piece.mjs'
import { ctx, NOW, pharmacy, product, row, rows } from '../test-support/pharmacy.mjs'

// Памперс: 90 штук в упаковке по 150, своя цена штуки 2. Аспирин — без своей цены.
// Мука — на вес (кг): своей цены штуки у неё не бывает, сколько бы ни прислали
function shop() {
  const pam = product({ id: 'pam', name: 'Памперс Р3', unitsPerPack: 90, price: 150, cost: 120, stock: 3, piecePrice: 2 })
  const asp = product({ id: 'asp', name: 'Аспирин', unitsPerPack: 20, price: 200, cost: 100, stock: 5 })
  const muka = product({ id: 'muka', name: 'Орди якум', unit: 'кг', unitsPerPack: 1000, price: 190, cost: 150, stock: 10, piecePrice: 5, expiryDate: null })
  return pharmacy({ products: [pam, asp, muka] })
}
const prod = (db, id) => productsList(db, NOW).find((p) => p.id === id)
const outbox = (db) => rows(db, 'SELECT type, payload FROM outbox ORDER BY seq').map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
const day10 = (p) => String(p.expiryDate || '').slice(0, 10)

test('карточка с сервера: своя цена штуки ложится в базу кассы (в дирамах) и видна окну', () => {
  const db = shop()
  assert.equal(prod(db, 'pam').piecePrice, 2)
  assert.equal(row(db, "SELECT pieceC FROM products WHERE id = 'pam'").pieceC, 200)
  // Сервер прежней версии поля не шлёт — своей цены нет
  assert.equal(prod(db, 'asp').piecePrice, null)
  assert.equal(row(db, "SELECT pieceC FROM products WHERE id = 'asp'").pieceC, null)
})

test('продажа без связи: упаковки — по цене упаковки, штуки — по своей цене; снимок — в чеке и в операции', () => {
  const db = shop()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'pam', qty: 1, pieces: 5 }, { productId: 'asp', qty: 0, pieces: 3 }] })
  // Памперс: 150 + 5 × 2 = 160. Аспирин без своей цены: 3 × 200 / 20 = 30
  assert.equal(sale.total, 190)
  const pam = sale.items.find((i) => i.productId === 'pam')
  assert.deepEqual([pam.qty, pam.pieces, pam.price, pam.piecePrice], [1, 5, 150, 2])
  assert.equal(sale.items.find((i) => i.productId === 'asp').piecePrice, null)
  const op = outbox(db).find((o) => o.type === 'sale')
  assert.equal(op.payload.sale.items.find((i) => i.productId === 'pam').piecePrice, 2, 'серверу уходит цена штуки, по которой продали')
  // Целая упаковка без штук — по цене упаковки, своя цена штуки её не трогает
  const pack = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'pam', qty: 1, pieces: 0 }] })
  assert.equal(pack.total, 150)
})

test('весовой товар своей цены штуки не имеет: грамм стоит цена килограмма / 1000', () => {
  const db = shop()
  assert.equal(prod(db, 'muka').piecePrice, 5, 'карточка хранит, что прислали')
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'muka', qty: 0, pieces: 2000 }] })
  assert.equal(sale.total, 380, '2 кг × 190')
  assert.equal(sale.items[0].piecePrice, null)
})

test('возврат без связи: сначала отдельные штуки — по своей цене, сверх них — упаковка', () => {
  const db = shop()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'pam', qty: 1, pieces: 5 }] })
  const r1 = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'pam', units: 5 }] })
  assert.equal(r1.total, 10, 'пять штук, купленных по 2, — 10, а не 8,42 (средняя по строке)')
  const r2 = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'pam', units: 90 }] })
  assert.equal(r2.total, 150, 'дальше — штуки из упаковки по цене упаковки')
})

test('возврат со скидкой на позицию: скидка делится пропорционально', () => {
  const db = shop()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'pam', qty: 1, pieces: 5, discount: 16 }] })
  assert.equal(sale.total, 144, '160 − 16')
  const r = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'pam', units: 5 }] })
  assert.equal(r.total, 9, 'скидка 10 %: пять штук по 2 — это 9')
})

test('приход без связи: своя цена штуки — сразу в карточку и в операцию; пусто — убрать; нет поля — не трогать', () => {
  const db = shop()
  createArrival(ctx(db), { items: [{ productId: 'asp', qty: 1, cost: 100, piecePrice: 12.5 }] })
  assert.equal(prod(db, 'asp').piecePrice, 12.5)
  assert.equal(outbox(db).at(-1).payload.arrival.items[0].piecePrice, 12.5)
  // Нет поля — цена штуки остаётся, серверу поле не уходит
  createArrival(ctx(db), { items: [{ productId: 'asp', qty: 1, cost: 100 }] })
  assert.equal(prod(db, 'asp').piecePrice, 12.5)
  assert.equal('piecePrice' in outbox(db).at(-1).payload.arrival.items[0], false)
  // Пусто — своей цены больше нет
  createArrival(ctx(db), { items: [{ productId: 'asp', qty: 1, cost: 100, piecePrice: null }] })
  assert.equal(prod(db, 'asp').piecePrice, null)
  assert.equal(outbox(db).at(-1).payload.arrival.items[0].piecePrice, null)
})

test('карточка без связи: своя цена штуки — поле правки; было и стало уходят серверу', () => {
  const db = shop()
  const before = prod(db, 'asp')
  updateProduct(ctx(db), 'asp', { ...before, piecePrice: 15, expiryDate: day10(before) })
  const op = outbox(db).at(-1)
  assert.deepEqual([op.type, op.payload.set, op.payload.base], ['product.update', { piecePrice: 15 }, { piecePrice: null }])
  assert.equal(prod(db, 'asp').piecePrice, 15)
  // Форма целиком без изменений — операции нет
  const n = outbox(db).length
  updateProduct(ctx(db), 'asp', { ...prod(db, 'asp'), expiryDate: day10(before) })
  assert.equal(outbox(db).length, n)
  // Стёрли — своей цены нет
  updateProduct(ctx(db), 'asp', { ...prod(db, 'asp'), piecePrice: null, expiryDate: day10(before) })
  assert.equal(prod(db, 'asp').piecePrice, null)
  assert.deepEqual(outbox(db).at(-1).payload.set, { piecePrice: null })
})

test('формулы цены штуки: как у сервера и окна', () => {
  const n = (d) => Number(d.toString())
  assert.equal(n(grossOf({ qty: 1, pieces: 5, price: 150, piecePrice: 2, unitsPerPack: 90 })), 160)
  assert.equal(n(grossOf({ qty: 1, pieces: 0, price: 150, piecePrice: null, unitsPerPack: 90 })), 150)
  assert.equal(n(grossOf({ qty: 0, pieces: 9, price: 150, unitsPerPack: 90 })), 15)
  assert.equal(ownPiece({ price: 190, piecePrice: 5, unitsPerPack: 1000, unit: 'кг' }), null)
  assert.equal(ownPiece({ price: 40, piecePrice: 5, unitsPerPack: 1 }), null)
  assert.equal(ownPieceC({ unitsPerPack: 90, pieceC: 200 }), 200)
  assert.equal(ownPieceC({ unitsPerPack: 90, pieceC: null }), null)
  assert.equal(pieceCentsIn(2.456), 246)
  for (const v of [null, undefined, '', 0, -1, 'abc']) assert.equal(pieceCentsIn(v), null, String(v))
  const line = { qty: 1, pieces: 5, price: 150, piecePrice: 2, unitsPerPack: 90, discount: 0 }
  assert.equal(n(refundOf(line, 5, 0)), 10)
  assert.equal(refundOf(line, 3, 4).toFixed(2), '5.33', 'одна штука отдельная (2), две — из упаковки (по 1,67)')
  // Без своей цены — как было всегда: поровну на штуку
  assert.equal(n(refundOf({ qty: 1, pieces: 5, price: 200, unitsPerPack: 20, discount: 10 }, 5)), 48)
})
