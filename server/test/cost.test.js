// Тесты средневзвешенной закупочной цены. Запуск: npm test (в папке server).
// Проверяем собранный код из dist — ровно то, что уходит на сервер.
const test = require('node:test')
const assert = require('node:assert/strict')
const { weightedPackCost } = require('../dist/common/cost')

const num = (d) => Number(d.toFixed(4))

test('обычный товар: цена становится средней между складом и поставкой', () => {
  // 10 упаковок по 100 + 10 упаковок по 200 → 150 за упаковку
  const r = weightedPackCost({ stock: 10, unitsPerPack: 1, cost: 100, addPacks: 10, addValue: 2000 })
  assert.equal(num(r), 150)
})

test('пустой склад: цена равна цене поставки', () => {
  const r = weightedPackCost({ stock: 0, looseUnits: 0, unitsPerPack: 1, cost: 999, addPacks: 5, addValue: 1000 })
  assert.equal(num(r), 200)
})

test('делимый товар без вскрытой упаковки считается как раньше', () => {
  // 2 упаковки по 50 + 3 упаковки по 100 → (100 + 300) / 5 = 80
  const r = weightedPackCost({ stock: 2, looseUnits: 0, unitsPerPack: 10, cost: 50, addPacks: 3, addValue: 300 })
  assert.equal(num(r), 80)
})

test('вскрытая упаковка участвует в расчёте (тот самый баг)', () => {
  // В упаковке 20 штук. Целых пачек нет, но лежит 15 штук по 100 за пачку.
  // Приходит 1 пачка за 200. Старый остаток — это 0,75 пачки, он обязан весить.
  const r = weightedPackCost({ stock: 0, looseUnits: 15, unitsPerPack: 20, cost: 100, addPacks: 1, addValue: 200 })
  // (75 + 200) / 35 штук × 20 штук в упаковке ≈ 157.14
  assert.equal(num(r), 157.1429)
  // Прежний расчёт по упаковкам дал бы ровно цену поставки — этого быть не должно
  assert.notEqual(num(r), 200)
})

test('вскрытая упаковка не переоценивается: почти полная пачка тянет цену к старой', () => {
  const r = weightedPackCost({ stock: 0, looseUnits: 19, unitsPerPack: 20, cost: 100, addPacks: 1, addValue: 200 })
  // (95 + 200) / 39 × 20 ≈ 151.28 — ближе к старой цене, чем в примере с 15 штуками
  assert.equal(num(r), 151.2821)
})

test('ни остатка, ни прихода — цена не меняется', () => {
  const r = weightedPackCost({ stock: 0, looseUnits: 0, unitsPerPack: 10, cost: 42, addPacks: 0, addValue: 0 })
  assert.equal(num(r), 42)
})

test('копейки не теряются на длинных дробях', () => {
  // 3 упаковки по 33.33 + 1 по 100 → (99.99 + 100) / 4 = 49.9975
  const r = weightedPackCost({ stock: 3, looseUnits: 0, unitsPerPack: 1, cost: 33.33, addPacks: 1, addValue: 100 })
  assert.equal(num(r), 49.9975)
})

// ── Цена заново, по оставшимся партиям ──
// Нужна, когда приход правят или удаляют. Средневзвешенную формулу обратить
// нельзя — из «сейчас 15» не восстановить, сколько было до поставки. Зато каждая
// партия помнит свою цену, и по ним считается точное число, а не приблизительное.
const { costFromBatches } = require('../dist/common/cost')

test('удалили дорогую поставку — цена вернулась к прежней, а не осталась средней', () => {
  // Было 10 по 100, привезли 10 по 200 — средняя стала 150.
  // Убрали вторую поставку: на полке снова только партия по 100
  const r = costFromBatches([{ units: 10, cost: 100 }], 1, 150)
  assert.equal(Number(r), 100)
})

test('две партии по разной цене дают средневзвешенную по количеству', () => {
  // 30 штук по 10 и 10 штук по 20 → (300 + 200) / 40 = 12,5
  const r = costFromBatches([{ units: 30, cost: 10 }, { units: 10, cost: 20 }], 1, 0)
  assert.equal(Number(r), 12.5)
})

test('делимый товар: считаем по штукам, а не по упаковкам', () => {
  // В упаковке 20. Партия А — 15 штук по 100 за упаковку, партия Б — 20 штук по 200.
  // По упаковкам вышло бы почти 200, по штукам (0,75×100 + 1×200) / 1,75 ≈ 157,14
  const r = costFromBatches([{ units: 15, cost: 100 }, { units: 20, cost: 200 }], 20, 0)
  assert.ok(Math.abs(Number(r) - 157.14) < 0.01, `получили ${Number(r)}`)
})

test('пустая полка не обнуляет цену — остаётся последняя известная', () => {
  // Иначе следующий приход усреднялся бы с нулём, а отчёты показали бы
  // нулевую себестоимость склада
  assert.equal(Number(costFromBatches([], 1, 77)), 77)
  assert.equal(Number(costFromBatches([{ units: 0, cost: 100 }], 1, 77)), 77)
})

test('весовой товар: дробные «упаковки»-килограммы считаются точно', () => {
  // Сахар: 5 кг по 10 с/кг на складе и 350 г во «вскрытом» килограмме.
  // Привезли 12,350 кг на 98,80 сомони (по 8 с/кг).
  // Старое: 5350 г по 0,01 с/г = 53,50; всего (53,50 + 98,80) / 17 700 г × 1000 = 8,6045…
  const r = weightedPackCost({ stock: 5, looseUnits: 350, unitsPerPack: 1000, cost: 10, addPacks: 12.35, addValue: 98.8 })
  assert.equal(num(r), 8.6045)
})
