// Расчёты нового прихода: скидка поставщика, «упаковки + штуки», итоги панели и
// строка для отправки. Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { discCost, discPct, lineFromProduct, lineUnits, linePacks, lineTotal, lineBase, lineRetail, summary, qtyText, packText, lineProblem, toItem, piecePrice, lastSupplierCost, retLineFromProduct, retLineSum, retSummary, retProblem, toRetItem } from '../src/lib/prihod.js'

const par = { id: 'par', name: 'Парацетамол', barcode: '4870001', category: 'Таблетки', unit: 'уп', unitsPerPack: 20, cost: 120, price: 150 }
const voda = { id: 'voda', name: 'Вода', barcode: '4870002', unit: 'шт', unitsPerPack: 1, cost: 4, price: 6 }
const sahar = { id: 'sahar', name: 'Сахар', barcode: '2000001', unit: 'кг', unitsPerPack: 1000, cost: 10, price: 12 }
const line = (p, over = {}) => ({ ...lineFromProduct(p), ...over })

test('скидка поставщика: цена со скидкой без округления до дирам, процент — от 0 до 100', () => {
  assert.equal(discCost(120, 15), 102)
  assert.equal(discCost('10', '0'), 10)
  assert.equal(discCost(10, ''), 10)
  // 33,333 со скидкой — не до дирама: сумма строки должна сойтись с накладной
  assert.equal(discCost(9.99, 7), 9.2907)
  assert.equal(discCost(100, 100), 0)
  assert.equal(discCost(100, 150), 0, 'больше 100% не бывает')
  assert.equal(discCost(100, -5), 100, 'отрицательной скидки не бывает')
  assert.equal(discCost('12,5', '10'), 11.25, 'запятая — как точка')
  assert.equal(discPct('12.345'), 12.35)
})

test('строка из карточки: цена поставщика — нынешняя закупочная, цена продажи — нынешняя', () => {
  const l = lineFromProduct(par)
  assert.deepEqual([l.qty, l.base, l.price, l.price0, l.disc, l.div, l.ves], ['1', '120', '150', 150, '', true, false])
  assert.equal(lineFromProduct(par, { disc: 5 }).disc, '5', 'скидка «на все товары» ставится и новой строке')
  assert.equal(lineFromProduct(voda).div, false, 'неделимую упаковку принимают целыми')
  assert.equal(lineFromProduct(sahar).ves, true)
})

test('«2 уп + 5 шт»: штуки сверх упаковок оплачиваются долей упаковки', () => {
  const l = line(par, { qty: '2', pieces: '5', disc: '15' })
  assert.equal(lineUnits(l), 45)
  assert.equal(linePacks(l), 2.25)
  // 2,25 × 120 = 270 до скидки; 2,25 × 102 = 229,50 со скидкой; 2,25 × 150 = 337,50 в рознице
  assert.equal(lineBase(l), 270)
  assert.equal(lineTotal(l), 229.5)
  assert.equal(lineRetail(l), 337.5)
  assert.equal(qtyText(l), '2 уп + 5 шт')
  assert.equal(qtyText({ ...l, qty: '0' }), '5 шт')
  assert.equal(qtyText({ ...l, pieces: '' }), '2 уп')
  // «1 уп + 25 шт» по 20 в пачке — это 2 уп + 5 шт
  assert.equal(qtyText({ ...l, qty: '1', pieces: '25' }), '2 уп + 5 шт')
  assert.equal(packText(l), '20 шт')
  assert.equal(piecePrice(l), 7.5)
  // У неделимой штуки сверх упаковок не считаются
  assert.equal(lineUnits(line(voda, { qty: '3', pieces: '9' })), 3)
  assert.equal(qtyText(line(voda, { qty: '3' })), '3 шт')
})

test('весовой: килограммы с дробью, цена за килограмм', () => {
  const l = line(sahar, { qty: '12,35', base: '8' })
  assert.equal(lineUnits(l), 12350)
  assert.equal(lineTotal(l), 98.8)
  assert.equal(qtyText(l), '12,35 кг')
  assert.equal(packText(l), 'кг')
})

test('итоги панели: сумма, скидка, итого, ожидаемые наценка и выручка', () => {
  const lines = [
    line(par, { qty: '2', pieces: '5', disc: '15' }), // 270 → 229,50, розница 337,50
    line(voda, { qty: '10' }), // 40, розница 60
  ]
  const s = summary(lines)
  assert.equal(s.count, 2)
  assert.equal(s.packs, 12.25)
  assert.equal(s.base, 310)
  assert.equal(s.total, 269.5)
  assert.equal(s.discount, 40.5)
  assert.equal(s.discountPct, 13.06)
  assert.equal(s.retail, 397.5)
  assert.equal(s.markup, 128)
  // Наценка — к закупу со скидкой: 128 / 269,5 = 47,50%
  assert.equal(s.markupPct, 47.5)
  assert.deepEqual(summary([]), { count: 0, packs: 0, base: 0, total: 0, retail: 0, discount: 0, discountPct: 0, markup: 0, markupPct: 0 })
})

test('проверка строки: количество, цена поставщика, скидка', () => {
  assert.equal(lineProblem(line(par)), '')
  assert.equal(lineProblem(line(par, { qty: '0', pieces: '' })), 'укажите количество')
  assert.equal(lineProblem(line(par, { qty: '0', pieces: '3' })), '', 'три штуки без целой упаковки — тоже приход')
  assert.equal(lineProblem(line(sahar, { qty: '0' })), 'укажите вес')
  assert.equal(lineProblem(line(par, { base: '' })), 'укажите цену поставщика')
  assert.equal(lineProblem(line(par, { base: '0' })), '', 'подарок поставщика — закупочная ноль, это можно')
  assert.equal(lineProblem(line(par, { disc: '120' })), 'скидка — от 0 до 100%')
})

test('строка для отправки: цена со скидкой, процент, штуки переложены в упаковки, цена продажи — только изменённая', () => {
  const l = line(par, { qty: '1', pieces: '25', disc: '15', expiryDate: '2028-01-31' })
  assert.deepEqual(toItem(l), { productId: 'par', name: 'Парацетамол', qty: 2, pieces: 5, cost: 102, discount: 15, expiryDate: '2028-01-31' })
  assert.equal(toItem({ ...l, price: '160' }).price, 160)
  assert.equal(toItem({ ...l, price: '150' }).price, undefined, 'цену не меняли — не шлём')
  assert.deepEqual(
    toItem(line(sahar, { qty: '12,35', base: '8' })),
    { productId: 'sahar', name: 'Сахар', qty: 12, pieces: 350, cost: 8, discount: 0, expiryDate: '' },
  )
})

// ── Возврат поставщику ──
const arrivals = [
  // свежие первыми
  { supplierId: 'sup-b', items: [{ productId: 'par', cost: 99 }] },
  { supplierId: 'sup-a', items: [{ productId: 'voda', cost: 3.5 }, { productId: 'par', cost: 102 }] },
  { supplierId: 'sup-a', items: [{ productId: 'par', cost: 110 }] },
]

test('цена возврата — по последнему приходу от этого поставщика, иначе закупочная', () => {
  assert.equal(lastSupplierCost(arrivals, 'sup-a', 'par'), 102, 'берётся самый свежий приход именно этого поставщика')
  assert.equal(lastSupplierCost(arrivals, 'sup-b', 'par'), 99)
  assert.equal(lastSupplierCost(arrivals, 'sup-c', 'par'), null)
  assert.equal(lastSupplierCost(arrivals, '', 'par'), null, 'поставщик не выбран — искать не у кого')
  const fromA = retLineFromProduct({ ...par, stock: 9, looseUnits: 4 }, { arrivals, supplierId: 'sup-a' })
  assert.deepEqual([fromA.price, fromA.fromArrival, fromA.stock], ['102', true, 184])
  const fromCard = retLineFromProduct({ ...par, stock: 9, looseUnits: 4 }, { arrivals, supplierId: 'sup-c' })
  assert.deepEqual([fromCard.price, fromCard.fromArrival], ['120', false])
})

test('возврат: «2 уп + 5 шт» × цена, больше остатка — нельзя, просроченное — можно', () => {
  const l = { ...retLineFromProduct({ ...par, stock: 3, looseUnits: 0 }, { arrivals, supplierId: 'sup-a' }), qty: '2', pieces: '5' }
  assert.equal(retLineSum(l), 229.5)
  assert.equal(retProblem(l), '')
  assert.equal(retProblem({ ...l, qty: '3', pieces: '1' }), 'на складе меньше', '3 уп = 60 шт на складе, 61 не вернуть')
  assert.equal(retProblem({ ...l, qty: '3', pieces: '' }), '', 'весь остаток вернуть можно')
  assert.equal(retProblem({ ...l, qty: '0', pieces: '' }), 'укажите количество')
  assert.equal(retProblem({ ...l, price: '' }), 'укажите цену возврата')
  assert.equal(retProblem({ ...l, price: '0' }), '', 'поставщик может и не засчитать денег — это его решение')
  assert.deepEqual(toRetItem({ ...l, qty: '1', pieces: '25' }), { productId: 'par', name: 'Парацетамол', qty: 2, pieces: 5, price: 102 })
  const kg = { ...retLineFromProduct({ ...sahar, stock: 20, looseUnits: 0 }), qty: '1,5', price: '8' }
  assert.equal(retLineSum(kg), 12)
  assert.equal(retProblem({ ...kg, qty: '0' }), 'укажите вес')
  assert.deepEqual(toRetItem(kg), { productId: 'sahar', name: 'Сахар', qty: 1, pieces: 500, price: 8 })
  assert.deepEqual(retSummary([l, kg]), { count: 2, packs: 3.75, total: 241.5 })
})
