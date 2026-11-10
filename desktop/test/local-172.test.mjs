// ── 1.7.2: лист «Выбранные товары» и поставщик товара — без интернета ──
//
// Лист пересчёта из товаров, отобранных сканером, заводится на кассе так же, как у сервера
// (inventory.service, productIds): строки — в порядке сканирования, повтор — одной строкой,
// охват — «Выбранные товары». Поставщик каждого товара для авто-заявки — по последнему
// приходу, где он указан (как products.service, lastSuppliers): без связи — по журналам кассы.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchFallback, matchLocal } from '../src/local/api.mjs'
import { lastSuppliers } from '../src/local/history.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { createInventory, NO_PICKED_PRODUCTS, PICKED_SCOPE } from '../src/local/ops/inventory.mjs'
import { pendingOps } from '../src/local/outbox.mjs'
import { ctx, DAY, NOW, pharmacy, product, refused } from '../test-support/pharmacy.mjs'

const shop = () =>
  pharmacy({
    products: [
      product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10, category: 'Таблетки' }),
      product({ id: 'bint', name: 'Бинт', barcode: '4600000000024', cost: 50, price: 80, stock: 4, unitsPerPack: 10, looseUnits: 5, category: 'Перевязка', expiryDate: null }),
      product({ id: 'vata', name: 'Вата', barcode: '4600000000031', cost: 20, price: 30, stock: 2, category: 'Перевязка' }),
    ],
  })

test('лист из отобранных сканером: порядок сканов, повтор — одна строка, охват «Выбранные товары»', () => {
  const db = shop()
  const sheet = createInventory(ctx(db), { scope: PICKED_SCOPE, productIds: ['vata', 'nur', 'vata', 'нет-такого'] })
  assert.equal(sheet.scope, PICKED_SCOPE)
  assert.deepEqual(sheet.items.map((i) => [i.productId, i.expectedUnits]), [['vata', 2], ['nur', 10]])
  const op = pendingOps(db, 10).find((o) => o.type === 'inventory.create')
  assert.equal(op.payload.inventory.scope, PICKED_SCOPE)
  assert.deepEqual(op.payload.inventory.items.map((i) => i.productId), ['vata', 'nur'])
})

test('отобранных товаров нет в базе или список пуст — отказ, а не лист на весь склад', () => {
  const db = shop()
  refused(() => createInventory(ctx(db), { productIds: ['нет-такого'] }), 400, NO_PICKED_PRODUCTS)
  refused(() => createInventory(ctx(db), { productIds: [] }), 400, 'Товары: нужна хотя бы 1 позиция')
  refused(() => createInventory(ctx(db), { productIds: [1] }), 400, 'Товары: только текст')
  // Без productIds — как раньше: категория
  assert.deepEqual(createInventory(ctx(db), { scope: 'Перевязка' }).items.map((i) => i.productId).sort(), ['bint', 'vata'])
})

test('поставщик товара — по последнему приходу, где он указан; имя — из справочника', () => {
  const db = shop()
  createArrival(ctx(db, { now: NOW - 3 * DAY }), { supplierId: 'sup-1', items: [{ productId: 'nur', qty: 1, cost: 100 }, { productId: 'bint', qty: 1, cost: 50 }] })
  createArrival(ctx(db, { now: NOW - 2 * DAY }), { supplierId: 'sup-2', items: [{ productId: 'nur', qty: 1, cost: 100 }] })
  // Приход без поставщика поставщика не меняет
  createArrival(ctx(db, { now: NOW - DAY }), { items: [{ productId: 'nur', qty: 1, cost: 100 }, { productId: 'vata', qty: 1, cost: 20 }] })
  const by = new Map(lastSuppliers(db).map((r) => [r.productId, r]))
  assert.deepEqual([by.get('nur').supplierId, by.get('nur').supplier], ['sup-2', 'Авиценна-трейд'])
  assert.deepEqual([by.get('bint').supplierId, by.get('bint').supplier], ['sup-1', 'Опт-Маркет'])
  assert.equal(by.has('vata'), false)
})

test('адрес: сначала сервер (у него приходы за всё время), без связи — касса; только с правом на авто-заявку', () => {
  assert.equal(matchLocal('GET', '/products/suppliers'), null)
  const found = matchFallback('GET', '/products/suppliers')
  assert.ok(found)
  const db = shop()
  assert.deepEqual(found.handler(ctx(db)), [])
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassir2', role: 'cashier', permissions: [] }
  refused(() => found.handler(ctx(db, { user: cashier })), 403, 'Недостаточно прав')
})
