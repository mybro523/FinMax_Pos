// ── Весовой товар в упаковке (версия 1.5.12) ──
//
// Мешок муки 50 кг по 190: мешки — по цене мешка, отдельные килограммы — по своей цене за
// 1 кг (piecePrice) или по расчёту. Внутри — 50 000 граммов в упаковке. Сервер считает так
// же, как сайт (client/src/lib/units.js) и программа (desktop/src/local/piece.mjs); строки
// прихода и возврата поставщику помнят свою упаковку; правка прежнего окна мешок не снимает.
//
// Запуск: npm test (в папке server; сначала собирается dist)
const test = require('node:test')
const assert = require('node:assert/strict')
const { grossOf, pieceOf, ownPiece, refundOf, refundCeiling, piecePriceShown, opensPack, packFor, lineUpp, MAX_UPP } = require('../dist/common/piece')
const { costInPack } = require('../dist/common/cost')
const { oldWindowPack, normalizePack } = require('../dist/products/products.service')
const { parseSale, parseArrival, parseSupplierReturn, parseArrivalUpdate, parseProductUpdate } = require('../dist/sync/payload')

const n = (d) => Number(d.toString())
const r2 = (d) => Math.round(n(d) * 100) / 100
const muka = { price: 190, piecePrice: 4, unitsPerPack: 50_000, unit: 'кг' }

test('мешок: упаковка по цене мешка, килограммы — по своей цене за 1 кг (на грамм — /1000)', () => {
  assert.equal(n(ownPiece(muka)), 4)
  assert.equal(n(pieceOf(muka)), 0.004)
  assert.equal(n(piecePriceShown(muka)), 4)
  assert.equal(r2(piecePriceShown({ ...muka, piecePrice: null })), 3.8)
  assert.equal(n(grossOf({ ...muka, qty: 0, pieces: 2000 })), 8)
  assert.equal(n(grossOf({ ...muka, qty: 1, pieces: 2000 })), 198)
  assert.equal(n(grossOf({ ...muka, piecePrice: null, qty: 0, pieces: 2000 })), 7.6)
  // Без мешка — на вес, своей цены нет
  assert.equal(ownPiece({ ...muka, unitsPerPack: 1000 }), null)
  assert.equal(n(grossOf({ ...muka, unitsPerPack: 1000, qty: 0, pieces: 2000 })), 380)
  // Единица не дробная (штучный с той же упаковкой) — своя цена за штуку
  assert.equal(n(grossOf({ ...muka, unit: 'уп', qty: 0, pieces: 2 })), 8)
  assert.equal(opensPack(muka), true)
  assert.equal(opensPack({ unit: 'кг', unitsPerPack: 1000 }), false)
  assert.equal(opensPack({ unit: 'уп', unitsPerPack: 20 }), true)
})

test('возврат мешка: сначала отдельные килограммы по своей цене; предел — с запасом на обе крайности', () => {
  const line = { ...muka, qty: 1, pieces: 2000, discount: 0 }
  assert.equal(r2(refundOf(line, 2000)), 8)
  assert.equal(r2(refundOf(line, 3000)), 11.8)
  assert.equal(r2(refundOf(line, 3000, 2000)), 11.4)
  assert.equal(r2(refundCeiling(line, 3000)), 11.8)
})

test('упаковка дробного — не меньше одной единицы; строка без упаковки у весового — килограммами', () => {
  assert.equal(packFor('кг', 500), 1000)
  assert.equal(packFor('кг', 50_000), 50_000)
  assert.equal(packFor('уп', 1), 1)
  assert.equal(MAX_UPP, 1_000_000)
  // Прежние окна у весового считали строку килограммами, что бы ни стояло в карточке
  assert.equal(lineUpp({}, { unit: 'кг', unitsPerPack: 50_000 }), 1000)
  assert.equal(lineUpp({}, { unit: 'уп', unitsPerPack: 20 }), 20)
  assert.equal(lineUpp({ unitsPerPack: 50_000 }, { unit: 'кг', unitsPerPack: 1000 }), 50_000)
  // Цена строки — в цену упаковки товара: 185 за кг при мешке 50 кг — 9250 за мешок
  assert.equal(n(costInPack(185, 1000, 50_000)), 9250)
  assert.equal(n(costInPack(185, 50_000, 50_000)), 185)
  assert.equal(n(costInPack(190, 50_000, 1000)), 3.8)
})

test('правка карточки прежним окном: мешок и своя цена остаются, остаток — из килограммов в граммы', () => {
  const was = { unit: 'кг', unitsPerPack: 50_000, piecePrice: 4 }
  // Прежнее окно у весового шлёт «1 кг в упаковке», своей цены нет, остаток — килограммами
  const data = { name: 'Мука', unit: 'кг', unitsPerPack: 1000, piecePrice: null, stock: 110, looseUnits: 0 }
  oldWindowPack(data, false, was)
  assert.equal('unitsPerPack' in data, false)
  assert.equal('piecePrice' in data, false)
  assert.deepEqual([data.stock, data.looseUnits], [2, 10_000], '110 кг = 2 мешка + 10 кг')
  // Новое окно (drobPack) — как прислало
  const fresh = { unitsPerPack: 1000, piecePrice: null }
  oldWindowPack(fresh, true, was)
  assert.equal(fresh.unitsPerPack, 1000)
  // Товар без мешка прежнее окно правит как раньше
  const plain = { unitsPerPack: 1000, stock: 5, looseUnits: 0 }
  oldWindowPack(plain, false, { unit: 'кг', unitsPerPack: 1000, piecePrice: null })
  assert.equal(plain.unitsPerPack, 1000)
})

test('нормализация карточки: у дробного упаковка не меньше 1000, своя цена — только у мешка', () => {
  const a = { unitsPerPack: 500 }
  normalizePack(a, { unit: 'кг', unitsPerPack: 1000, piecePrice: null })
  assert.equal(a.unitsPerPack, 1000)
  // Убрали мешок — своя цена за кг уходит
  const b = { unitsPerPack: 1000 }
  normalizePack(b, { unit: 'кг', unitsPerPack: 50_000, piecePrice: 4 })
  assert.equal(b.piecePrice, null)
  // Мешок есть — своя цена остаётся
  const c = { unitsPerPack: 50_000, piecePrice: 4 }
  normalizePack(c, { unit: 'кг', unitsPerPack: 1000, piecePrice: null })
  assert.equal(c.piecePrice, 4)
  // Сменили единицу на дробную — упаковка становится граммами
  const d = { unit: 'кг' }
  normalizePack(d, { unit: 'уп', unitsPerPack: 20, piecePrice: 2 })
  assert.equal(d.unitsPerPack, 1000)
  assert.equal(d.piecePrice, null)
})

test('обмен с кассами: единица в чеке, упаковка строк прихода и возврата, метка новой кассы', () => {
  const NOW = Date.parse('2026-11-01T10:00:00.000Z')
  const sale = parseSale({ sale: {
    id: 's-1', date: '2026-11-01T09:00:00.000Z', payment: 'cash', total: 198, cost: 0, profit: 198,
    items: [{ id: 's-1-i', productId: 'muka', name: 'Мука', qty: 1, pieces: 2000, unitsPerPack: 50_000, price: 190, piecePrice: 4, unit: 'кг', cost: 0 }],
  } }, NOW)
  assert.equal(sale.items[0].unit, 'кг')
  assert.equal(sale.items[0].unitsPerPack, 50_000)
  // Упаковка больше прежних 100 000 — бочка 200 л
  assert.equal(parseSale({ sale: { id: 's-2', date: '2026-11-01T09:00:00.000Z', payment: 'cash', total: 1, cost: 0, profit: 1, items: [{ id: 's-2-i', productId: 'p', name: 'x', qty: 0, pieces: 1, unitsPerPack: 200_000, price: 1, cost: 0 }] } }, NOW).items[0].unitsPerPack, 200_000)

  const arr = parseArrival({ arrival: {
    id: 'a-1', date: '2026-11-01T09:00:00.000Z', total: 370,
    items: [{ id: 'a-1-i', productId: 'muka', name: 'Мука', qty: 2, pieces: 0, cost: 185, unitsPerPack: 50_000, packChanged: true }],
  }, expiry: [] }, NOW)
  assert.equal(arr.items[0].unitsPerPack, 50_000)
  assert.equal(arr.items[0].packChanged, true)
  // Прежняя касса упаковку не шлёт — поля нет
  const old = parseArrival({ arrival: { id: 'a-2', date: '2026-11-01T09:00:00.000Z', total: 10, items: [{ id: 'a-2-i', productId: 'p', name: 'x', qty: 1, cost: 10 }] }, expiry: [] }, NOW)
  assert.equal('unitsPerPack' in old.items[0], false)
  assert.equal(old.items[0].packChanged, false)
  // Граммы сверх мешков — больше прежних 99 999
  assert.equal(parseArrival({ arrival: { id: 'a-3', date: '2026-11-01T09:00:00.000Z', total: 0, items: [{ id: 'a-3-i', productId: 'p', name: 'x', qty: 0, pieces: 150_000, cost: 0, unitsPerPack: 200_000 }] }, expiry: [] }, NOW).items[0].pieces, 150_000)

  const ret = parseSupplierReturn({ ret: { id: 'r-1', date: '2026-11-01T09:00:00.000Z', supplierId: 'sup', refund: 'debt', total: 180, items: [{ id: 'r-1-i', productId: 'muka', name: 'Мука', qty: 1, pieces: 0, price: 180, unitsPerPack: 50_000 }] } }, NOW)
  assert.equal(ret.items[0].unitsPerPack, 50_000)
  const upd = parseArrivalUpdate({ at: '2026-11-01T09:00:00.000Z', arrival: { id: 'a-1', items: [{ id: 'a-1-i', qty: 2, pieces: 0, cost: 185, unitsPerPack: 50_000 }] } }, NOW)
  assert.equal(upd.items[0].unitsPerPack, 50_000)
  // Касса 1.5.12 метит правку карточки: она знает мешки
  assert.equal(parseProductUpdate({ id: 'muka', at: '2026-11-01T09:00:00.000Z', set: { unitsPerPack: 50_000 }, base: {}, drobPack: true }, NOW).drobPack, true)
  assert.equal(parseProductUpdate({ id: 'muka', at: '2026-11-01T09:00:00.000Z', set: { unitsPerPack: 1000 }, base: {} }, NOW).drobPack, false)
})

test('строка прежнего окна у товара в мешке — не принимаем; у товара на вес и у штучного — как раньше', () => {
  const { oldLineOnSack, OLD_WINDOW_SACK } = require('../dist/common/piece')
  assert.equal(oldLineOnSack({}, { unit: 'кг', unitsPerPack: 50_000 }), true)
  assert.equal(oldLineOnSack({ unitsPerPack: 50_000 }, { unit: 'кг', unitsPerPack: 50_000 }), false, 'новое окно шлёт упаковку строки')
  assert.equal(oldLineOnSack({}, { unit: 'кг', unitsPerPack: 1000 }), false, 'на вес — килограммы и есть')
  assert.equal(oldLineOnSack({}, { unit: 'уп', unitsPerPack: 20 }), false, 'штучный — как всегда')
  assert.match(OLD_WINDOW_SACK('Мука'), /Обновите программу/)
})
