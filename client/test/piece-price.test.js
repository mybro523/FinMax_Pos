// ── Своя цена за 1 шт (версия 1.5.11) ──
//
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Касса продаёт
// целые упаковки по цене упаковки, а отдельные штуки — по своей цене; пусто — штука стоит
// цена упаковки / штук в упаковке, как было всегда. Возврат: сначала отдельные штуки по
// своей цене, сверх них — штуки из упаковок. Те же формулы — у сервера и программы.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownPiecePrice, pricePerPiece, lineGross, lineNet, stockValue, vozvratSumma } from '../src/lib/units.js'
import { qtyPriceText } from '../src/lib/ticket.js'
import { lineFromProduct, toItem, ownPiece, pieceChanged } from '../src/lib/prihod.js'

// Памперс: 90 штук в упаковке по 150, своя цена штуки 2
const pam = { unitsPerPack: 90, price: 150, cost: 120, piecePrice: 2, unit: 'уп' }
const t = (s) => s
const money = (v) => String(Math.round(v * 100) / 100)

test('своя цена штуки — только у делимого и не дробного товара; пусто и ноль — своей нет', () => {
  assert.equal(ownPiecePrice(pam), 2)
  assert.equal(ownPiecePrice({ ...pam, piecePrice: null }), null)
  assert.equal(ownPiecePrice({ ...pam, piecePrice: '' }), null)
  assert.equal(ownPiecePrice({ ...pam, piecePrice: 0 }), null)
  assert.equal(ownPiecePrice({ ...pam, unitsPerPack: 1 }), null, 'неделимый')
  assert.equal(ownPiecePrice({ unit: 'кг', unitsPerPack: 1000, price: 190, piecePrice: 5 }), null, 'дробный: «штука» — грамм')
  assert.equal(pricePerPiece(pam), 2)
  assert.equal(Math.round(pricePerPiece({ ...pam, piecePrice: null }) * 100) / 100, 1.67, 'по расчёту')
})

test('сумма строки: упаковки по цене упаковки, штуки по своей цене (пример владельца)', () => {
  assert.equal(lineGross({ ...pam, qty: 1, pieces: 5 }), 160, '150 + 5 × 2')
  assert.equal(lineGross({ ...pam, qty: 2, pieces: 0 }), 300, 'целые упаковки своя цена не трогает')
  assert.equal(lineGross({ ...pam, qty: 0, pieces: 90 }), 180, 'набрано штуками — штуками и считается')
  assert.equal(lineNet({ ...pam, qty: 1, pieces: 5, discount: 16 }), 144)
  // Своей цены нет — как было всегда
  assert.equal(lineGross({ ...pam, piecePrice: null, qty: 0, pieces: 9 }), 15)
  assert.equal(lineGross({ unitsPerPack: 20, price: 200, qty: 1, pieces: 5 }), 250)
})

test('стоимость склада: упаковки по цене упаковки, вскрытая — по своей цене штуки', () => {
  assert.equal(stockValue({ ...pam, stock: 2, looseUnits: 10 }), 320, '2 × 150 + 10 × 2')
  assert.equal(stockValue({ ...pam, piecePrice: null, stock: 2, looseUnits: 9 }), 315, 'по расчёту: 15 за 9 штук')
})

test('возврат: сначала отдельные штуки по своей цене, сверх них — штуки из упаковки', () => {
  const line = { ...pam, qty: 1, pieces: 5, discount: 0 }
  assert.equal(vozvratSumma(line, 5, 0), 10, 'а не 8,42 — средняя по строке')
  assert.equal(Math.round(vozvratSumma(line, 90, 5) * 100) / 100, 150, 'отдельные уже вернули — дальше упаковка')
  assert.equal(Math.round(vozvratSumma(line, 95, 0) * 100) / 100, 160, 'вся строка — всё, что заплатили')
  // Скидка позиции — пропорционально
  assert.equal(Math.round(vozvratSumma({ ...line, discount: 16 }, 5, 0) * 100) / 100, 9)
  // Своей цены нет — как всегда: поровну на штуку (за 25 штук заплатили 240 → 5 штук = 48)
  assert.equal(vozvratSumma({ unitsPerPack: 20, price: 200, qty: 1, pieces: 5, discount: 10 }, 5, 0), 48)
  assert.equal(vozvratSumma(line, 0, 0), 0)
})

test('чек: «1 уп × 150 + 5 шт × 2», если штука по своей цене; без неё — как раньше', () => {
  assert.equal(qtyPriceText({ ...pam, qty: 1, pieces: 5 }, t, money), '1 уп × 150 + 5 шт × 2')
  assert.equal(qtyPriceText({ ...pam, qty: 0, pieces: 5 }, t, money), '5 шт × 2')
  assert.equal(qtyPriceText({ ...pam, qty: 2, pieces: 0 }, t, money), '2 уп × 150')
  assert.equal(qtyPriceText({ ...pam, piecePrice: null, qty: 1, pieces: 5 }, t, money), '95 шт × 1.67')
})

test('приход: своя цена штуки уходит, только если её поменяли; пусто — «своей нет»', () => {
  const l = lineFromProduct({ id: 'pam', name: 'Памперс', barcode: '1', unit: 'уп', unitsPerPack: 90, cost: 120, price: 150, piecePrice: 2 })
  assert.deepEqual([l.piece, l.piece0, ownPiece(l), pieceChanged(l)], ['2', 2, 2, false])
  assert.equal('piecePrice' in toItem({ ...l, qty: '1', base: '120' }), false, 'не трогали — не шлём: иначе затёрли бы правку в карточке')
  assert.equal(toItem({ ...l, qty: '1', base: '120', piece: '2,5' }).piecePrice, 2.5)
  assert.equal(toItem({ ...l, qty: '1', base: '120', piece: '' }).piecePrice, null, 'стёрли — своей больше нет')
  // У товара своей цены не было — вписали
  const asp = lineFromProduct({ id: 'asp', name: 'Аспирин', unit: 'уп', unitsPerPack: 20, cost: 100, price: 200 })
  assert.deepEqual([asp.piece, asp.piece0], ['', null])
  assert.equal(toItem({ ...asp, qty: '1', base: '100', piece: '12' }).piecePrice, 12)
  // Неделимый товар своей цены штуки не шлёт никогда
  const bint = lineFromProduct({ id: 'b', name: 'Бинт', unit: 'шт', unitsPerPack: 1, cost: 5, price: 10 })
  assert.equal('piecePrice' in toItem({ ...bint, qty: '1', base: '5', piece: '3' }), false)
})
