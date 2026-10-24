import { Prisma } from '@prisma/client'
import { D } from './money'

// ── Когда правили поле — и чья правка новее ──
//
// Программа для Windows правит карточки и без интернета: товар, поставщика, категорию,
// расход. Пока она была без связи, то же поле могли поправить на сайте или на другой
// кассе. Правило выбрал владелец: побеждает последняя правка по времени. Остатки сюда
// не входят — у них свои правила (пересчёт, common/counted.ts).
//
// Касса присылает по каждому полю, что в нём было у неё до правки (base), что стало и
// когда это случилось (at). Сервер сравнивает «было у кассы» с тем, что в поле сейчас:
//   • совпадает — поле с тех пор никто не трогал, правка ложится как есть;
//   • уже стоит то же, что прислала касса, — правки совпали, делать нечего;
//   • иначе поле правили и там, и тут. Новее та правка, что позже по времени: кассы —
//     момент на кассе, а чужой — момент из штампа поля (когда его правили в последний
//     раз). Владелец видит такое столкновение в «Расхождениях» — чья бы ни победила.
//
// Штамп поля пишут все, кто его меняет: сайт (моментом записи) и касса (моментом правки).
// Штампа нет — поле правили до того, как штампы появились: правка кассы новее.

type Tx = Prisma.TransactionClient

export type StampTable = 'Product' | 'Supplier' | 'Category' | 'ProductType' | 'Expense' | 'Income' | 'Arrival'

// Когда правили поля записи: поле → момент
export async function stampsOf(tx: Tx, tbl: StampTable, rowId: string): Promise<Map<string, Date>> {
  const rows = await tx.fieldStamp.findMany({ where: { tbl, rowId } })
  return new Map(rows.map((r) => [r.field, r.at]))
}

// Самая поздняя правка записи — любого поля
export async function lastEditOf(tx: Tx, tbl: StampTable, rowId: string): Promise<Date | null> {
  const r = await tx.fieldStamp.aggregate({ where: { tbl, rowId }, _max: { at: true } })
  return r._max.at ?? null
}

// Отметить, что поля правили в этот момент. Более поздний штамп не сдвигается назад:
// правка кассы, сделанная раньше, но пришедшая позже, не делает поле «старше»
export async function stamp(tx: Tx, tbl: StampTable, rowId: string, fields: string[], at: Date = new Date()) {
  const list = [...new Set(fields.filter(Boolean))]
  if (!list.length || !rowId) return
  // Момент — всемирным временем, как его хранит и читает Prisma во всех таблицах. Дата,
  // переданная в запрос как есть, легла бы по часовому поясу самой базы — и правка с сайта
  // казалась бы на несколько часов новее правки кассы
  const iso = at.toISOString()
  const rows = list.map((f) => Prisma.sql`(${tbl}, ${rowId}, ${f}, (${iso}::timestamptz AT TIME ZONE 'UTC'))`)
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "FieldStamp" ("tbl", "rowId", "field", "at") VALUES ${Prisma.join(rows)}
    ON CONFLICT ("tbl", "rowId", "field") DO UPDATE SET "at" = GREATEST("FieldStamp"."at", EXCLUDED."at")`)
}

// Запись удалили — её штампы больше не нужны
export async function forgetStamps(tx: Tx, tbl: StampTable, rowId: string) {
  await tx.fieldStamp.deleteMany({ where: { tbl, rowId } })
}

// Какие поля сайт действительно поменял: то, что прислали, и то, что было, — разное
export function changedFields(before: Record<string, any>, data: Record<string, any>, fields: readonly string[]): string[] {
  return fields.filter((f) => f in data && data[f] !== undefined && !same(before[f], data[f]))
}

// ── Одинаковые ли значения поля ──
// Деньги сравниваются числом (12 и «12.00» — одно и то же), текст — как есть, списки —
// поэлементно, даты — моментом
export function same(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    const blank = (v: any) => v === null || v === undefined || v === ''
    return blank(a) && blank(b)
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => same(x, b[i]))
  }
  if (a instanceof Date || b instanceof Date) {
    const ta = new Date(a).getTime()
    const tb = new Date(b).getTime()
    return Number.isFinite(ta) && ta === tb
  }
  const isNum = (v: any) => typeof v === 'number' || v instanceof Prisma.Decimal || (typeof v === 'object' && v !== null && typeof v.toFixed === 'function')
  if (isNum(a) || isNum(b)) {
    try {
      return D(a).equals(D(b))
    } catch {
      return false
    }
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b)
  return String(a) === String(b)
}

export interface EditOutcome {
  // Что ложится на запись
  apply: string[]
  // Столкнулись — и победила касса (её правка позже)
  overrode: string[]
  // Столкнулись — и осталась чужая правка (она позже)
  kept: string[]
}

// ── Разобрать правку кассы по полям ──
// set — что прислала касса, base — что было у неё до правки, current — что в записи
// сейчас, stamps — когда правили поля записи, at — когда правили на кассе
export function resolveEdit(set: Record<string, any>, base: Record<string, any>, current: Record<string, any>, stamps: Map<string, Date>, at: Date): EditOutcome {
  const out: EditOutcome = { apply: [], overrode: [], kept: [] }
  for (const field of Object.keys(set)) {
    const now = current[field]
    if (same(now, set[field])) continue
    if (same(now, base[field])) {
      out.apply.push(field)
      continue
    }
    const last = stamps.get(field)
    if (!last || at.getTime() > last.getTime()) {
      out.apply.push(field)
      out.overrode.push(field)
    } else {
      out.kept.push(field)
    }
  }
  return out
}

// Подробности столкновения для «Расхождений»: какое поле, что прислала касса, что было на
// сервере и чья правка осталась
export function conflictNote(tbl: StampTable, set: Record<string, any>, current: Record<string, any>, outcome: EditOutcome, extra: Record<string, any> = {}) {
  // Фото в подробности не кладём (это сотни тысяч знаков), длинный текст — обрезаем:
  // запись должна остаться читаемой и целой
  const show = (f: string, v: any) => {
    if (f === 'image') return v ? '[фото]' : ''
    if (v instanceof Prisma.Decimal) return Number(v)
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…'
    if (Array.isArray(v)) return v.length > 20 ? [...v.slice(0, 20), '…'] : v
    return v
  }
  const fields = [
    ...outcome.overrode.map((f) => ({ field: f, kassa: show(f, set[f]), server: show(f, current[f]), won: 'kassa' })),
    ...outcome.kept.map((f) => ({ field: f, kassa: show(f, set[f]), server: show(f, current[f]), won: 'server' })),
  ]
  return JSON.stringify({ tbl, fields, ...extra })
}
