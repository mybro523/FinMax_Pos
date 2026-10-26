// ── Доходы вне продаж в отчётах, сводка по статьям, чужая смена ──
//
// Доход прибавляется к чистой прибыли и к чистому доходу ОПУ — и больше никуда:
// выручка, валовой доход и касса от него не меняются. Сводка по статьям сходится
// с итогом. Закрыть смену может её хозяин или тот, кому это разрешено.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { periodFinance } from '../src/lib/finance.js'
import { opuFinance } from '../src/lib/opu.js'
import { byCategory } from '../src/lib/svodka.js'
import { canCloseShift, isOwnShift } from '../src/lib/shiftOwner.js'

const from = new Date('2026-10-01T00:00:00Z')
const to = new Date('2026-11-01T00:00:00Z')
const sale = { id: 's1', date: '2026-10-05T10:00:00Z', total: 1000, cost: 600, profit: 400, payment: 'cash', items: [{ qty: 1 }] }
const expense = { id: 'e1', date: '2026-10-06T10:00:00Z', category: 'Аренда', amount: 150 }
const incomes = [
  { id: 'i1', date: '2026-10-07T10:00:00Z', category: 'Аренда', amount: 300 },
  { id: 'i2', date: '2026-10-08T10:00:00Z', category: 'Бонус от поставщика', amount: 50.5 },
  { id: 'i3', date: '2026-10-09T10:00:00Z', category: 'Аренда', amount: 200 },
  // Вне периода — не считается
  { id: 'i4', date: '2026-09-30T10:00:00Z', category: 'Услуги', amount: 999 },
]

test('доходы прибавляются к чистой прибыли и только к ней', () => {
  const without = periodFinance({ sales: [sale], expenses: [expense], from, to })
  const withInc = periodFinance({ sales: [sale], expenses: [expense], incomes, from, to })
  assert.equal(withInc.incomes, 550.5)
  assert.equal(withInc.incomeCount, 3)
  assert.equal(withInc.netProfit, 400 + 550.5 - 150)
  // Выручка и прибыль на товаре от доходов не меняются
  assert.equal(withInc.revenue, without.revenue)
  assert.equal(withInc.profit, without.profit)
  assert.deepEqual(
    withInc.incomesByCategory.map((c) => [c.category, c.amount, c.count]),
    [['Аренда', 500, 2], ['Бонус от поставщика', 50.5, 1]],
  )
})

test('без доходов чистая прибыль прежняя', () => {
  const f = periodFinance({ sales: [sale], expenses: [expense], from, to })
  assert.equal(f.incomes, 0)
  assert.equal(f.netProfit, 250)
})

test('ОПУ: прочие доходы входят и в чистый доход, и в кассу; валовой доход прежний', () => {
  const base = opuFinance({ sales: [sale], expenses: [expense], from, to })
  const d = opuFinance({ sales: [sale], expenses: [expense], incomes, from, to })
  assert.equal(d.prochieDohody, 550.5)
  assert.equal(d.chistiy, base.chistiy + 550.5)
  assert.equal(d.valovoy, base.valovoy)
  // Касса = Продажа − Оплата поставщику − Все расходы + Прочие доходы (выбор владельца, 26.10.2026)
  assert.equal(d.kassa, base.kassa + 550.5)
  assert.equal(d.allExpenses, base.allExpenses)
  assert.equal(d.dohodyByCategory[0].category, 'Аренда')
})

test('сводка по статьям: крупные сверху, доли и итог сходятся', () => {
  const rows = incomes.slice(0, 3)
  const s = byCategory(rows, (x) => x, { list: 'По статьям', zagolovok: 'Доходы по статьям' })
  assert.deepEqual(s.rows.map((r) => r.category), ['Аренда', 'Бонус от поставщика'])
  assert.equal(s.rows[0].sum, 500)
  assert.equal(s.rows[0].count, 2)
  assert.equal(s.itogi.sum, 550.5)
  assert.equal(s.itogi.count, 3)
  assert.equal(s.rows[0].share, '90.8%')
  assert.equal(s.cols.length, 4)
  assert.ok(s.cols.find((c) => c.key === 'sum').money)
  // Пустой журнал — пустая сводка без деления на ноль
  const empty = byCategory([], (x) => x)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.itogi.sum, 0)
  assert.equal(empty.itogi.share, '')
})

test('закрыть смену: свою — да, чужую — по праву, владелец — всегда', () => {
  const cashierPerms = ['shift.view', 'shift.open', 'shift.cash']
  const canOf = (perms, founder = false) => (...keys) => founder || keys.some((k) => perms.includes(k))
  const cashier = { id: 'acc-1', name: 'kassir', tenantUserId: 'u-1', role: 'cashier' }
  const ownerShift = { id: 'sh', userId: 'u-owner', user: { id: 'u-owner', name: 'admin' } }
  const myShift = { id: 'sh2', userId: 'u-1', user: { id: 'u-1', name: 'kassir' } }

  assert.equal(canCloseShift(ownerShift, cashier, canOf(cashierPerms)), false)
  assert.equal(canCloseShift(myShift, cashier, canOf(cashierPerms)), true)
  assert.equal(canCloseShift(ownerShift, cashier, canOf([...cashierPerms, 'shift.closeAny'])), true)
  assert.equal(canCloseShift(ownerShift, { id: 'acc-0', name: 'admin', role: 'founder' }, canOf([], true)), true)
  // Без права закрывать смены — нельзя даже свою
  assert.equal(canCloseShift(myShift, cashier, canOf(['shift.view'])), false)
  // Только что открытая на сайте: пока без ответа сервера она подписана учётной записью
  assert.equal(isOwnShift({ id: 'tmp', userId: 'acc-1', user: { id: 'acc-1', name: 'kassir' } }, cashier), true)
  // Кто открыл — неизвестно (прежняя версия): закрыть может любой, кому можно
  assert.equal(canCloseShift({ id: 'old', userId: null, user: null }, cashier, canOf(cashierPerms)), true)
  assert.equal(canCloseShift(null, cashier, canOf(cashierPerms)), false)
})
