// ── Правка и удаление документов — и без связи ──
//
// Расход, доход, внесение и изъятие наличных, возврат поставщику. Перенос серверных
// правил (expenses, incomes, shifts/cash, supplier-returns): те же проверки и те же
// тексты. Документ ложится поправкой (edits.mjs): новое тело с пометкой «поправлен
// здесь» или пометка «удалён здесь», — и уходит на сервер, когда появится связь.
//
// Документы, привязанные к смене (расход и возврат «в кассу», внесение и изъятие),
// живут по правилам смены: править и удалять их можно, пока смена открыта. Закрыли —
// документ вошёл в её отчёт.
//
// Суммы, которые ведёт сервер (расходы из кассы в смене, долг поставщику), касса
// досчитывает поправками — но только у документов, которые сервер уже знает. У заведённого
// здесь и ещё не отправленного сумма и так берётся из него самого.
import { bodyOf, checker, MAX_MONEY } from '../check.mjs'
import { bad, inTx, newId, notFound, q } from '../db.mjs'
import { enqueue, getDoc, liveDoc } from '../docs.mjs'
import { ADJ, adjMove, recordDocEdit, serverKnows } from '../edits.mjs'
import { fromCents, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { uppOf } from '../units.mjs'
import { expenseDate, NO_SUCH_CATEGORY } from './expense.mjs'
import { incomeDate, NO_SUCH_INCOME_CATEGORY } from './income.mjs'

// Тексты — слово в слово как у сервера (shifts/till.ts, supplier-returns)
export const SHIFT_CLOSED = 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.'
export const SHIFT_CLOSED_CASH = 'Смена этой операции уже закрыта: она вошла в её отчёт и больше не меняется.'
export const CLOSED_SHIFT_REFUND = 'Смена этого возврата уже закрыта: деньги вошли в её отчёт. Удалить возврат нельзя.'
const SALARY_MONTH = /^(\d{4}-(0[1-9]|1[0-2]))?$/
const BONUS_DAY = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))?$/

const at = (now) => new Date(now).toISOString()
const shiftClosed = (db, shiftId) => {
  if (!shiftId) return false
  const s = getDoc(db, 'shift', shiftId)
  return !!(s && (s.closedAt || s.body?.closedAt))
}
// Документ сменился: что поменяли (как называет сервер) и что было
function diff(before, after, fields) {
  const set = {}
  const base = {}
  for (const f of fields) {
    if (JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null)) continue
    set[f] = after[f]
    base[f] = before[f] ?? null
  }
  return { set, base }
}

// ════════════════════════ Расход ════════════════════════

const EXPENSE_FIELDS = ['category', 'amount', 'note', 'date', 'employeeId', 'salaryMonth', 'bonusFrom', 'bonusTo']

export function updateExpense(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const category = c.str(dto.category, 'category', { optional: true, min: 1 })
  const amount = c.num(dto.amount, 'amount', { optional: true, min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const date = c.str(dto.date, 'date', { optional: true })
  const employeeId = c.str(dto.employeeId, 'employeeId', { optional: true })
  const salaryMonth = c.str(dto.salaryMonth, 'salaryMonth', { optional: true })
  const bonusFrom = c.str(dto.bonusFrom, 'bonusFrom', { optional: true })
  const bonusTo = c.str(dto.bonusTo, 'bonusTo', { optional: true })
  c.done()
  if (salaryMonth !== undefined && !SALARY_MONTH.test(salaryMonth)) throw bad('Месяц зарплаты — в виде ГГГГ-ММ, например 2026-10')
  for (const d of [bonusFrom, bonusTo]) if (d !== undefined && !BONUS_DAY.test(d)) throw bad('Дата периода бонуса — в виде ГГГГ-ММ-ДД, например 2026-10-10')
  if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

  return inTx(db, () => {
    const doc = liveDoc(db, 'expense', id)
    if (!doc) throw notFound('Расход не найден')
    const e = doc.body
    if (e.fromCash && shiftClosed(db, e.shiftId)) throw bad(SHIFT_CLOSED)
    const next = { ...e }
    if (category !== undefined && category.trim() !== e.category) {
      const name = category.trim()
      if (name.length > 60) throw bad('Категория: не длиннее 60 символов')
      if (!q(db, 'SELECT 1 FROM expense_categories WHERE name = ?').get(name)) throw bad(NO_SUCH_CATEGORY)
      next.category = name
    }
    if (amount !== undefined) next.amount = fromCents(toCents(amount))
    if (note !== undefined) next.note = note.trim()
    // Дата расхода из кассы — это время в смене, её не переносят
    if (date !== undefined && !e.fromCash) next.date = expenseDate(date, now)
    if (employeeId !== undefined) {
      const emp = employeeId.trim()
      if (!emp) Object.assign(next, { employeeId: null, employeeName: '', salaryMonth: '', bonusFrom: '', bonusTo: '' })
      else if (emp !== e.employeeId) Object.assign(next, { employeeId: emp, employeeName: '' })
    }
    if (salaryMonth !== undefined && next.employeeId) next.salaryMonth = salaryMonth
    if (bonusFrom !== undefined || bonusTo !== undefined) {
      const f = bonusFrom ?? e.bonusFrom ?? ''
      const t = bonusTo ?? e.bonusTo ?? ''
      if (!f || !t) Object.assign(next, { bonusFrom: '', bonusTo: '' })
      else if (f > t) throw bad('Период бонуса: дата «с» позже даты «по»')
      else Object.assign(next, { bonusFrom: f, bonusTo: t })
    }
    const { set, base } = diff(e, next, EXPENSE_FIELDS)
    if (!Object.keys(set).length) return e
    const opId = newId()
    const was = recordDocEdit(db, { opId, kind: 'expense', body: next, now })
    // Сумму расходов из кассы сервер ведёт в смене: он знает прежнюю — досчитываем разницу
    if (e.fromCash && e.shiftId && serverKnows(was) && 'amount' in set) {
      adjMove(db, { opId, target: ADJ.expenseCash, rowId: e.shiftId, deltaC: toCents(next.amount) - toCents(e.amount), now })
    }
    enqueue(db, { id: opId, type: 'expense.update', accountId: ctx.user.accountId, payload: { id, at: at(now), set, base, ref: { kind: 'expense', id } }, now })
    return next
  })
}

export function deleteExpense(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'expense', id)
    if (!doc) throw notFound('Расход не найден')
    const e = doc.body
    if (e.fromCash && shiftClosed(db, e.shiftId)) throw bad(SHIFT_CLOSED)
    const opId = newId()
    const was = recordDocEdit(db, { opId, kind: 'expense', body: e, del: true, now })
    if (e.fromCash && e.shiftId && serverKnows(was)) adjMove(db, { opId, target: ADJ.expenseCash, rowId: e.shiftId, deltaC: -toCents(e.amount), now })
    enqueue(db, { id: opId, type: 'expense.delete', accountId: ctx.user.accountId, payload: { id, at: at(now), ref: { kind: 'expense', id } }, now })
    return { ok: true }
  })
}

// ════════════════════════ Доход ════════════════════════

export function updateIncome(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const category = c.str(dto.category, 'category', { optional: true, min: 1 })
  const amount = c.num(dto.amount, 'amount', { optional: true, min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const date = c.str(dto.date, 'date', { optional: true })
  c.done()
  if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

  return inTx(db, () => {
    const doc = liveDoc(db, 'income', id)
    if (!doc) throw notFound('Доход не найден')
    const x = doc.body
    const next = { ...x }
    if (category !== undefined && category.trim() !== x.category) {
      const name = category.trim()
      if (name.length > 60) throw bad('Категория: не длиннее 60 символов')
      if (!q(db, 'SELECT 1 FROM income_categories WHERE name = ?').get(name)) throw bad(NO_SUCH_INCOME_CATEGORY)
      next.category = name
    }
    if (amount !== undefined) next.amount = fromCents(toCents(amount))
    if (note !== undefined) next.note = note.trim()
    if (date !== undefined) next.date = incomeDate(date, now)
    const { set, base } = diff(x, next, ['category', 'amount', 'note', 'date'])
    if (!Object.keys(set).length) return x
    const opId = newId()
    recordDocEdit(db, { opId, kind: 'income', body: next, now })
    enqueue(db, { id: opId, type: 'income.update', accountId: ctx.user.accountId, payload: { id, at: at(now), set, base, ref: { kind: 'income', id } }, now })
    return next
  })
}

export function deleteIncome(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'income', id)
    if (!doc) throw notFound('Доход не найден')
    const opId = newId()
    recordDocEdit(db, { opId, kind: 'income', body: doc.body, del: true, now })
    enqueue(db, { id: opId, type: 'income.delete', accountId: ctx.user.accountId, payload: { id, at: at(now), ref: { kind: 'income', id } }, now })
    return { ok: true }
  })
}

// ════════════════════════ Внесение и изъятие ════════════════════════
// Отменить ошибочную запись — пока смена открыта. Сумму внесений смены касса считает по
// самим записям (ops/cash.mjs): удалённая здесь в неё больше не входит

export function deleteCashMove(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'cashmove', id)
    if (!doc) throw notFound('Операция не найдена')
    if (shiftClosed(db, doc.body.shiftId)) throw bad(SHIFT_CLOSED_CASH)
    const opId = newId()
    recordDocEdit(db, { opId, kind: 'cashmove', body: doc.body, del: true, now })
    enqueue(db, { id: opId, type: 'cashMove.delete', accountId: ctx.user.accountId, payload: { id, at: at(now), ref: { kind: 'cashmove', id } }, now })
    return { ok: true }
  })
}

// ════════════════════════ Возврат поставщику ════════════════════════
// Товар возвращается в те же партии (их сроки и цены записаны в строке возврата), долг
// поставщику — назад, деньги «в кассу» — назад

export function deleteSupplierReturn(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'supplierreturn', id)
    if (!doc) throw notFound('Возврат не найден')
    const r = doc.body
    if (r.refund === 'cash' && shiftClosed(db, r.shiftId)) throw bad(CLOSED_SHIFT_REFUND)
    const opId = newId()
    for (const it of r.items || []) {
      const p = it.productId ? productById(db, it.productId) : null
      if (!p) continue
      const parts = Array.isArray(it.batches) ? it.batches : []
      if (parts.length) {
        for (const b of parts) {
          const units = Math.max(0, Math.trunc(Number(b?.units) || 0))
          if (units > 0) {
            move(db, { opId, productId: p.id, kind: 'supreturn-undo', units, costC: toCents(b?.cost ?? it.cost ?? 0), expiryDate: b?.expiryDate ?? null, note: 'возврат поставщику отменён' }, { now })
          }
        }
      } else {
        const units = (it.qty || 0) * uppOf(p) + (it.pieces || 0)
        if (units > 0) move(db, { opId, productId: p.id, kind: 'supreturn-undo', units, costC: toCents(it.cost ?? 0), expiryDate: null, note: 'возврат поставщику отменён' }, { now })
      }
    }
    const was = recordDocEdit(db, { opId, kind: 'supplierreturn', body: r, del: true, now })
    // В счёт долга: долг возвращается. У заведённого здесь и не отправленного вычет и так
    // шёл из самого возврата (suppliers.mjs) — удалённый в него больше не входит
    if (r.refund === 'debt' && r.supplierId && serverKnows(was)) adjMove(db, { opId, target: ADJ.supplierDebt, rowId: r.supplierId, deltaC: toCents(r.total || 0), now })
    enqueue(db, { id: opId, type: 'supplierReturn.delete', accountId: ctx.user.accountId, payload: { id, at: at(now), ref: { kind: 'supplierreturn', id } }, now })
    return { ok: true }
  })
}
