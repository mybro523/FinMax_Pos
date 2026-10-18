import { Prisma } from '@prisma/client'
import { periodWhere, PeriodQuery } from '../common/period'
import { totalUnits, uppOf } from '../common/stock'

// ── История движения товара ──
// «Куда делись пять упаковок?» — раньше ответ собирали по четырём журналам. Здесь все
// движения одного товара в одном списке: приход, продажа, возврат, списание, пересчёт,
// правка остатка в карточке, возврат поставщику. У каждой строки — дата, сколько штук, кто сделал и
// остаток после неё.
//
// Остаток после каждой строки считается от нынешнего назад: сегодняшний остаток
// известен точно, а каждая строка выше говорит, на сколько он изменился. Поэтому
// строки, которые остаток не двигают (списание при возврате — товар на полку и не
// ложился; недостача, найденная пересчётом, — её уже учёл сам пересчёт), помечены
// отдельно и в счёт не идут.

type Db = Prisma.TransactionClient | { [k: string]: any }
type Range = { gte?: Date; lte?: Date; gt?: Date } | undefined

export interface HistoryRow {
  kind: 'arrival' | 'sale' | 'return' | 'writeoff' | 'inventory' | 'edit' | 'supreturn'
  date: Date
  // Сколько штук прибавилось (плюс) или ушло (минус)
  delta: number
  // Строка двигает остаток. Нет — она только объясняет (списание при возврате,
  // недостача по пересчёту)
  moves: boolean
  docId: string
  who: string
  // Подробности для человека: цена, поставщик, причина, что насчитали
  price?: number
  cost?: number
  supplier?: string
  reason?: string
  source?: string
  restock?: boolean
  note?: string
  expected?: number
  actual?: number
  // Остаток в штуках после этой строки (ставится позже)
  after?: number
}

const n = (v: any) => Number(v) || 0
const who = (u: { name: string } | null | undefined) => u?.name || ''

async function rowsOf(db: Db, productId: string, upp: number, range: Range): Promise<HistoryRow[]> {
  const dated = range ? { date: range } : {}
  const [sales, returns, arrivals, writeoffs, counts, edits, supReturns] = await Promise.all([
    db.saleItem.findMany({
      where: { productId, sale: dated },
      include: { sale: { select: { id: true, date: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
    db.saleReturnItem.findMany({
      where: { productId, ret: dated },
      include: { ret: { select: { id: true, date: true, note: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
    db.arrivalItem.findMany({
      where: { productId, arrival: dated },
      include: { arrival: { select: { id: true, date: true, supplier: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
    db.writeOffItem.findMany({
      where: { productId, writeOff: dated },
      include: { writeOff: { select: { id: true, date: true, reason: true, source: true, note: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
    db.inventoryItem.findMany({
      where: { productId, actualUnits: { not: null }, inventory: { status: 'applied', ...(range ? { appliedAt: range } : {}) } },
      include: { inventory: { select: { id: true, appliedAt: true, date: true, note: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
    db.stockEdit.findMany({ where: { productId, ...dated }, include: { user: { select: { name: true } } }, take: 5000 }),
    db.supplierReturnItem.findMany({
      where: { productId, ret: dated },
      include: { ret: { select: { id: true, date: true, supplier: true, note: true, user: { select: { name: true } } } } },
      take: 5000,
    }),
  ])

  const out: HistoryRow[] = []
  for (const a of arrivals) {
    out.push({
      kind: 'arrival',
      date: a.arrival.date,
      // Приход хранит упаковки и штуки сверх них (у весового — граммы) — в штуки
      // переводим по нынешней упаковке товара
      delta: a.qty * upp + (a.pieces || 0),
      moves: true,
      docId: a.arrival.id,
      who: who(a.arrival.user),
      cost: n(a.cost),
      supplier: a.arrival.supplier,
    })
  }
  for (const s of sales) {
    out.push({
      kind: 'sale',
      date: s.sale.date,
      delta: -(s.qty * Math.max(1, s.unitsPerPack || 1) + (s.pieces || 0)),
      moves: true,
      docId: s.sale.id,
      who: who(s.sale.user),
      price: n(s.price),
    })
  }
  for (const r of returns) {
    out.push({
      kind: 'return',
      date: r.ret.date,
      delta: r.restock ? r.units : 0,
      moves: !!r.restock,
      docId: r.ret.id,
      who: who(r.ret.user),
      restock: !!r.restock,
      note: r.ret.note,
    })
  }
  for (const w of writeoffs) {
    // Списание руками убирает товар с полки. Списание при возврате и недостача по
    // пересчёту — записи об убытке: товар уже не лежал или его уже снял пересчёт
    const moves = w.writeOff.source === 'manual'
    out.push({
      kind: 'writeoff',
      date: w.writeOff.date,
      delta: moves ? -w.units : 0,
      moves,
      docId: w.writeOff.id,
      who: who(w.writeOff.user),
      reason: w.writeOff.reason,
      source: w.writeOff.source,
      note: w.writeOff.note,
      actual: w.units,
    })
  }
  for (const c of counts) {
    const actual = c.actualUnits ?? 0
    out.push({
      kind: 'inventory',
      date: c.inventory.appliedAt || c.inventory.date,
      delta: actual - c.expectedUnits,
      moves: true,
      docId: c.inventory.id,
      who: who(c.inventory.user),
      expected: c.expectedUnits,
      actual,
      note: c.inventory.note,
    })
  }
  for (const e of edits) {
    out.push({ kind: 'edit', date: e.date, delta: e.toUnits - e.fromUnits, moves: true, docId: e.id, who: who(e.user), expected: e.fromUnits, actual: e.toUnits })
  }
  for (const r of supReturns) {
    // Отдали поставщику — товар ушёл со склада, как при продаже
    out.push({
      kind: 'supreturn',
      date: r.ret.date,
      delta: -(r.qty * upp + (r.pieces || 0)),
      moves: true,
      docId: r.ret.id,
      who: who(r.ret.user),
      price: n(r.price),
      supplier: r.ret.supplier,
      note: r.ret.note,
    })
  }
  return out
}

export async function productHistory(db: Db, product: { id: string; stock: number; looseUnits: number | null; unitsPerPack: number | null }, q: PeriodQuery) {
  const upp = uppOf(product)
  const range = periodWhere(q, 90) as Range
  const rows = await rowsOf(db, product.id, upp, range)
  rows.sort((a, b) => b.date.getTime() - a.date.getTime())

  // Нынешний остаток — точка отсчёта. Если период кончается в прошлом, сначала
  // отматываем движения, случившиеся после него
  let units = totalUnits(product)
  if (range?.lte) {
    const later = await rowsOf(db, product.id, upp, { gt: range.lte })
    for (const r of later) if (r.moves) units -= r.delta
  }
  for (const r of rows) {
    r.after = units
    if (r.moves) units -= r.delta
  }
  return { productId: product.id, unitsNow: totalUnits(product), unitsPerPack: upp, rows }
}
