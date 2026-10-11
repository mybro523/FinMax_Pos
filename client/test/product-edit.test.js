// Правка карточки товара: остаток уходит на сервер, только если его правили.
// Иначе число из открытой формы легло бы поверх настоящего остатка — и товар,
// проданный, пока форма была открыта, «вернулся» бы на полку.
import test from 'node:test'
import assert from 'node:assert/strict'
import { editPatch, stockAtOpen } from '../src/lib/productEdit.js'

const product = { id: 'p1', name: 'Нурофен', price: 150, cost: 100, stock: 10, looseUnits: 0, unitsPerPack: 1 }
// Форма держит числа текстом — как поля ввода
const form = (over = {}) => ({ ...product, price: '150', cost: '100', stock: '10', looseUnits: '0', unitsPerPack: '1', ...over })
const data = (f) => ({ name: f.name, price: Number(f.price), cost: Number(f.cost), stock: Number(f.stock), looseUnits: Number(f.looseUnits), unitsPerPack: Number(f.unitsPerPack) })

test('правили только цену — остаток на сервер не уходит', () => {
  const was = stockAtOpen(product)
  const f = form({ price: '175' })
  const patch = editPatch(f, data(f), was)
  assert.equal(patch.price, 175)
  assert.equal('stock' in patch, false, 'остаток из формы лёг бы поверх настоящего')
  assert.equal('looseUnits' in patch, false)
  assert.equal(patch.unitsPerPack, 1, 'остальные поля — как были')
})

test('остаток поправили — он уходит вместе со штуками во вскрытой упаковке', () => {
  const was = stockAtOpen(product)
  const f = form({ stock: '8' })
  assert.deepEqual(editPatch(f, data(f), was), { ...data(f) })
  const g = form({ looseUnits: '3' })
  const patch = editPatch(g, data(g), was)
  assert.deepEqual([patch.stock, patch.looseUnits], [10, 3])
})

test('поправили и вернули как было — это не правка', () => {
  const was = stockAtOpen(product)
  const f = form({ stock: '10' })
  assert.equal('stock' in editPatch(f, data(f), was), false)
})

test('у старых товаров штук во вскрытой упаковке может не быть вовсе — это ноль', () => {
  const old = { ...product, looseUnits: undefined }
  const was = stockAtOpen(old)
  assert.deepEqual(was, { stock: '10', looseUnits: '0' })
  const f = form()
  assert.equal('stock' in editPatch(f, data(f), was), false)
})

test('новый товар (остатка «при открытии» нет) уходит целиком', () => {
  const f = form({ stock: '5' })
  assert.deepEqual(editPatch(f, data(f), undefined), data(f))
})
