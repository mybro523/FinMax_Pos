// ── Деньги за период: продажи минус возвраты и потери ──
// Выручка и прибыль по одним продажам всегда завышены: часть денег вернули
// покупателям, часть товара ушла в списание по сроку или бою. Владелец должен
// видеть то, что осталось у магазина, поэтому расчёт собран здесь — и Отчёты,
// и Панель управления берут цифры отсюда и не расходятся между собой.

import { unitCost } from './units.js'

const num = (v) => Number(v) || 0

const inRange = (date, from, to) => {
  const t = new Date(date).getTime()
  return t >= from.getTime() && (!to || t < to.getTime())
}

// Себестоимость позиций возврата, считается в ШТУКАХ: цена упаковки / штук в упаковке.
const itemsCost = (items, keep) =>
  (items || []).reduce((s, i) => (keep && !keep(i) ? s : s + unitCost(i) * num(i.units)), 0)

// Себестоимость позиций, вернувшихся В ПРОДАЖУ: товар снова на полке, значит его
// закупочная цена не потеряна и прибыль уменьшается только на выданные деньги.
// Позиции, отмеченные «списать», сюда не входят.
// Это же число смена отдаёт серверу как refundCost — в Z-отчёте списаний нет,
// поэтому там учитывается только реально вернувшийся в продажу товар.
export function restockedCost(ret) {
  return itemsCost(ret?.items, (i) => i.restock)
}

// Себестоимость ВСЕГО вернувшегося товара — и того, что легло обратно на полку,
// и того, что забраковали. Нужна там, где рядом вычитаются списания (отчёты за период).
//
// Почему именно так. При продаже себестоимость уже ушла из прибыли — она сидит
// в profitGross. Товар вернулся: эту себестоимость надо вернуть обратно, иначе она
// потеряна дважды. Если позицию забраковали, её снимет writeOffCost — ровно один раз.
// Раньше здесь бралось только вернувшееся на полку, и брак вычитался повторно:
// возврат со списанием занижал прибыль на всю закупочную цену товара.
export function returnedCost(ret) {
  return itemsCost(ret?.items)
}

// Чистые числа смены: то же правило, что и в отчётах, но по одной смене.
// Работает и для смен, закрытых до появления учёта возвратов: у них возвраты
// нулевые, поэтому чистые значения совпадают с валовыми.
export function shiftTotals(shift) {
  const gross = num(shift?.totalSales)
  const refunds = num(shift?.refundTotal)
  const backToShelf = num(shift?.refundCost)
  return {
    gross,
    refunds,
    netSales: gross - refunds,
    netProfit: num(shift?.profit) - refunds + backToShelf,
  }
}

// ── Расходы магазина по статьям ──
// Аренда, зарплата, свет — то, что магазин тратит помимо закупки товара. Статья
// хранится названием, поэтому и складываем по названию: убранная из списка статья
// остаётся в прежних расходах и в отчёте за их период.
export function expensesByCategory(list = []) {
  const map = new Map()
  for (const e of list) {
    const name = e?.category || ''
    const row = map.get(name) || { category: name, amount: 0, count: 0 }
    row.amount += num(e?.amount)
    row.count += 1
    map.set(name, row)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

// Итоги за период. sales/returns/writeOffs/expenses/incomes — списки как приходят с
// сервера. to не задан — значит «по настоящий момент».
export function periodFinance({ sales = [], returns = [], writeOffs = [], expenses = [], incomes = [], from, to }) {
  const soldList = sales.filter((s) => s && s.date && Array.isArray(s.items) && inRange(s.date, from, to))
  const returnList = returns.filter((r) => r && r.date && inRange(r.date, from, to))
  const writeOffList = writeOffs.filter((w) => w && w.date && inRange(w.date, from, to))

  const revenueGross = soldList.reduce((s, x) => s + num(x.total), 0)
  const cost = soldList.reduce((s, x) => s + num(x.cost), 0)
  const profitGross = soldList.reduce((s, x) => s + num(x.profit), 0)

  const byPay = { cash: 0, card: 0, transfer: 0, debt: 0 }
  // Переводы — ещё и по сервисам: их сверяют с выпиской каждого отдельно
  const viaMap = new Map()
  soldList.forEach((s) => {
    if (s.payment in byPay) byPay[s.payment] += num(s.total)
    if (s.payment === 'transfer') {
      const k = s.payVia || '—'
      viaMap.set(k, (viaMap.get(k) || 0) + num(s.total))
    }
  })

  const expenseList = expenses.filter((e) => e && e.date && inRange(e.date, from, to))
  const expensesTotal = expenseList.reduce((s, e) => s + num(e.amount), 0)
  // Доходы вне продаж: аренда, услуги, бонусы поставщиков. Прибавляются к чистой прибыли
  const incomeList = incomes.filter((e) => e && e.date && inRange(e.date, from, to))
  const incomesTotal = incomeList.reduce((s, e) => s + num(e.amount), 0)

  const refunds = returnList.reduce((s, r) => s + num(r.total), 0)
  const returnedBack = returnList.reduce((s, r) => s + returnedCost(r), 0)
  const writeOffCost = writeOffList.reduce((s, w) => s + num(w.totalCost), 0)

  // Выручка — за вычетом возвращённых денег.
  // Прибыль — минус возвращённые деньги, плюс себестоимость ВСЕГО вернувшегося товара,
  // минус всё списанное. Брак, приехавший с возвратом, оформляется отдельным списанием
  // и попадает в writeOffs — там он и вычитается, ровно один раз.
  const revenue = revenueGross - refunds
  const profit = profitGross - refunds + returnedBack - writeOffCost
  const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0

  return {
    list: soldList,
    count: soldList.length,
    revenueGross,
    revenue,
    cost,
    profitGross,
    profit,
    margin,
    byPay,
    transferBy: [...viaMap].map(([via, amount]) => ({ via, amount })).sort((a, b) => b.amount - a.amount),
    refunds,
    refundCount: returnList.length,
    // Себестоимость вернувшегося товара — показывается отдельной строкой в разбивке
    // прибыли, иначе слагаемые на экране не сходятся с итогом
    returnedCost: returnedBack,
    writeOffCost,
    writeOffCount: writeOffList.length,
    // true, если за период вообще были потери — иначе незачем показывать разбивку
    hasLosses: refunds > 0 || writeOffCost > 0,
    // Расходы магазина за период и то, что осталось после них. Прибыль выше — это
    // заработок на товаре; чистая прибыль — то, что магазин на самом деле заработала,
    // заплатив за аренду, зарплату и всё остальное
    expenses: expensesTotal,
    expenseCount: expenseList.length,
    expensesByCategory: expensesByCategory(expenseList),
    // Прочие доходы — то, что магазин получил не за товар. Складываются по статьям тем же
    // правилом, что и расходы
    incomes: incomesTotal,
    incomeCount: incomeList.length,
    incomesByCategory: expensesByCategory(incomeList),
    netProfit: profit + incomesTotal - expensesTotal,
  }
}
