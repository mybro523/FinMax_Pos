// ── Склад (1.8.0): сводка партий склада по товарам ──
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skladPoTovaram, skladItogo, skladUnitsOf, skladValueOf } from '../src/lib/sklad.js'

const P = [
  { id: 'a', name: 'Аспирин', price: 20, cost: 10, unitsPerPack: 10, unit: 'уп' },
  { id: 'b', name: 'Бинт', price: 5, cost: 3, unitsPerPack: 1, unit: 'шт' },
  { id: 'c', name: 'Цемент', price: 100, cost: 80, unitsPerPack: 50000, unit: 'кг', piecePrice: 2.5 },
]

test('по товарам: штуки, закупка по ценам партий, продажа по цене товара, ближайший срок', () => {
  const rows = skladPoTovaram(
    [
      { productId: 'a', units: 25, cost: 12, expiryDate: '2027-05-01T00:00:00Z' },
      { productId: 'a', units: 10, cost: 8, expiryDate: '2026-12-01T00:00:00Z' },
      { productId: 'b', units: 4, cost: 3 },
      { productId: 'x', units: 9, cost: 1 }, // товара нет — строки нет
      { productId: 'b', units: 0, cost: 3 }, // пустая партия не считается
    ],
    P,
  )
  assert.equal(rows.length, 2)
  const a = rows.find((r) => r.productId === 'a')
  assert.equal(a.units, 35)
  assert.equal(a.cost, 25 * 12 / 10 + 10 * 8 / 10) // 30 + 8 = 38
  assert.equal(a.value, 70) // 3 уп × 20 + 5 шт × 2
  assert.equal(a.expiry, '2026-12-01T00:00:00Z')
  const b = rows.find((r) => r.productId === 'b')
  assert.equal(b.value, 20)
  assert.equal(b.expiry, null)
  assert.deepEqual(skladItogo(rows), { tovarov: 2, units: 39, cost: 50, value: 90 })
})

test('весовой мешок: вскрытый — по своей цене килограмма', () => {
  // 1 мешок (50 кг) + 2 кг = 52 000 г: 100 + 2 × 2,5
  assert.equal(skladValueOf(P[2], 52000), 105)
  const [c] = skladPoTovaram([{ productId: 'c', units: 52000, cost: 80 }], P)
  assert.equal(c.cost, 83.2)
})

test('штук товара на складе', () => {
  const bb = [{ productId: 'a', units: 3 }, { productId: 'a', units: 4 }, { productId: 'b', units: 9 }]
  assert.equal(skladUnitsOf(bb, 'a'), 7)
  assert.equal(skladUnitsOf(bb, 'z'), 0)
})
