// ── История товара и карточка поставщика — по данным этого компьютера ──
//
// Обычно их считает сервер: у него все документы за всё время. Когда связи нет, касса
// считает то же самое по своим журналам (продажи — за два месяца, остальное — за полгода)
// и честно помечает ответ: local — посчитано здесь. Чего на кассе нет вовсе — пересчётов
// инвентаризации и правок остатка с сайта, — в таком ответе нет.
import { q } from './db.mjs'
import { listDocs, WINDOW_DAYS } from './docs.mjs'
import { productById, unitsOf } from './stock.mjs'
import { supplierRow, suppliersList } from './suppliers.mjs'
import { uppOf } from './units.mjs'
import { DAY_MS } from './time.mjs'

const who = (u) => u?.name || ''
const n = (v) => Number(v) || 0

// ── История движения товара ──
// Тот же вид, что у сервера (server/src/products/history.ts): строки с датой, сколько штук
// и остаток после каждой — от нынешнего назад
export function productHistory(db, productId, query, now) {
  const product = productById(db, productId)
  if (!product) return null
  const upp = uppOf(product)
  const asked = query?.days === undefined || query.days === '' ? 90 : Number(query.days)
  const from = Number.isFinite(asked) && asked > 0 ? new Date(now - asked * DAY_MS).toISOString() : null
  const rows = []
  const inPeriod = (d) => !from || String(d) >= from

  for (const s of listDocs(db, 'sale')) {
    for (const i of s.items || []) {
      if (i.productId !== productId || !inPeriod(s.date)) continue
      rows.push({ kind: 'sale', date: s.date, delta: -((i.qty || 0) * Math.max(1, i.unitsPerPack || 1) + (i.pieces || 0)), moves: true, docId: s.id, who: who(s.user), price: n(i.price) })
    }
  }
  for (const r of listDocs(db, 'return')) {
    for (const i of r.items || []) {
      if (i.productId !== productId || !inPeriod(r.date)) continue
      rows.push({ kind: 'return', date: r.date, delta: i.restock ? i.units : 0, moves: !!i.restock, docId: r.id, who: who(r.user), restock: !!i.restock, note: r.note || '' })
    }
  }
  for (const a of listDocs(db, 'arrival')) {
    for (const i of a.items || []) {
      if (i.productId !== productId || !inPeriod(a.date)) continue
      rows.push({ kind: 'arrival', date: a.date, delta: (i.qty || 0) * upp + (i.pieces || 0), moves: true, docId: a.id, who: who(a.user), cost: n(i.cost), supplier: a.supplier })
    }
  }
  for (const w of listDocs(db, 'writeoff')) {
    for (const i of w.items || []) {
      if (i.productId !== productId || !inPeriod(w.date)) continue
      const moves = (w.source || 'manual') === 'manual'
      rows.push({ kind: 'writeoff', date: w.date, delta: moves ? -i.units : 0, moves, docId: w.id, who: who(w.user), reason: w.reason, source: w.source || 'manual', note: w.note || '', actual: i.units })
    }
  }
  for (const r of listDocs(db, 'supplierreturn')) {
    for (const i of r.items || []) {
      if (i.productId !== productId || !inPeriod(r.date)) continue
      rows.push({ kind: 'supreturn', date: r.date, delta: -((i.qty || 0) * upp + (i.pieces || 0)), moves: true, docId: r.id, who: who(r.user), price: n(i.price), supplier: r.supplier, note: r.note || '' })
    }
  }
  // Правки остатка в карточке, сделанные на этой кассе
  for (const m of q(db, "SELECT seq, units, createdAt FROM stock_moves WHERE productId = ? AND kind = 'count' ORDER BY seq").all(productId)) {
    if (!inPeriod(m.createdAt)) continue
    rows.push({ kind: 'edit', date: m.createdAt, delta: m.units, moves: true, docId: 'count-' + m.seq, who: '' })
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const unitsNow = unitsOf(db, productId, now).units
  let units = unitsNow
  for (const r of rows) {
    r.after = units
    if (r.kind === 'edit') {
      r.actual = units
      r.expected = units - r.delta
    }
    if (r.moves) units -= r.delta
  }
  // Журналы кассы короче запрошенного периода — часть истории есть только на сервере
  const partial = !from || asked > WINDOW_DAYS.sale
  return { productId, unitsNow, unitsPerPack: upp, rows, local: true, partial }
}

// ── Карточка поставщика ──
// Как у сервера (suppliers.service, findOne): долг и откуда он взялся — приходы в долг и оплаты
export function supplierCard(db, id) {
  if (!supplierRow(db, id)) return null
  const supplier = suppliersList(db, true).find((s) => s.id === id)
  const arrivals = listDocs(db, 'arrival')
    .filter((a) => a.supplierId === id)
    .slice(0, 500)
    .map((a) => ({ id: a.id, date: a.date, total: a.total, debt: a.debt, user: a.user || null, lines: (a.items || []).length }))
  const payments = listDocs(db, 'supplierpayment')
    .filter((p) => p.supplierId === id)
    .slice(0, 500)
  return { ...supplier, arrivals, payments, local: true }
}
