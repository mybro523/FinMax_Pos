// ── Тип товара, список типов и новая цена из прихода — без связи ──
//
// Касса работает и без интернета, поэтому то, что окно показывает в карточке товара
// и в приходе, обязано жить в местной базе. Здесь проверяется главное: тип товара и
// список типов доходят из обмена и отдаются окну, а цена продажи, назначенная
// наценкой в приходе, сразу ставится в карточку и не теряется по дороге к серверу.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { productsList, productTypesList } from '../src/local/catalog.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { matchLocal } from '../src/local/api.mjs'
import { pendingOps } from '../src/local/outbox.mjs'
import { ctx, NOW, pharmacy, product } from '../test-support/pharmacy.mjs'

const up = (...list) => ({ upsert: list, remove: [] })
const TYPES = [
  { id: 'pt_med', name: 'Медицинский', analogs: true, createdAt: '2026-10-01T08:00:00.000Z' },
  { id: 'pt_prod', name: 'Продукты', analogs: false, createdAt: '2026-10-01T08:00:00.000Z' },
]

test('тип товара и список типов приходят обменом и отдаются окну', () => {
  const db = pharmacy({ products: [product({ id: 'par', name: 'Парацетамол', type: 'Медицинский' })], productTypes: TYPES })
  assert.equal(productsList(db, NOW).find((p) => p.id === 'par').type, 'Медицинский')
  assert.deepEqual(productTypesList(db).map((x) => [x.name, x.analogs]), [['Медицинский', true], ['Продукты', false]])

  // Изменение списка — частью обмена: переименовали тип, убрали другой
  applyPull(db, { full: false, cursor: '200', data: { productTypes: { upsert: [{ ...TYPES[0], name: 'Лечебный' }], remove: ['pt_prod'] } } }, { now: NOW })
  assert.deepEqual(productTypesList(db).map((x) => x.name), ['Лечебный'])

  // Окно спрашивает список у местной базы — и без связи тоже
  const route = matchLocal('GET', '/product-types')
  assert.ok(route, 'адрес /product-types должен обслуживаться местной базой')
})

test('товар без типа — пустая строка, а не «undefined»', () => {
  const db = pharmacy({ products: [product({ id: 'x', name: 'Хлеб' })] })
  assert.equal(productsList(db, NOW)[0].type, '')
})

test('приход с новой ценой: цена сразу в карточке и уходит серверу вместе с приходом', () => {
  const db = pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
  createArrival(ctx(db), { items: [{ productId: 'nur', qty: 2, cost: 120, price: 162.5 }] })
  assert.equal(productsList(db, NOW).find((p) => p.id === 'nur').price, 162.5, 'касса продаёт по новой цене, не дожидаясь связи')
  const op = pendingOps(db, 100).find((o) => o.type === 'arrival')
  assert.equal(op.payload.arrival.items[0].price, 162.5, 'цена не должна теряться по дороге к серверу')
})

test('приход без новой цены цену товара не трогает и серверу её не шлёт', () => {
  const db = pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
  createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 110 }] })
  assert.equal(productsList(db, NOW).find((p) => p.id === 'nur').price, 150)
  const op = pendingOps(db, 100).find((o) => o.type === 'arrival')
  assert.ok(!('price' in op.payload.arrival.items[0]))
})

test('цена в приходе: число и не меньше нуля', () => {
  const db = pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
  assert.throws(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 110, price: 'дорого' }] }))
  assert.throws(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 110, price: -5 }] }))
})

// Защита от пропуска: обмен приносит типы, только если их ждут
test('пустой обмен список типов не стирает', () => {
  const db = pharmacy({ productTypes: TYPES })
  applyPull(db, { full: false, cursor: '300', data: { products: up() } }, { now: NOW })
  assert.equal(productTypesList(db).length, 2)
})
