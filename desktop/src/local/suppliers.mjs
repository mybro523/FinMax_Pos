// ── Поставщики и сервисы перевода в локальной базе ──
//
// Оба списка приходят с сервера (snapshot.mjs) и здесь только читаются: заводит и
// меняет их сервер, для этого нужна связь (gateway.mjs). Без связи касса может
// оформить приход в долг поставщику, которого уже знает.
import { q } from './db.mjs'
import { D, fromCents, fromCentsD, toCents } from './money.mjs'

const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

// Неоплаченная часть приходов этой кассы, которые сервер ещё не принял. Долг
// поставщика сервер ведёт сам и присылает с каждым обменом; своё неотправленное в
// него не входит — прибавляем сами. Принял — прибавка переходит в долг сервера
export function pendingDebtOf(db, supplierId) {
  let sum = D(0)
  for (const r of q(db, "SELECT body FROM docs WHERE kind = 'arrival' AND sync = 'pending'").all()) {
    const a = JSON.parse(r.body)
    if (a.supplierId === supplierId) sum = sum.plus(a.debt || 0)
  }
  return sum
}

export const supplierRow = (db, id) => q(db, 'SELECT * FROM suppliers WHERE id = ?').get(id) || null

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
