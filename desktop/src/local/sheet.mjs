// ── Лист пересчёта: основа и поправки по строкам (версия 1.4.15) ──
//
// В docs лежит основа листа: копия сервера (или лист, каким его завели здесь или на соседней
// кассе, пока сервер его не знает). Насчитанное поверх неё — поправками по строкам
// (row_edits, tbl = 'doc:inventory', action = 'lines'): какие строки, сколько и когда
// насчитали; применение — та же поправка с пометкой apply. Лист, который видит окно, —
// основа и поверх неё неотправленные поправки, по каждой строке — самое позднее по времени.
// Отдельно от ops/inventory.mjs: этим пользуются и поправки (edits.mjs), и обмен по сети
import { q } from './db.mjs'
import { liveDoc, putDoc } from './docs.mjs'

export const SHEET_TBL = 'doc:inventory'

const TBL = SHEET_TBL
const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const msOf = (s) => {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

// ── Неотправленные поправки листов ──
// По номеру листа — в том порядке, в каком делались. Без номера — всех листов сразу
export function pendingEdits(db, id = null) {
  const rows = id
    ? q(db, "SELECT opId, rowId, data FROM row_edits WHERE tbl = ? AND rowId = ? AND synced = 0 AND action = 'lines' ORDER BY seq").all(TBL, id)
    : q(db, "SELECT opId, rowId, data FROM row_edits WHERE tbl = ? AND synced = 0 AND action = 'lines' ORDER BY seq").all(TBL)
  const out = new Map()
  for (const r of rows) {
    const d = parse(r.data)
    if (!d || typeof d !== 'object') continue
    if (!out.has(r.rowId)) out.set(r.rowId, [])
    out.get(r.rowId).push({ opId: r.opId, lines: d.lines, apply: d.apply })
  }
  return out
}

// Чем кончаются поправки: по строке — самое позднее по времени (при равном — последнее);
// применение закрывает лист, и правки после него уже не ложатся (сервер их не примет)
export function settle(edits) {
  const lines = new Map()
  let apply = null
  for (const e of edits || []) {
    for (const l of Array.isArray(e.lines) ? e.lines : []) {
      if (!l || typeof l.id !== 'string') continue
      const cur = lines.get(l.id)
      if (cur && msOf(cur.at) > msOf(l.at)) continue
      lines.set(l.id, { actualUnits: Number.isInteger(l.actualUnits) ? l.actualUnits : null, at: l.at, opId: e.opId })
    }
    if (e.apply && typeof e.apply === 'object') {
      apply = e.apply
      break
    }
  }
  return { lines, apply }
}

// ── Лист, каким его видит окно: основа и поверх неё поправки ──
// Применённый на сервере лист — история: поправки, которые ещё ждут ответа, на нём уже не
// показываются (сервер их отвергнет, и они уйдут сами). У строки основы бывает момент
// пересчёта (countedAt: его сообщает сервер, его ставит принятая своя поправка) — поправка
// старше этого момента не ложится: позднее по времени побеждает и здесь
export const lineWins = (l, baseLine) => !baseLine?.countedAt || msOf(l.at) >= msOf(baseLine.countedAt)

export function sheetView(base, edits) {
  if (!base || base.status === 'applied' || !edits?.length || !Array.isArray(base.items)) return base
  const { lines, apply } = settle(edits)
  const expected = new Map()
  for (const x of Array.isArray(apply?.expected) ? apply.expected : []) {
    if (x && typeof x.id === 'string' && Number.isInteger(x.units)) expected.set(x.id, x.units)
  }
  const items = base.items.map((it) => {
    const l0 = lines.get(it.id)
    const l = l0 && lineWins(l0, it) ? l0 : null
    const e = expected.get(it.id)
    if (!l && e === undefined) return it
    return { ...it, ...(l ? { actualUnits: l.actualUnits, countedAt: l.at } : {}), ...(e !== undefined ? { expectedUnits: e } : {}) }
  })
  return apply ? { ...base, items, status: 'applied', appliedAt: typeof apply.at === 'string' ? apply.at : base.appliedAt } : { ...base, items }
}

// Закрыт ли лист здесь: применён на сервере или применение ждёт отправки (своё или соседа)
export function sheetShut(db, id) {
  const doc = liveDoc(db, 'inventory', id)
  if (!doc) return false
  return sheetView(doc.body, pendingEdits(db, id).get(id))?.status === 'applied'
}

// ── Сервер принял свою поправку листа ──
// До его следующего ответа она переходит в основу: иначе лист на миг показал бы прежние
// числа. Свежая копия сервера потом заменит основу целиком — уже с ней
export function foldSheetEdit(db, id, data) {
  const row = q(db, "SELECT body, sync, deviceId FROM docs WHERE kind = 'inventory' AND id = ?").get(id)
  if (!row) return
  const base = parse(row.body)
  if (!base || base.status === 'applied') return
  // Строки основы, посчитанные позже этой поправки, она не перекрывает (lineWins)
  const next = sheetView(base, [{ opId: '', lines: data?.lines, apply: data?.apply }])
  putDoc(db, 'inventory', next, { sync: row.sync, deviceId: row.deviceId ?? null })
}
