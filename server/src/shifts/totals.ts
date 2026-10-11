import { Prisma } from '@prisma/client'
import { D } from '../common/money'

type Tx = Prisma.TransactionClient

// ── Итоги смены ──
// Считаются по документам, привязанным именно к этой смене (а не по диапазону дат):
// чеки, погашения долгов наличными и возвраты. Вынесено отдельно, потому что смену
// закрывают двумя путями — с сайта и с кассы, работавшей без интернета, — и цифры
// в Z-отчёте обязаны получаться одной и той же формулой.
// ── Расходы из кассы за смену ──
// Расход, оплаченный наличными из кассы, — это деньги, которых в ящике уже нет. Ждать
// их при закрытии нельзя: без этого смена «не сходилась» бы ровно на сумму расхода.
// Считаются по расходам, привязанным именно к этой смене.
export async function expenseCashOf(tx: Tx, shiftId: string) {
  const sum = await tx.expense.aggregate({ where: { shiftId, fromCash: true }, _sum: { amount: true } })
  return D(sum._sum.amount ?? 0)
}

// Записать эту сумму в саму смену. Делается при каждом расходе из кассы — и у открытой
// смены тоже: страница смены берёт сумму отсюда (кассиру раздел расходов закрыт), и с
// ней же смена уходит на кассы с программой
export async function setExpenseCash(tx: Tx, shiftId: string) {
  const expenseCash = await expenseCashOf(tx, shiftId)
  await tx.shift.update({ where: { id: shiftId }, data: { expenseCash } })
  return expenseCash
}

// ── Внесено и изъято наличных за смену ──
// Размен, положенный в ящик, и выручка, забранная из него. Первое прибавляется к
// ожидаемым наличным, второе вычитается. Суммы ведутся и у открытой смены — как
// расходы из кассы
export async function cashMovesOf(tx: Tx, shiftId: string) {
  const rows = await tx.cashMove.groupBy({ by: ['kind'], where: { shiftId }, _sum: { amount: true } })
  let cashIn = D(0)
  let cashOut = D(0)
  for (const r of rows) {
    if (r.kind === 'in') cashIn = D(r._sum.amount ?? 0)
    else if (r.kind === 'out') cashOut = D(r._sum.amount ?? 0)
  }
  return { cashIn, cashOut }
}

export async function setCashMoves(tx: Tx, shiftId: string) {
  const totals = await cashMovesOf(tx, shiftId)
  await tx.shift.update({ where: { id: shiftId }, data: totals })
  return totals
}

// ── Оплачено поставщикам из кассы за смену ──
// Денег в ящике нет, как и после расхода из кассы. На прибыль это не влияет: товар
// уже учтён при продаже
export async function supplierCashOf(tx: Tx, shiftId: string) {
  const sum = await tx.supplierPayment.aggregate({ where: { shiftId, fromCash: true }, _sum: { amount: true } })
  return D(sum._sum.amount ?? 0)
}

export async function setSupplierCash(tx: Tx, shiftId: string) {
  const supplierCash = await supplierCashOf(tx, shiftId)
  await tx.shift.update({ where: { id: shiftId }, data: { supplierCash } })
  return supplierCash
}

export async function shiftTotals(
  tx: Tx,
  shift: { id: string; openingCash: Prisma.Decimal | number | string },
  countedCash: Prisma.Decimal | number | string,
) {
  // Продажи именно этой смены — по shiftId (а не по диапазону дат)
  const sales = await tx.sale.findMany({ where: { shiftId: shift.id }, include: { items: true } })

  let salesCash = D(0)
  let salesCard = D(0)
  let salesDebt = D(0)
  // Переводы в ящик не попадают, как и карта. Но их сверяют с выпиской каждого
  // сервиса отдельно — поэтому и общая сумма, и по сервисам
  let salesTransfer = D(0)
  const byService = new Map<string, Prisma.Decimal>()
  let profit = D(0)
  let discount = D(0)
  for (const s of sales) {
    if (s.payment === 'cash') salesCash = salesCash.plus(s.total)
    else if (s.payment === 'card') salesCard = salesCard.plus(s.total)
    else if (s.payment === 'debt') salesDebt = salesDebt.plus(s.total)
    else if (s.payment === 'transfer') {
      salesTransfer = salesTransfer.plus(s.total)
      const via = s.payVia || '—'
      byService.set(via, (byService.get(via) || D(0)).plus(s.total))
    }
    profit = profit.plus(s.profit)
    for (const i of s.items) discount = discount.plus(i.discount)
  }

  // Погашения долгов наличными за смену — это тоже деньги в кассе
  const payments = await tx.debtPayment.findMany({ where: { shiftId: shift.id } })
  let debtPaid = D(0)
  for (const p of payments) debtPaid = debtPaid.plus(p.amount)

  // Возвраты за смену. Наличные кассир отдаёт покупателю ИЗ кассы, поэтому они
  // уменьшают ожидаемую сумму. Возврат картой или списанием долга наличных не трогает.
  // Без этого касса «не сходилась» ровно на сумму возвращённых денег.
  const returns = await tx.saleReturn.findMany({ where: { shiftId: shift.id }, include: { items: true } })
  let refundCash = D(0)
  let refundTotal = D(0)
  // Товар, принятый обратно в продажу, лежит на полке — его закупочная цена
  // не потеряна, поэтому прибыль смены уменьшается только на выданные деньги.
  // Позиции, отмеченные «списать», сюда не входят: они уходят в списание.
  let refundCost = D(0)
  for (const r of returns) {
    refundTotal = refundTotal.plus(r.total)
    if (r.refund === 'cash') refundCash = refundCash.plus(r.total)
    for (const i of r.items) {
      if (!i.restock) continue
      const upp = Math.max(1, i.unitsPerPack || 1)
      refundCost = refundCost.plus(D(i.cost).dividedBy(upp).times(i.units))
    }
  }

  const expenseCash = await expenseCashOf(tx, shift.id)
  const supplierCash = await supplierCashOf(tx, shift.id)
  const { cashIn, cashOut } = await cashMovesOf(tx, shift.id)

  const totalSales = salesCash.plus(salesCard).plus(salesDebt).plus(salesTransfer)
  // В ящике: что было + наличные продажи + погашения долга + внесено − возвраты
  // наличными − расходы из кассы − оплаты поставщикам из кассы − изъято
  const expectedCash = D(shift.openingCash)
    .plus(salesCash)
    .plus(debtPaid)
    .plus(cashIn)
    .minus(refundCash)
    .minus(expenseCash)
    .minus(supplierCash)
    .minus(cashOut)
  const difference = D(countedCash).minus(expectedCash)

  return {
    countedCash: D(countedCash),
    totalSales,
    salesCash,
    salesCard,
    salesDebt,
    salesTransfer,
    transferBy: Object.fromEntries([...byService].map(([k, v]) => [k, Number(v.toFixed(2))])),
    debtPaid,
    refundCash,
    refundTotal,
    refundCost,
    expenseCash,
    supplierCash,
    cashIn,
    cashOut,
    profit,
    discount,
    count: sales.length,
    expectedCash,
    difference,
  }
}
