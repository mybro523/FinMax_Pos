// ── Поставщики и сервисы перевода в локальной базе ──
//
// Оба списка приходят с сервера (snapshot.mjs); заведённое и поправленное здесь ложится
// поверх поправкой (edits.mjs, ops/supplierops.mjs). Долг поставщику ведёт сервер, а касса
// досчитывает к нему своё неотправленное: приходы в долг, возвраты в счёт долга, оплаты.
import { q } from './db.mjs'
import { ADJ, adjByRow, adjSum } from './edits.mjs'
import { D, fromCents, fromCentsD, toCents } from './money.mjs'

const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

// Неоплаченная часть приходов этой кассы, которые сервер ещё не принял, минус её же
// возвраты товара «в счёт долга». Долг поставщика сервер ведёт сам и присылает с
// каждым обменом; своё неотправленное в него не входит — прибавляем и вычитаем сами.
// Принял — поправка переходит в долг сервера (outbox.mjs)
export function pendingDebtOf(db, supplierId) {
  let sum = D(0)
  for (const r of q(db, "SELECT body FROM docs WHERE kind = 'arrival' AND sync = 'pending'").all()) {
    const a = JSON.parse(r.body)
    if (a.supplierId === supplierId) sum = sum.plus(a.debt || 0)
  }
  for (const x of pendingDebtReturns(db)) if (x.supplierId === supplierId) sum = sum.minus(x.total || 0)
  // Оплаты, их отмена, правка и удаление приходов и возвратов — поправками суммы
  return sum.plus(fromCentsD(adjSum(db, ADJ.supplierDebt, supplierId)))
}

// Свои неотправленные возвраты поставщикам «в счёт долга»
function pendingDebtReturns(db) {
  return q(db, "SELECT body FROM docs WHERE kind = 'supplierreturn' AND sync = 'pending'")
    .all()
    .map((r) => JSON.parse(r.body))
    .filter((x) => x.supplierId && x.refund === 'debt')
}

export const supplierRow = (db, id) => q(db, 'SELECT * FROM suppliers WHERE id = ?').get(id) || null

// ── Кому сколько должны ──
// Сводка для раздела «Долги поставщикам»: как на сервере, плюс свои непосланные
// приходы в долг и минус непосланные возвраты в счёт долга — их сервер ещё не видел
export function suppliersDebts(db) {
  const pendDebt = new Map() // supplierId -> D(долг непосланных приходов)
  const pendCount = new Map() // supplierId -> сколько таких приходов
  for (const r of q(db, "SELECT body FROM docs WHERE kind = 'arrival' AND sync = 'pending'").all()) {
    const a = JSON.parse(r.body)
    if (!a.supplierId || !(Number(a.debt) > 0)) continue
    pendDebt.set(a.supplierId, (pendDebt.get(a.supplierId) || D(0)).plus(a.debt))
    pendCount.set(a.supplierId, (pendCount.get(a.supplierId) || 0) + 1)
  }
  // Возврат товара «в счёт долга» долг уменьшает; счёт долговых приходов — нет
  for (const x of pendingDebtReturns(db)) pendDebt.set(x.supplierId, (pendDebt.get(x.supplierId) || D(0)).minus(x.total || 0))
  // Оплаты и правки — поправками суммы
  for (const [id, c] of adjByRow(db, ADJ.supplierDebt)) pendDebt.set(id, (pendDebt.get(id) || D(0)).plus(fromCentsD(c)))
  let total = D(0)
  let arrivals = 0
  const suppliers = []
  for (const s of q(db, 'SELECT * FROM suppliers').all()) {
    const debt = fromCentsD(s.sDebtC || 0).plus(pendDebt.get(s.id) || 0)
    const count = (s.debtArrivals || 0) + (pendCount.get(s.id) || 0)
    arrivals += count
    if (debt.lte(0)) continue
    total = total.plus(debt)
    suppliers.push({ id: s.id, name: s.name, debt: fromCents(toCents(debt)), arrivals: count })
  }
  suppliers.sort((a, b) => b.debt - a.debt || byName.compare(a.name, b.name))
  return { total: fromCents(toCents(total)), arrivals, suppliers }
}

// Как отдаёт сервер: кассиру — без долгов, владельцу — с долгами
export function suppliersList(db, founder) {
  const rows = q(db, 'SELECT * FROM suppliers').all().sort((a, b) => byName.compare(a.name, b.name))
  return rows.map((s) => {
    const view = { id: s.id, name: s.name, phone: s.phone, note: s.note, createdAt: s.createdAt }
    if (!founder) return view
    // Долга сервер мог и не присылать (запись получал кассир) — тогда он неизвестен
    const debt = s.sDebtC === null ? null : fromCents(toCents(fromCentsD(s.sDebtC).plus(pendingDebtOf(db, s.id))))
    return { ...view, openingDebt: s.openingDebtC === null ? null : fromCents(s.openingDebtC), debt }
  })
}

export const payServicesList = (db) =>
  q(db, 'SELECT id, name, ord, createdAt FROM pay_services ORDER BY ord ASC, name ASC').all()
