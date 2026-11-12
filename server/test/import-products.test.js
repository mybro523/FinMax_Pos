// Товары из Excel: проверка списка на сервере (12.11.2026). Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanImport, MAX_IMPORT } = require('../dist/admin/import-products')

test('годные строки проходят, поля выравниваются', () => {
  const { rows, dropped } = cleanImport([
    { barcode: ' 4870204010060 ', name: '  Кока  Кола 0,5л ', price: '12,5', cost: 9, stock: 3.7, category: ' Напитки ', unit: 'шт' },
    { barcode: '30056640', name: 'Rexona' },
  ])
  assert.equal(dropped, 0)
  assert.deepEqual(rows[0], { barcode: '4870204010060', name: 'Кока Кола 0,5л', price: 12.5, cost: 9, stock: 3, category: 'Напитки', unit: 'шт', own: false })
  assert.deepEqual(rows[1], { barcode: '30056640', name: 'Rexona', price: 0, cost: 0, stock: 0, category: 'Прочее', unit: 'уп', own: false })
})

test('без названия, без штрихкода и повтор — отбрасываются, первая строка остаётся', () => {
  const { rows, dropped } = cleanImport([
    { barcode: '111', name: 'Первый' },
    { barcode: '111', name: 'Повтор' },
    { barcode: '', name: 'Без кода' },
    { barcode: '222', name: '   ' },
    null,
    'мусор',
  ])
  assert.deepEqual(rows.map((r) => r.name), ['Первый'])
  assert.equal(dropped, 5)
})

test('отрицательные и негодные числа — ноль, длинное — обрезается', () => {
  const { rows } = cleanImport([{ barcode: 'x'.repeat(100), name: 'Я'.repeat(300), price: -5, cost: 'abc', stock: -2, category: 'К'.repeat(80) }])
  assert.equal(rows[0].barcode.length, 64)
  assert.equal(rows[0].name.length, 200)
  assert.equal(rows[0].category.length, 60)
  assert.equal(rows[0].price, 0)
  assert.equal(rows[0].cost, 0)
  assert.equal(rows[0].stock, 0)
})

test('не список и слишком длинный список', () => {
  assert.deepEqual(cleanImport(undefined), { rows: [], dropped: 0 })
  const many = Array.from({ length: MAX_IMPORT + 10 }, (_, i) => ({ barcode: String(i), name: 'т' + i }))
  assert.equal(cleanImport(many).rows.length, MAX_IMPORT)
})

test('товар без штрихкода в файле (own) помечается — сервер сверит его по названию', () => {
  const { rows } = cleanImport([{ barcode: '2000000000015', name: 'Без кода', own: true }, { barcode: '1', name: 'С кодом', own: 'да' }])
  assert.equal(rows[0].own, true)
  assert.equal(rows[1].own, false)
})
