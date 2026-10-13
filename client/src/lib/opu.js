// ── Отчёт ОПУ: прибыли и убытки за период ──
//
// Вид и строки повторяют отчёт, к которому привыкли владельцы магазинов:
// продажа, себестоимость, валовой доход, оплата поставщику, расходы по статьям
// и чистый доход. Чистый доход здесь КАССОВЫЙ — по просьбе владельца из него
// вычитаются и расходы, и деньги, отданные поставщикам за товар:
// «сколько денег на самом деле осталось за период».
//
// Валовой доход берётся из общего расчёта periodFinance (как «Прибыль» во вкладке
// «Подробно»), поэтому возвраты и списания учтены и отчёты не спорят друг с другом.

import { periodFinance } from './finance.js'

const num = (v) => Number(v) || 0
const inRange = (date, from, to) => {
  const t = new Date(date).getTime()
  return t >= from.getTime() && (!to || t < to.getTime())
}

// Статьи, по которым отчёт раскладывает расходы. Сами статьи заводятся на сервере
// миграцией — здесь только их имена. Сравнение без регистра: владелец мог завести
// «зарплата» руками ещё до обновления
export const OPU_ZARPLATA = 'Зарплата'
export const OPU_NALOGI = 'Налоги'
export const OPU_MAGAZIN = 'Расход магазина'
const norm = (s) => String(s || '').trim().toLowerCase()

export function opuFinance({ sales = [], returns = [], writeOffs = [], expenses = [], debtPayments = [], supplierPayments = [], arrivals = [], from, to }) {
  const fin = periodFinance({ sales, returns, writeOffs, expenses, from, to })

  // Расходы по статьям: зарплата, налоги, магазин, всё прочее — «другие»
  let zarplata = 0
  let nalogi = 0
  let magazin = 0
  let other = 0
  for (const e of expenses) {
    if (!e || !e.date || !inRange(e.date, from, to)) continue
    const a = num(e.amount)
    const c = norm(e.category)
    if (c === norm(OPU_ZARPLATA)) zarplata += a
    else if (c === norm(OPU_NALOGI)) nalogi += a
    else if (c === norm(OPU_MAGAZIN)) magazin += a
    else other += a
  }
  const allExpenses = zarplata + nalogi + magazin + other

  // Деньги, отданные поставщикам за период:
  //   • записи «оплата поставщику» (погашения долгов и оплаты приходов из кассы);
  //   • плюс оплаченная сразу часть приходов, у которых записи оплаты нет
  //     (наличными своими, картой и старые приходы): total − debt − уже записанное.
  // Оплата прихода «из кассы» записана с clientId = id прихода + ':pay' — по нему
  // и вычитаем, чтобы не посчитать те же деньги дважды.
  const paidByClient = new Map()
  for (const p of supplierPayments) {
    if (p && p.clientId) paidByClient.set(p.clientId, num(p.amount))
  }
  let supplierPaid = 0
  for (const p of supplierPayments) {
    const d = p && (p.date || p.createdAt)
    if (d && inRange(d, from, to)) supplierPaid += num(p.amount)
  }
  for (const a of arrivals) {
    if (!a || !a.date || !inRange(a.date, from, to)) continue
    const paidNow = num(a.total) - num(a.debt) - (paidByClient.get(a.id + ':pay') || 0)
    if (paidNow > 0) supplierPaid += paidNow
  }

  // Касса — наличные, пришедшие за период: продажи налом и погашения долгов
  // клиентов минус возвраты, выданные наличными
  let debtPaid = 0
  for (const p of debtPayments) {
    const d = p && (p.createdAt || p.date)
    if (d && inRange(d, from, to)) debtPaid += num(p.amount)
  }
  let refundsCash = 0
  for (const r of returns) {
    if (r && r.date && inRange(r.date, from, to) && r.refund === 'cash') refundsCash += num(r.total)
  }
  const kassa = fin.byPay.cash + debtPaid - refundsCash

  const valovoy = fin.profit
  const chistiy = valovoy - allExpenses - supplierPaid

  return {
    prodazha: fin.revenue,
    sebestoimost: fin.cost,
    valovoy,
    supplierPaid,
    zarplata,
    nalogi,
    magazin,
    other,
    allExpenses,
    chistiy,
    kassa,
    fin,
  }
}
