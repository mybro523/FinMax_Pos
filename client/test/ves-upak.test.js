// ── Весовой товар в упаковке (версия 1.5.12) ──
//
// Мешок муки 50 кг по 190 сомони: касса продаёт мешки по цене мешка, а отдельные килограммы —
// по своей цене за 1 кг (4) или по расчёту (190 / 50 = 3,80). Внутри мешок — 50 000 граммов
// в упаковке, отдельные килограммы — граммы в «штуках» строки. Без мешка весовой товар
// продаётся на вес, как раньше. Те же формулы — у сервера и программы.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ownPiecePrice, pricePerPiece, lineGross, lineNet, stockValue, vozvratSumma, isDivisible, vesUpak, packPieces,
  pieceUnits, unitsText, opensPack,
} from '../src/lib/units.js'
import { qtyPriceText } from '../src/lib/ticket.js'
import {
  lineFromProduct, lineUnits, linePacks, lineTotal, toItem, toRetItem, retLineFromProduct, piecePrice, qtyText, packText,
  packFromField, packField, withPack, packChanged, lineProblem,
} from '../src/lib/prihod.js'
import { stockAtOpen, editPatch } from '../src/lib/productEdit.js'
import { qtyText as otchetQty } from '../src/lib/otchety.js'

// Мука «Орди якум»: мешок 50 кг по 190, своя цена килограмма 4
const muka = { id: 'muka', name: 'Орди якум', unit: 'кг', unitsPerPack: 50_000, price: 190, cost: 185, piecePrice: 4 }
// Тот же товар без мешка — на вес, цена за 1 кг
const naVes = { ...muka, unitsPerPack: 1000, price: 190, piecePrice: null }
const t = (s) => s
const money = (v) => String(Math.round(v * 100) / 100)
const r2 = (v) => Math.round(v * 100) / 100

test('мешок вскрывают, на вес — нет; своя цена — за 1 кг и только у мешка', () => {
  assert.equal(opensPack(muka), true)
  assert.equal(vesUpak(muka), true)
  assert.equal(isDivisible(muka), true)
  assert.equal(packPieces(muka), 50)
  assert.equal(pieceUnits(muka), 1000)
  assert.equal(ownPiecePrice(muka), 4)
  assert.equal(pricePerPiece(muka), 4)
  assert.equal(r2(pricePerPiece({ ...muka, piecePrice: null })), 3.8, 'по расчёту: 190 / 50')
  // Без мешка своей цены не бывает: цена продажи и так за килограмм
  assert.equal(opensPack(naVes), false)
  assert.equal(isDivisible(naVes), false, 'весовой без мешка «на штуки» не делится')
  assert.equal(ownPiecePrice({ ...naVes, piecePrice: 5 }), null)
  assert.equal(pricePerPiece(naVes), 190)
  // Мешок меньше килограмма упаковкой не считается
  assert.equal(opensPack({ ...muka, unitsPerPack: 1000 }), false)
})

test('касса: «0 уп + 2 кг» и «1 уп + 2 кг» — мешок по цене мешка, килограммы по своей', () => {
  assert.equal(r2(lineGross({ ...muka, qty: 0, pieces: 2000 })), 8, '2 кг × 4')
  assert.equal(r2(lineGross({ ...muka, qty: 1, pieces: 2000 })), 198, '190 + 2 × 4')
  assert.equal(r2(lineGross({ ...muka, qty: 2, pieces: 0 })), 380)
  assert.equal(r2(lineGross({ ...muka, qty: 0, pieces: 1250 })), 5, '1,25 кг × 4')
  // Своей цены нет — килограмм по расчёту
  assert.equal(r2(lineGross({ ...muka, piecePrice: null, qty: 0, pieces: 2000 })), 7.6)
  assert.equal(r2(lineGross({ ...muka, piecePrice: null, qty: 1, pieces: 2000 })), 197.6)
  // Скидка — с суммы позиции
  assert.equal(r2(lineNet({ ...muka, qty: 1, pieces: 2000, discount: 8 })), 190)
  // Без мешка — как раньше: 2 кг × 190
  assert.equal(r2(lineGross({ ...naVes, qty: 0, pieces: 2000 })), 380)
})

test('возврат: сначала отдельные килограммы по своей цене, сверх них — из мешка по расчёту', () => {
  const line = { ...muka, qty: 1, pieces: 2000, discount: 0 }
  assert.equal(r2(vozvratSumma(line, 2000)), 8)
  assert.equal(r2(vozvratSumma(line, 3000)), 11.8, '2 кг × 4 + 1 кг × 3,8')
  assert.equal(r2(vozvratSumma(line, 3000, 2000)), 11.4, 'отдельные уже вернули — все три из мешка')
  // Скидка делится пропорционально
  assert.equal(r2(vozvratSumma({ ...line, discount: 19.8 }, 2000)), 7.2)
})

test('остаток мешками: «2 уп + 10 кг», стоимость — мешки по цене мешка, вскрытый — по своей', () => {
  assert.equal(unitsText(110_000, muka), '2 уп + 10 кг')
  assert.equal(unitsText(100_000, muka), '2 уп')
  assert.equal(unitsText(10_000, muka), '0 уп + 10 кг')
  assert.equal(unitsText(12_350, naVes), '12,35 кг', 'без мешка — одним весом')
  assert.equal(unitsText(205, { unit: 'уп', unitsPerPack: 20 }), '10 уп + 5 шт', 'штучный — как всегда')
  assert.equal(r2(stockValue({ ...muka, stock: 2, looseUnits: 10_000 })), 420)
  assert.equal(r2(stockValue({ ...muka, piecePrice: null, stock: 2, looseUnits: 10_000 })), 418)
  // Отчёты — так же
  assert.equal(otchetQty(110_000, muka), '2 уп + 10 кг')
  assert.equal(otchetQty(2000, muka), '2 кг')
  assert.equal(otchetQty(12_350, naVes), '12,35 кг')
})

test('чек: «1 уп × 190 + 2 кг × 4», без своей цены — всё килограммами по цене килограмма', () => {
  assert.equal(qtyPriceText({ ...muka, qty: 1, pieces: 2000 }, t, money), '1 уп × 190 + 2 кг × 4')
  assert.equal(qtyPriceText({ ...muka, qty: 0, pieces: 2500 }, t, money), '2,5 кг × 4')
  assert.equal(qtyPriceText({ ...muka, qty: 2, pieces: 0 }, t, money), '2 уп × 190')
  assert.equal(qtyPriceText({ ...muka, piecePrice: null, qty: 1, pieces: 2000 }, t, money), '52 кг × 3.8')
  assert.equal(qtyPriceText({ ...naVes, qty: 0, pieces: 1500 }, t, money), '1,5 кг × 190', 'без мешка — как раньше')
})

test('приход: «уп + кг», цены за мешок, цена за 1 кг по расчёту, упаковка строки уходит на сервер', () => {
  const l = { ...lineFromProduct(muka), qty: '2', pieces: '10', base: '185', price: '190' }
  assert.equal(l.ves, true)
  assert.equal(l.div, true)
  assert.equal(lineUnits(l), 110_000)
  assert.equal(linePacks(l), 2.2)
  assert.equal(r2(lineTotal(l)), 407, '185 × 2,2')
  assert.equal(r2(piecePrice(l)), 3.8)
  assert.equal(qtyText(l, t), '2 уп + 10 кг')
  assert.equal(packText(l, t), '50 кг')
  assert.equal(lineProblem({ ...l, qty: '0', pieces: '' }), 'укажите количество')
  assert.deepEqual(toItem(l), { productId: 'muka', name: 'Орди якум', qty: 2, pieces: 10_000, unitsPerPack: 50_000, cost: 185, discount: 0, expiryDate: '' })
  assert.equal(packChanged(l), false)
  // Килограммы с граммами сверх мешков
  assert.equal(lineUnits({ ...l, qty: '0', pieces: '2,5' }), 2500)
})

test('приход: мешок задали прямо в строке — карточка получит его (packChanged)', () => {
  const was = lineFromProduct(naVes)
  assert.equal(was.div, false)
  const l = { ...withPack(was, packFromField('50', true)), qty: '2', pieces: '', base: '185', price: '190' }
  assert.equal(l.div, true)
  assert.equal(packChanged(l), true)
  const item = toItem(l)
  assert.equal(item.unitsPerPack, 50_000)
  assert.equal(item.packChanged, true)
  assert.equal(item.qty, 2)
  assert.equal(item.pieces, 0)
  // Поле упаковки: пусто, 1 и меньше — на вес; дробное — граммами
  assert.equal(packFromField('', true), 1000)
  assert.equal(packFromField('1', true), 1000)
  assert.equal(packFromField('2.5', true), 2500)
  assert.equal(packFromField('2,5', true), 2500)
  assert.equal(packField(50_000, true), '50')
  assert.equal(packField(2500, true), '2.5')
  assert.equal(packField(1000, true), '')
  // У штучного — штук в упаковке, пусто — одна
  assert.equal(packFromField('24', false), 24)
  assert.equal(packFromField('', false), 1)
  assert.equal(packField(20, false), '20')
  // Убрали мешок — строка снова на вес
  const back = withPack(lineFromProduct(muka), packFromField('', true))
  assert.equal(back.div, false)
  assert.equal(packChanged(back), true)
})

test('возврат поставщику мешками: упаковка строки — с ней', () => {
  const r = { ...retLineFromProduct({ ...muka, stock: 2, looseUnits: 0 }), qty: '1', pieces: '5', price: '180' }
  assert.deepEqual(toRetItem(r), { productId: 'muka', name: 'Орди якум', qty: 1, pieces: 5000, unitsPerPack: 50_000, price: 180 })
})

test('карточка: остаток весового — одним числом в килограммах; не правили — не уходит', () => {
  const p = { ...muka, stock: 2, looseUnits: 10_000 }
  assert.deepEqual(stockAtOpen(p), { stock: '110', looseUnits: '0' })
  // Форма показывает «110» кг: не трогали — остаток на сервер не идёт (иначе проданное за
  // минуту, пока форма открыта, вернулось бы на полку)
  const sent = editPatch({ stock: '110', looseUnits: '0' }, { name: 'x', stock: 2, looseUnits: 10_000 }, stockAtOpen(p))
  assert.equal('stock' in sent, false)
  const edited = editPatch({ stock: '120', looseUnits: '0' }, { name: 'x', stock: 2, looseUnits: 20_000 }, stockAtOpen(p))
  assert.equal(edited.stock, 2)
})

// ── Смена мешка: «за что были прежние цены» (после ревью) ──
import { repackAsk, repackNeeded } from '../src/lib/vesUpak.js'
import { packAsk, lastSupplierCost } from '../src/lib/prihod.js'
import { nakleekNaStroku } from '../src/lib/nakleyka.js'

test('карточка: сменили мешок у товара с ценами — без ответа «за что были цены» не сохранить', () => {
  const card = { unit: 'кг', vesUp: '50', upp0: 1000, cost0: '185', price0: '190', stock0: 10_000 }
  assert.deepEqual(repackAsk(card), { was: 1000, now: 50_000, ratio: 50 })
  assert.equal(repackNeeded(card), true)
  assert.equal(repackNeeded({ ...card, repack: 'keep' }), false)
  assert.equal(repackNeeded({ ...card, repack: 'scale' }), false)
  // Мешок не меняли — спрашивать нечего; новый товар без цен и остатка — тоже
  assert.equal(repackAsk({ ...card, vesUp: '' }), null)
  assert.equal(repackAsk({ unit: 'кг', vesUp: '50', upp0: 1000, cost0: '0', price0: '0', stock0: 0 }), null)
  // Штучный товар в карточке так не спрашивает: там «упаковок столько же»
  assert.equal(repackAsk({ unit: 'уп', unitsPerPack: '24', upp0: 20, cost0: '100', price0: '120', stock0: 200 }), null)
})

test('приход: сменили упаковку у товара с ценами — строку не добавить, пока не ответили; ответ уходит на сервер', () => {
  const l = { ...withPack(lineFromProduct({ ...naVes, cost: 185, price: 190, stock: 10, looseUnits: 0 }), 50_000), qty: '2', pieces: '', base: '9250', price: '9500' }
  assert.deepEqual(packAsk(l), { was: 1000, now: 50_000, ratio: 50 })
  assert.equal(lineProblem(l), 'укажите, за что были прежние цены')
  assert.equal(lineProblem({ ...l, packScale: 'scale' }), '')
  assert.equal(toItem({ ...l, packScale: 'scale' }).packScale, true)
  assert.equal('packScale' in toItem({ ...l, packScale: 'keep' }), false, 'оставить — переводить нечего')
  // Товар без цен и остатка — не спрашиваем
  const bare = withPack(lineFromProduct({ ...naVes, cost: 0, price: 0, stock: 0, looseUnits: 0 }), 50_000)
  assert.equal(packAsk(bare), null)
})

test('возврат поставщику: цена из прежнего прихода — в упаковку товара сейчас', () => {
  const arrivals = [{ supplierId: 's', items: [{ productId: 'muka', cost: 185, unitsPerPack: 1000 }] }]
  assert.equal(lastSupplierCost(arrivals, 's', 'muka', 50_000), 9250, '185 за кг — 9250 за мешок')
  assert.equal(lastSupplierCost(arrivals, 's', 'muka', 1000), 185)
  assert.equal(lastSupplierCost([{ supplierId: 's', items: [{ productId: 'muka', cost: 185 }] }], 's', 'muka', 50_000), 185, 'строка без упаковки — как есть')
})

test('наклейки на приход: прежняя строка «100 кг» у товара в мешках — одна наклейка, а не сто', () => {
  assert.equal(nakleekNaStroku({ qty: 100, pieces: 0, unitsPerPack: 1000 }, muka), 1)
  assert.equal(nakleekNaStroku({ qty: 2, pieces: 10_000, unitsPerPack: 50_000 }, muka), 3, '2 мешка + вскрытый')
  assert.equal(nakleekNaStroku({ qty: 2, pieces: 0 }, naVes), 1)
})
