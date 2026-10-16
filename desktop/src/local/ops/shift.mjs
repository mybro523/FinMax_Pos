// ── Смена кассы ──
//
// Перенос серверной смены (server/src/shifts/shifts.service.ts) с одним отличием:
// на сервере открытая смена одна на весь магазин, а здесь — своя у каждой кассы.
// Без интернета иначе нельзя: касса не может знать, открыта ли смена на соседней,
// а ждать связи, чтобы начать продавать, — значит не продавать.
import { hasPerm } from '../accounts.mjs'
import { bodyOf, checker } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { docsOfShift, enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { expenseCashOf } from './expense.mjs'
import { cashMovesOf } from './cash.mjs'

const money = (d) => fromCents(toCents(d))

// ── Кто может закрыть смену ──
// Тот, кто её открыл, или сотрудник с правом «Смена кассы: закрыть смену другого
// сотрудника»; владелец — всегда. Иначе кассир закрыл бы смену владельца и подписал бы
// своим пересчётом чужие деньги. Текст — слово в слово как у сервера
// (server/src/shifts/closer.ts): сервер проверяет то же самое при приёме закрытия
export const NOT_YOUR_SHIFT = 'Эту смену открыл другой сотрудник. Закрыть её может он сам или владелец.'

export function mayCloseShift(shift, user) {
  if (hasPerm(user, 'shift.closeAny')) return true
  // Кто открыл — неизвестно (смена из прежней версии): закрыть может любой, кому можно
  if (!shift?.userId && !shift?.user) return true
  if (shift.userId && shift.userId === user?.id) return true
  return !!shift.user?.name && shift.user.name === user?.name
}

// ── Смена, как её видит окно ──
// У открытой смены этой кассы сумма расходов из кассы — та, что уже знает сервер,
// плюс внесённое здесь и ещё не принятое им. Иначе расход, внесённый без связи, не
// уменьшал бы «ожидается в кассе», пока не дойдёт до сервера, — а смену закрывают
// и без связи. Закрытую смену не трогаем: её итоги уже посчитаны
export function shiftView(db, shift) {
  // Открытая смена в списке кассы — всегда её собственная (docs.mjs, listShifts)
  if (shift.closedAt) return shift
  const { cashIn, cashOut } = cashMovesOf(db, shift.id)
  return {
    ...shift,
    expenseCash: money(expenseCashOf(db, shift)),
    // Экран смены показывает «Оплачено поставщикам» по этой строке. Оплаченные из
    // ящика приходы, ещё не дошедшие до сервера, добавляем сами — как при закрытии
    supplierCash: money(D(shift.supplierCash || 0).plus(pendingPaidOf(db, shift.id))),
    cashIn: money(cashIn),
    cashOut: money(cashOut),
  }
}

// Деньги, ушедшие поставщикам из ящика этой смены с непосланными приходами
function pendingPaidOf(db, shiftId) {
  let paid = D(0)
  for (const r of q(db, "SELECT body FROM docs WHERE kind = 'arrival' AND shiftId = ? AND sync = 'pending'").all(shiftId)) {
    paid = paid.plus(JSON.parse(r.body).paidCash || 0)
  }
  return paid
}

export function openShift(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const openingCash = c.num(dto.openingCash, 'openingCash')
  c.done()

  return inTx(db, () => {
    if (myOpenShift(db, ctx.deviceId)) throw bad('Смена уже открыта')

    const body = {
      id: newId(),
      openedAt: new Date(now).toISOString(),
      closedAt: null,
      openingCash: money(D(openingCash)),
      countedCash: null,
      totalSales: 0,
      salesCash: 0,
      salesCard: 0,
      salesDebt: 0,
      debtPaid: 0,
      refundCash: 0,
      refundTotal: 0,
      refundCost: 0,
      expenseCash: 0,
      cashIn: 0,
      cashOut: 0,
      supplierCash: 0,
      salesTransfer: 0,
      transferBy: {},
      profit: 0,
      discount: 0,
      count: 0,
      expectedCash: 0,
      difference: 0,
      userId: ctx.user.id,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'shift', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, { id: newId(), type: 'shift.open', accountId: ctx.user.accountId, payload: { shift: body, deviceId: ctx.deviceId }, now })
    return body
  })
}

// Итоги смены: чеки, погашения долгов и возвраты, привязанные именно к ней
export function shiftTotals(db, shift, countedCash) {
  const sales = docsOfShift(db, 'sale', shift.id)
  let salesCash = D(0)
  let salesCard = D(0)
  let salesDebt = D(0)
  // Переводы — и всего, и по сервисам: их сверяют с выпиской каждого
  let salesTransfer = D(0)
  const byService = new Map()
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
    for (const i of s.items || []) discount = discount.plus(i.discount || 0)
  }

  // Погашения долгов за смену — тоже деньги в кассе
  let debtPaid = D(0)
  for (const p of docsOfShift(db, 'payment', shift.id)) debtPaid = debtPaid.plus(p.amount)

  // Возвраты за смену. Наличные кассир отдаёт покупателю ИЗ кассы, поэтому они
  // уменьшают ожидаемую сумму; возврат картой или списанием долга наличных не трогает
  let refundCash = D(0)
  let refundTotal = D(0)
  // Товар, принятый обратно в продажу, лежит на полке — его закупочная цена не
  // потеряна. Позиции «списать» сюда не входят: они уходят в списание
  let refundCost = D(0)
  for (const r of docsOfShift(db, 'return', shift.id)) {
    refundTotal = refundTotal.plus(r.total)
    if (r.refund === 'cash') refundCash = refundCash.plus(r.total)
    for (const i of r.items || []) {
      if (!i.restock) continue
      const upp = Math.max(1, i.unitsPerPack || 1)
      refundCost = refundCost.plus(D(i.cost).dividedBy(upp).times(i.units))
    }
  }

  // Расходы магазина и оплаты поставщикам из этой кассы — денег в ящике уже нет.
  // Оплаты долгов знает сервер (shift.supplierCash); оплаченные из ящика приходы,
  // ещё не дошедшие до него, касса добавляет сама — деньги-то уже ушли. Как только
  // приход отправлен, он перестаёт быть pending, а сервер вписывает ту же сумму
  const expenseCash = expenseCashOf(db, shift)
  const supplierCash = D(shift.supplierCash || 0).plus(pendingPaidOf(db, shift.id))
  // Внесено в ящик и изъято из него
  const { cashIn, cashOut } = cashMovesOf(db, shift.id)

  const totalSales = salesCash.plus(salesCard).plus(salesDebt).plus(salesTransfer)
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
    countedCash: money(D(countedCash)),
    totalSales: money(totalSales),
    salesCash: money(salesCash),
    salesCard: money(salesCard),
    salesDebt: money(salesDebt),
    debtPaid: money(debtPaid),
    refundCash: money(refundCash),
    refundTotal: money(refundTotal),
    refundCost: money(refundCost),
    expenseCash: money(expenseCash),
    cashIn: money(cashIn),
    cashOut: money(cashOut),
    supplierCash: money(supplierCash),
    salesTransfer: money(salesTransfer),
    transferBy: Object.fromEntries([...byService].map(([k, v]) => [k, money(v)])),
    profit: money(profit),
    discount: money(discount),
    count: sales.length,
    expectedCash: money(expectedCash),
    difference: money(difference),
  }
}

export function closeShift(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const countedCash = c.num(dto.countedCash, 'countedCash')
  c.done()

  return inTx(db, () => {
    const open = myOpenShift(db, ctx.deviceId)
    if (!open) throw bad('Нет открытой смены')
    if (!mayCloseShift(open.body, ctx.user)) throw bad(NOT_YOUR_SHIFT)

    const body = { ...open.body, closedAt: new Date(now).toISOString(), ...shiftTotals(db, open.body, countedCash) }
    // Смена, открытая здесь же и ещё не ушедшая на сервер, остаётся «ждущей».
    // Уже известная серверу — тоже становится ждущей: её закрытие он ещё не видел
    putDoc(db, 'shift', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: newId(),
      type: 'shift.close',
      accountId: ctx.user.accountId,
      payload: { shift: body, deviceId: ctx.deviceId },
      now,
    })
    return body
  })
}
