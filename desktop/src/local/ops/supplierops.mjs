// ── Поставщики и оплаты им — и без связи ──
//
// Перенос серверных поставщиков (server/src/suppliers/suppliers.service.ts): завести,
// поправить, удалить, оплатить долг, отменить оплату. Карточка поставщика ложится
// поправкой поверх данных сервера (edits.mjs); долг поставщику и деньги из ящика смены —
// поправками сумм: сумма = что сказал сервер + свои неотправленные поправки.
//
// Что решает сервер, когда операция до него дойдёт: правку карточки — по времени (если
// её правили и на сайте); поставщика с тем же названием, заведённого на сайте, считает тем
// же самым — и приходы с оплатами кассы ложатся на него.
import { hasPerm } from '../accounts.mjs'
import { bodyOf, checker, MAX_MONEY } from '../check.mjs'
import { bad, inTx, newId, notFound, q } from '../db.mjs'
import { docByClientId, enqueue, getDoc, liveDoc, myOpenShift, putDoc } from '../docs.mjs'
import { ADJ, adjMove, recordDocEdit, recordEdit } from '../edits.mjs'
import { fixed2, fromCents, fromCentsD, toCents } from '../money.mjs'
import { pendingDebtOf, supplierRow, suppliersList } from '../suppliers.mjs'
import { NO_OPEN_SHIFT } from './expense.mjs'

// Тексты — слово в слово как у сервера
export const SUPPLIER_EXISTS = 'Поставщик с таким названием уже есть'
export const SUPPLIER_HAS_DEBT = 'У поставщика есть долг — сначала закройте его'
export const SUPPLIER_HAS_PAYMENTS = 'По поставщику есть история оплат — удалить нельзя'
export const PAYMENT_SHIFT_CLOSED = 'Смена этой оплаты уже закрыта: она вошла в её отчёт и больше не меняется.'

const at = (now) => new Date(now).toISOString()

// Долг поставщику, как его знает касса: по словам сервера, со своими неотправленными
// приходами, возвратами, оплатами и правками. null — долг кассе неизвестен (его получал кассир)
export function knownDebt(db, sup) {
  if (!sup || sup.sDebtC === null || sup.sDebtC === undefined) return null
  return fromCentsD(sup.sDebtC).plus(pendingDebtOf(db, sup.id))
}

function readSupplier(raw, partial) {
  const dto = bodyOf(raw)
  const c = checker()
  const name = c.str(dto.name, 'name', { optional: partial })
  const phone = c.str(dto.phone, 'phone', { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  const openingDebt = c.num(dto.openingDebt, 'openingDebt', { optional: true, max: MAX_MONEY })
  c.done()
  const out = {}
  if (name !== undefined) {
    out.name = name.trim()
    if (!out.name) throw bad('Укажите название поставщика')
    if (out.name.length > 120) throw bad('Название: не длиннее 120 символов')
  }
  if (phone !== undefined) {
    out.phone = phone.trim()
    if (out.phone.length > 60) throw bad('Телефон: не длиннее 60 символов')
  }
  if (note !== undefined) {
    out.note = note.trim()
    if (out.note.length > 500) throw bad('Примечание: не длиннее 500 символов')
  }
  return { fields: out, openingDebt }
}

const viewOf = (db, user, id) => suppliersList(db, hasPerm(user, 'suppliers.view')).find((s) => s.id === id)

export function createSupplier(ctx, raw) {
  const { db, now } = ctx
  const { fields: f, openingDebt } = readSupplier(raw, false)
  // Долг на начало — как на сайте: только у того, кому видны долги
  const sees = hasPerm(ctx.user, 'suppliers.view')
  const openingC = sees ? toCents(openingDebt || 0) : 0
  return inTx(db, () => {
    if (q(db, 'SELECT 1 FROM suppliers WHERE name = ?').get(f.name)) throw bad(SUPPLIER_EXISTS)
    const id = newId()
    const opId = newId()
    const createdAt = at(now)
    const row = { name: f.name, phone: f.phone || '', note: f.note || '', openingDebtC: sees ? openingC : null, sDebtC: sees ? openingC : null, debtArrivals: sees ? 0 : null, createdAt }
    recordEdit(db, { opId, tbl: 'suppliers', rowId: id, action: 'put', data: { row }, now })
    enqueue(db, {
      id: opId,
      type: 'supplier.create',
      accountId: ctx.user.accountId,
      payload: { supplier: { id, name: row.name, phone: row.phone, note: row.note, openingDebt: fromCents(openingC), createdAt } },
      now,
    })
    return viewOf(db, ctx.user, id)
  })
}

export function updateSupplier(ctx, id, raw) {
  const { db, now } = ctx
  const { fields: f } = readSupplier(raw, true)
  return inTx(db, () => {
    const s = supplierRow(db, id)
    if (!s) throw notFound('Поставщик не найден')
    const set = {}
    const base = {}
    for (const k of ['name', 'phone', 'note']) {
      if (f[k] === undefined || f[k] === s[k]) continue
      set[k] = f[k]
      base[k] = s[k]
    }
    if (set.name && q(db, 'SELECT 1 FROM suppliers WHERE name = ? AND id <> ?').get(set.name, id)) throw bad(SUPPLIER_EXISTS)
    if (!Object.keys(set).length) return viewOf(db, ctx.user, id)
    const opId = newId()
    recordEdit(db, { opId, tbl: 'suppliers', rowId: id, action: 'put', data: { set, was: base }, now })
    enqueue(db, { id: opId, type: 'supplier.update', accountId: ctx.user.accountId, payload: { id, at: at(now), set, base }, now })
    return viewOf(db, ctx.user, id)
  })
}

// История денег не стирается по кнопке: убрать можно только поставщика без долга и без
// оплат. Касса проверяет по тому, что знает; сервер проверит ещё раз
export function deleteSupplier(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const s = supplierRow(db, id)
    if (!s) throw notFound('Поставщик не найден')
    const debt = knownDebt(db, s)
    if (debt !== null && !debt.isZero()) throw bad(SUPPLIER_HAS_DEBT)
    const paid = q(db, "SELECT 1 FROM docs WHERE kind = 'supplierpayment' AND sync NOT IN ('rejected', 'deleted') AND json_extract(body, '$.supplierId') = ? LIMIT 1").get(id)
    if (paid) throw bad(SUPPLIER_HAS_PAYMENTS)
    const opId = newId()
    const { id: _id, ...wasRow } = s
    recordEdit(db, { opId, tbl: 'suppliers', rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type: 'supplier.delete', accountId: ctx.user.accountId, payload: { id, at: at(now) }, now })
    return { ok: true }
  })
}

// ── Оплата поставщику ──
// Переплаты не бывает: магазин платит долг, а не вперёд. «Из кассы» — деньги из ящика
// открытой смены ЭТОЙ кассы: наличных в ней ждут меньше
export function paySupplier(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const amount = c.num(dto.amount, 'amount', { min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const fromCash = c.bool(dto.fromCash, 'fromCash', { optional: true }) === true
  c.str(dto.shiftId, 'shiftId', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  c.done()
  if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

  return inTx(db, () => {
    // Окно переиграло запрос после заминки — второй оплаты не заводим
    if (clientId) {
      const already = docByClientId(db, 'supplierpayment', clientId)
      if (already) return already.body
    }
    const sup = supplierRow(db, id)
    if (!sup) throw notFound('Поставщик не найден')
    const amountC = toCents(amount)
    const debt = knownDebt(db, sup)
    if (debt !== null && fromCentsD(amountC).gt(debt)) throw bad(`Сумма больше долга поставщика (${fixed2(debt)})`)
    let shiftId = null
    if (fromCash) {
      const open = myOpenShift(db, ctx.deviceId)
      if (!open) throw bad(NO_OPEN_SHIFT)
      shiftId = open.body.id
    }
    const opId = newId()
    const date = at(now)
    const body = {
      id: newId(),
      clientId: clientId || null,
      supplierId: sup.id,
      amount: fromCents(amountC),
      date,
      note: (note || '').trim(),
      fromCash,
      shiftId,
      userId: ctx.user.id,
      createdAt: date,
      user: { id: ctx.user.id, name: ctx.user.name },
      supplier: { id: sup.id, name: sup.name },
    }
    putDoc(db, 'supplierpayment', body, { sync: 'pending', deviceId: ctx.deviceId })
    // Долг меньше, наличных в ящике — тоже меньше
    adjMove(db, { opId, target: ADJ.supplierDebt, rowId: sup.id, deltaC: -amountC, now })
    if (shiftId) adjMove(db, { opId, target: ADJ.supplierCash, rowId: shiftId, deltaC: amountC, now })
    enqueue(db, {
      id: opId,
      type: 'supplier.pay',
      accountId: ctx.user.accountId,
      payload: {
        payment: { id: body.id, supplierId: sup.id, amount: body.amount, note: body.note, fromCash, shiftId, date },
        ref: { kind: 'supplierpayment', id: body.id },
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}

// ── Отменить оплату ──
// Из кассы — только пока смена открыта: закрытая уже посчитана с этими деньгами
export function removeSupplierPayment(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'supplierpayment', id)
    if (!doc) throw notFound('Оплата не найдена')
    const p = doc.body
    if (p.fromCash && p.shiftId) {
      const shift = getDoc(db, 'shift', p.shiftId)
      if (shift?.closedAt || shift?.body?.closedAt) throw bad(PAYMENT_SHIFT_CLOSED)
    }
    const opId = newId()
    recordDocEdit(db, { opId, kind: 'supplierpayment', body: p, del: true, now })
    const amountC = toCents(p.amount || 0)
    adjMove(db, { opId, target: ADJ.supplierDebt, rowId: p.supplierId, deltaC: amountC, now })
    if (p.fromCash && p.shiftId) adjMove(db, { opId, target: ADJ.supplierCash, rowId: p.shiftId, deltaC: -amountC, now })
    enqueue(db, {
      id: opId,
      type: 'supplierPayment.delete',
      accountId: ctx.user.accountId,
      payload: { id, at: at(now), ref: { kind: 'supplierpayment', id } },
      now,
    })
    return { ok: true }
  })
}
