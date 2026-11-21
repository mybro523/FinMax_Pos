// ── Состав товара (сырьё), версия 1.8.5 ──
//
// Составной товар (торт) собирается из сырья. При продаже списываются ингредиенты, а не
// остаток самого товара: своего остатка у него нет. Себестоимость чека — из ингредиентов.
// Проверяем весь путь на настоящей локальной базе кассы: продажа без связи, заведение и
// правка состава, галочка «не для продажи».
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkout } from '../src/local/ops/sale.mjs'
import { createProduct, updateProduct } from '../src/local/ops/products.mjs'
import { productsList, recipeOf } from '../src/local/catalog.mjs'
import { ctx, NOW, pharmacy, product, rows } from '../test-support/pharmacy.mjs'

// Торт из 200 г муки, 10 яиц и 1 л молока. Мука и молоко — дробные (в базе — граммы/мл),
// яйца — штуки. У торта своего остатка нет, forSale — для продажи
function tortShop() {
  const muka = product({ id: 'muka', name: 'Мука', unit: 'кг', unitsPerPack: 1000, cost: 5, price: 7, stock: 10, looseUnits: 0 }) // 10 кг
  const yaico = product({ id: 'yaico', name: 'Яйцо', unit: 'шт', unitsPerPack: 1, cost: 2, price: 3, stock: 100 }) // 100 шт
  const moloko = product({ id: 'moloko', name: 'Молоко', unit: 'л', unitsPerPack: 1000, cost: 8, price: 11, stock: 5, looseUnits: 0 }) // 5 л
  const tort = product({
    id: 'tort', name: 'Торт', unit: 'шт', unitsPerPack: 1, cost: 0, price: 300, stock: 0, looseUnits: 0, expiryDate: null,
    recipe: [{ ingredientId: 'muka', units: 200 }, { ingredientId: 'yaico', units: 10 }, { ingredientId: 'moloko', units: 1000 }],
  })
  const db = pharmacy({ products: [muka, yaico, moloko, tort] })
  return { db }
}

const stockOf = (db, id) => {
  const p = productsList(db, NOW).find((x) => x.id === id)
  return [p.stock, p.looseUnits]
}

test('продажа составного товара списывает сырьё, а не сам товар', () => {
  const { db } = tortShop()
  // Состав приехал с сервера и виден кассе
  assert.deepEqual(recipeOf(db, 'tort'), [
    { ingredientId: 'muka', units: 200 },
    { ingredientId: 'yaico', units: 10 },
    { ingredientId: 'moloko', units: 1000 },
  ])

  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'tort', qty: 2 }] })

  // Продали 2 торта по 300 — выручка 600. Себестоимость одного торта: мука 200 г × (5/1000) = 1,
  // яйца 10 × 2 = 20, молоко 1000 мл × (8/1000) = 8 → 29. На два торта — 58, прибыль 542
  assert.equal(sale.total, 600)
  assert.equal(sale.cost, 58)
  assert.equal(sale.profit, 542)
  assert.equal(sale.items.length, 1)
  assert.equal(sale.items[0].cost, 29)

  // Списались ингредиенты: мука 10 кг − 400 г = 9,6 кг; яйца 100 − 20 = 80; молоко 5 л − 2 л = 3 л
  assert.deepEqual(stockOf(db, 'muka'), [9, 600])
  assert.deepEqual(stockOf(db, 'yaico'), [80, 0])
  assert.deepEqual(stockOf(db, 'moloko'), [3, 0])
  // А у самого торта остаток не трогали — его и не было
  assert.deepEqual(stockOf(db, 'tort'), [0, 0])
})

test('не хватает сырья — продажа составного товара не проходит целиком', () => {
  const { db } = tortShop()
  // Яиц всего 100: на 11 тортов нужно 110 — отказ, и ничего не списалось
  assert.throws(() => checkout(ctx(db), { payment: 'cash', items: [{ productId: 'tort', qty: 11 }] }), /Недостаточно|годных/)
  assert.deepEqual(stockOf(db, 'yaico'), [100, 0])
  assert.deepEqual(stockOf(db, 'muka'), [10, 0])
})

test('состав заводится на кассе без связи: локально и в операции для сервера', () => {
  const muka = product({ id: 'muka', name: 'Мука', unit: 'кг', unitsPerPack: 1000, cost: 5, price: 7, stock: 10 })
  const db = pharmacy({ products: [muka] })
  const p = createProduct(ctx(db), {
    name: 'Лепёшка', barcode: '4600000009001', price: 4, cost: 0, unit: 'шт',
    recipe: [{ ingredientId: 'muka', units: 300 }], forSale: true,
  })
  // Состав лёг в локальную базу
  assert.deepEqual(recipeOf(db, p.id), [{ ingredientId: 'muka', units: 300 }])
  // И ушёл в очередь на сервер вместе с forSale
  const op = rows(db, "SELECT payload FROM outbox WHERE type = 'product.create' ORDER BY seq DESC LIMIT 1").map((r) => JSON.parse(r.payload))[0]
  assert.deepEqual(op.product.recipe, [{ ingredientId: 'muka', units: 300 }])
  assert.equal(op.product.forSale, true)
})

test('правка состава и галочки «не для продажи» — локально и в операции', () => {
  const muka = product({ id: 'muka', name: 'Мука', unit: 'кг', unitsPerPack: 1000, cost: 5, stock: 10 })
  const pesok = product({ id: 'pesok', name: 'Песок', unit: 'кг', unitsPerPack: 1000, cost: 1, stock: 100 })
  const db = pharmacy({ products: [muka, pesok, product({ id: 'kirpich', name: 'Кирпич', unit: 'шт', price: 2, cost: 0, stock: 0 })] })

  // Задаём состав кирпича и прячем песок из кассы
  updateProduct(ctx(db), 'kirpich', { recipe: [{ ingredientId: 'pesok', units: 2000 }] })
  updateProduct(ctx(db), 'pesok', { forSale: false })

  assert.deepEqual(recipeOf(db, 'kirpich'), [{ ingredientId: 'pesok', units: 2000 }])
  assert.equal(productsList(db, NOW).find((x) => x.id === 'pesok').forSale, false)

  // Правка состава ушла отдельной операцией с recipe в корне, forSale — полем карточки (set)
  const ops = rows(db, "SELECT payload FROM outbox WHERE type = 'product.update' ORDER BY seq").map((r) => JSON.parse(r.payload))
  const recipeOp = ops.find((o) => o.id === 'kirpich')
  assert.deepEqual(recipeOp.recipe, [{ ingredientId: 'pesok', units: 2000 }])
  const forSaleOp = ops.find((o) => o.id === 'pesok')
  assert.equal(forSaleOp.set.forSale, false)
})
