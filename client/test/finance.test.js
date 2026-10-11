// Тесты денежных итогов за период. Запуск: npm test (в папке client).
import test from 'node:test'
import assert from 'node:assert/strict'
import { periodFinance, restockedCost, returnedCost, shiftTotals, expensesByCategory } from '../src/lib/finance.js'

const DAY = '2026-08-16T10:00:00.000Z'
const EARLIER = '2026-08-01T10:00:00.000Z'
const from = new Date('2026-08-16T00:00:00.000Z')

const sale = (over = {}) => ({ date: DAY, total: 100, cost: 60, profit: 40, payment: 'cash', items: [], ...over })

test('без возвратов и списаний выручка и прибыль равны продажам', () => {
  const f = periodFinance({ sales: [sale(), sale()], from })
  assert.equal(f.revenue, 200)
  assert.equal(f.profit, 80)
  assert.equal(f.count, 2)
  assert.equal(f.hasLosses, false)
})

test('возврат уменьшает выручку на возвращённые деньги', () => {
  const returns = [{ date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: true }] }]
  const f = periodFinance({ sales: [sale()], returns, from })
  assert.equal(f.revenueGross, 100)
  assert.equal(f.revenue, 70)
  assert.equal(f.refunds, 30)
  assert.equal(f.refundCount, 1)
})

test('товар, вернувшийся на полку, прибыль не съедает целиком', () => {
  // Вернули 30 денег, но товар себестоимостью 20 снова в продаже: минус 10, а не 30
  const returns = [{ date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: true }] }]
  const f = periodFinance({ sales: [sale()], returns, from })
  assert.equal(f.profitGross, 40)
  assert.equal(f.profit, 30)
})

test('возврат со списанием: себестоимость вычитается ОДИН раз', () => {
  // Продали на 100 при себестоимости 60 → прибыль 40. Вернули 30, товар забраковали
  // (его закупочная цена 20) и оформили списанием.
  // По факту: денег осталось 100 − 30 = 70, товара ушло на 60 → прибыль 10.
  // Раньше закупочная цена брака вычиталась дважды — и в продаже, и в списании —
  // и отчёт показывал −10 вместо 10.
  const returns = [{ date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: false }] }]
  const writeOffs = [{ date: DAY, totalCost: 20 }]
  const f = periodFinance({ sales: [sale()], returns, writeOffs, from })
  assert.equal(f.profit, 10)
  assert.equal(f.writeOffCost, 20, 'в журнале потерь брак виден целиком')
})

test('вернули всю покупку и забраковали — потеряна ровно закупочная цена', () => {
  // Продали на 100 (закупка 60), покупатель вернул всё, товар списан.
  // Денег ноль, товара нет → минус 60, а не минус 120.
  const returns = [{ date: DAY, total: 100, items: [{ cost: 60, unitsPerPack: 1, units: 1, restock: false }] }]
  const writeOffs = [{ date: DAY, totalCost: 60 }]
  const f = periodFinance({ sales: [sale()], returns, writeOffs, from })
  assert.equal(f.revenue, 0)
  assert.equal(f.profit, -60)
})

test('отчёт за период и Z-отчёт смены сходятся по одному возврату', () => {
  // Один и тот же возврат со списанием не должен давать две разные прибыли
  const ret = { date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: false }] }
  const f = periodFinance({ sales: [sale()], returns: [ret], writeOffs: [{ date: DAY, totalCost: 20 }], from })
  const z = shiftTotals({ totalSales: 100, profit: 40, refundTotal: 30, refundCost: restockedCost(ret) })
  assert.equal(f.profit, z.netProfit)
})

test('часть возврата на полку, часть в брак', () => {
  // Вернули две позиции по 20 закупочной: одна снова в продаже, вторая списана.
  // Денег отдали 70. Прибыль: 40 − 70 + (20 + 20) − 20 = −10
  const returns = [{
    date: DAY,
    total: 70,
    items: [
      { cost: 20, unitsPerPack: 1, units: 1, restock: true },
      { cost: 20, unitsPerPack: 1, units: 1, restock: false },
    ],
  }]
  const f = periodFinance({ sales: [sale()], returns, writeOffs: [{ date: DAY, totalCost: 20 }], from })
  assert.equal(restockedCost(returns[0]), 20, 'на полку вернулась одна позиция')
  assert.equal(returnedCost(returns[0]), 40, 'а всего товара вернулось на 40')
  assert.equal(f.profit, -10)
})

test('делимый товар в браке: считаем штуками, а не упаковками', () => {
  // В упаковке 20 таблеток по 100 за упаковку, вернули и забраковали 5 таблеток → 25
  const ret = { date: DAY, total: 40, items: [{ cost: 100, unitsPerPack: 20, units: 5, restock: false }] }
  assert.equal(returnedCost(ret), 25)
  assert.equal(restockedCost(ret), 0)
})

test('списание уменьшает прибыль, но не выручку', () => {
  const f = periodFinance({ sales: [sale()], writeOffs: [{ date: DAY, totalCost: 15 }], from })
  assert.equal(f.revenue, 100)
  assert.equal(f.profit, 25)
  assert.equal(f.hasLosses, true)
})

test('делимый товар: считается себестоимость штуки, а не упаковки', () => {
  // В упаковке 20 таблеток по 100 за упаковку, вернули 5 таблеток → 25 себестоимости
  const ret = { date: DAY, total: 40, items: [{ cost: 100, unitsPerPack: 20, units: 5, restock: true }] }
  assert.equal(restockedCost(ret), 25)
  const f = periodFinance({ sales: [sale()], returns: [ret], from })
  assert.equal(f.profit, 40 - 40 + 25)
})

test('чужой период не попадает в итоги', () => {
  const f = periodFinance({
    sales: [sale(), sale({ date: EARLIER })],
    returns: [{ date: EARLIER, total: 50, items: [] }],
    writeOffs: [{ date: EARLIER, totalCost: 50 }],
    from,
  })
  assert.equal(f.count, 1)
  assert.equal(f.refunds, 0)
  assert.equal(f.writeOffCost, 0)
  assert.equal(f.revenue, 100)
})

test('верхняя граница периода не включает саму дату', () => {
  const f = periodFinance({
    sales: [sale({ date: '2026-08-16T23:59:59.000Z' })],
    from,
    to: new Date('2026-08-16T23:00:00.000Z'),
  })
  assert.equal(f.count, 0)
})

test('маржа считается от чистой выручки', () => {
  const returns = [{ date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: true }] }]
  const f = periodFinance({ sales: [sale()], returns, from })
  // прибыль 30 при выручке 70
  assert.equal(f.margin, 43)
})

// ── Расходы аптеки и чистая прибыль ──

test('без расходов чистая прибыль равна прибыли', () => {
  const f = periodFinance({ sales: [sale(), sale()], from })
  assert.equal(f.expenses, 0)
  assert.equal(f.expenseCount, 0)
  assert.equal(f.netProfit, f.profit)
  assert.deepEqual(f.expensesByCategory, [])
})

test('чистая прибыль — прибыль минус расходы аптеки; выручку и прибыль расходы не трогают', () => {
  const expenses = [
    { date: DAY, category: 'Аренда', amount: 25 },
    { date: DAY, category: 'Зарплата', amount: 10.5 },
  ]
  const f = periodFinance({ sales: [sale(), sale()], expenses, from })
  assert.equal(f.revenue, 200)
  assert.equal(f.profit, 80, 'прибыль на товаре — прежняя')
  assert.equal(f.expenses, 35.5)
  assert.equal(f.expenseCount, 2)
  assert.equal(f.netProfit, 44.5)
  assert.equal(f.margin, 40, 'маржа считается по прибыли на товаре, расходы её не меняют')
})

test('расходы больше прибыли — чистая прибыль уходит в минус, а не обрезается до нуля', () => {
  const f = periodFinance({ sales: [sale()], expenses: [{ date: DAY, category: 'Аренда', amount: 500 }], from })
  assert.equal(f.netProfit, -460)
})

test('расход из кассы считается в расходах наравне с остальными — один раз', () => {
  // Отметка «из кассы» говорит только, откуда взяты деньги. В чистой прибыли такой
  // расход — тот же расход
  const expenses = [
    { date: DAY, category: 'Транспорт', amount: 30, fromCash: true, shiftId: 's1' },
    { date: DAY, category: 'Транспорт', amount: 20 },
  ]
  const f = periodFinance({ sales: [sale()], expenses, from })
  assert.equal(f.expenses, 50)
  assert.equal(f.netProfit, -10)
})

test('расход вне периода в итоги не попадает; все потери вычитаются вместе', () => {
  const returns = [{ date: DAY, total: 30, items: [{ cost: 20, unitsPerPack: 1, units: 1, restock: true }] }]
  const f = periodFinance({
    sales: [sale()],
    returns,
    writeOffs: [{ date: DAY, totalCost: 5 }],
    expenses: [{ date: DAY, category: 'Налоги', amount: 7 }, { date: EARLIER, category: 'Аренда', amount: 1000 }],
    from,
  })
  // 40 − 30 + 20 − 5 = 25 прибыли, минус 7 расходов
  assert.equal(f.profit, 25)
  assert.equal(f.expenses, 7)
  assert.equal(f.netProfit, 18)
})

test('разбивка по статьям: складывается по названию, крупные — первыми', () => {
  const rows = expensesByCategory([
    { category: 'Аренда', amount: 100 },
    { category: 'Зарплата', amount: 300 },
    { category: 'Аренда', amount: 50.25 },
    // Статью могли убрать из списка — расход остаётся под её названием
    { category: 'Охрана', amount: '20' },
  ])
  assert.deepEqual(rows, [
    { category: 'Зарплата', amount: 300, count: 1 },
    { category: 'Аренда', amount: 150.25, count: 2 },
    { category: 'Охрана', amount: 20, count: 1 },
  ])
  assert.deepEqual(expensesByCategory(), [])
})

test('пустой период не делит на ноль', () => {
  const f = periodFinance({ sales: [], from })
  assert.equal(f.revenue, 0)
  assert.equal(f.profit, 0)
  assert.equal(f.margin, 0)
})

// ── Итоги смены ──

test('смена без возвратов: чистые числа равны валовым', () => {
  const s = shiftTotals({ totalSales: 500, profit: 200 })
  assert.equal(s.netSales, 500)
  assert.equal(s.netProfit, 200)
  assert.equal(s.refunds, 0)
})

test('смена, закрытая до учёта возвратов, не показывает нули', () => {
  // У старых смен полей возвратов нет вовсе — выручка обязана остаться прежней
  const s = shiftTotals({ totalSales: 800, profit: 300, refundTotal: undefined, refundCost: undefined })
  assert.equal(s.netSales, 800)
  assert.equal(s.netProfit, 300)
})

test('возврат с товаром обратно на полку режет только деньги', () => {
  // Продали на 500 с прибылью 200, вернули 100, товар себестоимостью 60 снова в продаже
  const s = shiftTotals({ totalSales: 500, profit: 200, refundTotal: 100, refundCost: 60 })
  assert.equal(s.netSales, 400)
  assert.equal(s.netProfit, 160, 'минус 100 денег, плюс 60 вернувшейся себестоимости')
})

test('возврат со списанием режет прибыль на всю сумму', () => {
  const s = shiftTotals({ totalSales: 500, profit: 200, refundTotal: 100, refundCost: 0 })
  assert.equal(s.netSales, 400)
  assert.equal(s.netProfit, 100)
})

test('смена, где вернули всё проданное', () => {
  const s = shiftTotals({ totalSales: 300, profit: 120, refundTotal: 300, refundCost: 180 })
  assert.equal(s.netSales, 0)
  assert.equal(s.netProfit, 0)
})

test('пустая смена не ломается', () => {
  const s = shiftTotals(null)
  assert.equal(s.netSales, 0)
  assert.equal(s.netProfit, 0)
})
