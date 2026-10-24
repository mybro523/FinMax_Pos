// ── Инвентаризация (пересчёт остатков) — и без связи ──
//
// Перенос серверной инвентаризации (server/src/inventory/inventory.service.ts): лист
// пересчёта заводится, считается, применяется и удаляется прямо на кассе — с теми же
// проверками и текстами, что на сайте. Листы, заведённые на сайте или другой кассе,
// приходят обменом (docs, kind = inventory) и считаются здесь так же.
//
// Как лежит лист. В docs — основа: копия сервера (или лист, каким его завели здесь или на
// соседней кассе, пока сервер его не знает). Насчитанное поверх неё — поправками по строкам
// (row_edits, tbl = 'doc:inventory', action = 'lines'): какие строки, сколько и когда
// насчитали. Лист, который видит окно, — основа и поверх неё неотправленные поправки: по
// каждой строке остаётся самое позднее по времени (как и у сервера). Так две кассы считают
// один лист одновременно и по сети друг другу не мешают: каждая шлёт только свои строки.
// Свежая копия сервера ложится основой всегда — поправки, которых он ещё не видел, лежат
// поверх неё до его ответа. Сервер отказал — поправка снимается, и лист сразу такой, как был.
//
// Применение — пересчёт на момент применения: остаток каждого посчитанного товара
// становится насчитанным (движение 'count', как у правки остатка в карточке). Сервер,
// получив применение позже, сделает то же на этот момент и прибавит всё, что случилось с
// товаром после него (продажи других касс). Недостачу оформит списанием сервер — оно
// придёт обменом вместе с листом. Удаление — поправка «удалён здесь» (action = 'del').
import { bodyOf, checker, MAX_UNITS } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { enqueue, listDocs, liveDoc, putDoc } from '../docs.mjs'
import { recordEdit } from '../edits.mjs'
import { lineWins, pendingEdits, settle, SHEET_TBL, sheetView } from '../sheet.mjs'
import { fromCents } from '../money.mjs'
import { allUnits, move, productById, unitsOf } from '../stock.mjs'

// Тексты — слово в слово как у сервера
export const SHEET_NOT_FOUND = 'Лист не найден'
export const SHEET_APPLIED = 'Этот пересчёт уже применён'
export const SHEET_APPLIED_NO_DELETE = 'Применённый пересчёт удалять нельзя — это история'
export const NO_PRODUCTS_IN_SCOPE = 'В этой категории нет товаров'
// Сколько строк насчитанного в одном запросе — как у сервера
const MAX_COUNT_LINES = 20000
// Лист, заведённый без связи, уходит на сервер и соседним кассам одной записью. На склад
// больше этого — по категориям
export const MAX_OFFLINE_LINES = 10000
export const TOO_MANY_LINES = `Без интернета в одном листе — не больше ${MAX_OFFLINE_LINES} товаров. Пересчитайте по категориям.`
export const TOO_MANY_COUNTS = `В одном применении — не больше ${MAX_COUNT_LINES} строк. Сохраните черновик и примените лист ещё раз.`

const iso = (now) => new Date(now).toISOString()
const ref = (id) => ({ kind: 'inventory', id })
const TBL = SHEET_TBL

// Своя операция или соседней кассы: свои лежат в очереди на отправку
const ownOp = (db, opId) => !!q(db, 'SELECT 1 FROM outbox WHERE id = ?').get(opId)

// ── Листы: незаконченные и применённые за срок журналов, свежие сверху ──
export function inventoriesList(db) {
  const all = listDocs(db, 'inventory')
  const edits = pendingEdits(db)
  return edits.size ? all.map((s) => (edits.has(s.id) ? sheetView(s, edits.get(s.id)) : s)) : all
}

// Один лист. Нет на кассе — null (давний: за ним идут на сервер)
export function inventoryOne(db, id) {
  const doc = liveDoc(db, 'inventory', id)
  return doc ? sheetView(doc.body, pendingEdits(db, id).get(id)) : null
}

// ── Завести лист: все товары или одна категория ──
// «По учёту» — что лежит на полке этой кассы сейчас
export function createInventory(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const scopeAsked = c.str(dto.scope, 'scope', { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  c.done()
  const scope = (scopeAsked || 'all').trim() || 'all'
  if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

  return inTx(db, () => {
    // Товары, которые завела соседняя касса и сервер ещё не знает, в лист не берём: лист со
    // ссылкой на них ждал бы в очереди соседа — а с ним и всё, что сделано здесь после
    const peerMade = new Set(
      q(
        db,
        `SELECT DISTINCT e.rowId AS id FROM row_edits e JOIN lan_log l ON l.id = e.opId
         WHERE e.tbl = 'products' AND e.synced = 0 AND e.action = 'put' AND json_extract(e.data, '$.row') IS NOT NULL
           AND l.kind = 'op' AND l.state = 'applied'`,
      )
        .all()
        .map((r) => r.id),
    )
    const products = (
      scope === 'all' ? q(db, 'SELECT * FROM products ORDER BY ord, name').all() : q(db, 'SELECT * FROM products WHERE category = ? ORDER BY ord, name').all(scope)
    ).filter((p) => !peerMade.has(p.id))
    if (!products.length) throw bad(NO_PRODUCTS_IN_SCOPE)
    // Склад больше, чем лист без связи: с интернетом лист заведёт сервер, без него — отказ
    // этими словами (шлюз, __remote)
    if (products.length > MAX_OFFLINE_LINES) return { __remote: true, __offline: TOO_MANY_LINES }
    const units = allUnits(db, now)
    const id = newId()
    const date = iso(now)
    const body = {
      id,
      date,
      userId: ctx.user.id ?? null,
      user: { id: ctx.user.id ?? null, name: ctx.user.name || '' },
      status: 'draft',
      scope,
      note: (note || '').trim(),
      appliedAt: null,
      items: products.map((p) => ({
        id: newId(),
        inventoryId: id,
        productId: p.id,
        name: p.name,
        expectedUnits: Number(units.get(p.id)?.units || 0),
        actualUnits: null,
        cost: fromCents(p.costC || 0),
      })),
    }
    putDoc(db, 'inventory', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: newId(),
      type: 'inventory.create',
      accountId: ctx.user.accountId,
      payload: {
        inventory: {
          id,
          scope,
          note: body.note,
          date,
          items: body.items.map((it) => ({ id: it.id, productId: it.productId, name: it.name, expectedUnits: it.expectedUnits, cost: it.cost, actualUnits: null })),
        },
      },
      now,
    })
    return body
  })
}

// Насчитанное из запроса: строка листа → сколько (пусто — «ещё не считали»)
function readCounts(raw, { optional = false } = {}) {
  const dto = bodyOf(raw)
  const c = checker()
  const list = dto.items === undefined && optional ? [] : c.list(dto.items, 'items', { min: optional ? 0 : 1, max: MAX_COUNT_LINES })
  const items = list.map((it, n) => ({
    id: c.str(it?.id, `items.${n}.id`),
    actualUnits: it?.actualUnits === null || it?.actualUnits === undefined || it?.actualUnits === '' ? null : c.int(it.actualUnits, `items.${n}.actualUnits`, { max: MAX_UNITS }),
  }))
  c.done()
  return items
}

// Какие строки из присланных действительно меняют лист (чужие и повторы — мимо)
function changedOf(view, items) {
  const byId = new Map(view.items.map((it) => [it.id, it]))
  const seen = new Map()
  for (const it of items) {
    const line = byId.get(it.id)
    if (!line) continue
    seen.set(it.id, it.actualUnits)
  }
  const out = []
  for (const [id, units] of seen) if ((byId.get(id).actualUnits ?? null) !== units) out.push({ id, actualUnits: units })
  return out
}

// Лист для правки: есть здесь и ещё не применён
function openSheet(db, id) {
  const doc = liveDoc(db, 'inventory', id)
  if (!doc) throw bad(SHEET_NOT_FOUND)
  const edits = pendingEdits(db, id).get(id) || []
  const view = sheetView(doc.body, edits)
  if (view.status === 'applied') throw bad(SHEET_APPLIED)
  return { base: doc.body, edits, view }
}

// ── Сохранить насчитанное (черновик) ──
// Окно присылает только изменённые строки; лист возвращается целиком
export function saveCounts(ctx, id, raw) {
  const { db, now } = ctx
  const items = readCounts(raw)
  return inTx(db, () => {
    const { base, edits, view } = openSheet(db, id)
    const changed = changedOf(view, items)
    if (!changed.length) return view
    const opId = newId()
    const at = iso(now)
    const lines = changed.map((it) => ({ ...it, at }))
    recordEdit(db, { opId, tbl: TBL, rowId: id, action: 'lines', data: { lines }, now })
    enqueue(db, { id: opId, type: 'inventory.count', accountId: ctx.user.accountId, payload: { id, at, items: changed, ref: ref(id) }, now })
    return sheetView(base, [...edits, { opId, lines }])
  })
}

// ── Применить ──
// Насчитанное, присланное вместе с просьбой применить, ложится в лист той же поправкой.
// Строки, насчитанные на соседней кассе (её пересчёт уходит на сервер с той кассы и может
// дойти позже), едут вместе с применением — со своим моментом: иначе сервер применил бы лист
// без них, а здесь остаток уже выставлен и по ним
export function applyInventory(ctx, id, raw) {
  const { db, now } = ctx
  const items = readCounts(raw, { optional: true })
  return inTx(db, () => {
    const { base, edits, view } = openSheet(db, id)
    const changed = changedOf(view, items)
    const opId = newId()
    const at = iso(now)
    const typed = changed.map((it) => ({ ...it, at }))
    const typedIds = new Set(typed.map((l) => l.id))
    const baseLines = new Map(base.items.map((it) => [it.id, it]))
    const peer = []
    for (const [lineId, l] of settle(edits).lines) {
      if (typedIds.has(lineId) || ownOp(db, l.opId) || !baseLines.has(lineId)) continue
      // Пересчёт соседа старше того, что уже в основе листа, — не в счёт
      if (!lineWins(l, baseLines.get(lineId))) continue
      peer.push({ id: lineId, actualUnits: l.actualUnits, at: l.at })
    }
    if (changed.length + peer.length > MAX_COUNT_LINES) throw bad(TOO_MANY_COUNTS)

    // Остаток каждого посчитанного товара — насчитанный. Две строки одного товара бывают,
    // когда на сайте объединили две карточки, — насчитанное по ним складывается (как у сервера)
    const counted = sheetView(base, [...edits, { opId, lines: typed }])
    const byProduct = new Map()
    for (const it of counted.items) {
      if (it.actualUnits === null || it.actualUnits === undefined || !it.productId) continue
      const cur = byProduct.get(it.productId)
      if (cur) cur.units += it.actualUnits
      else byProduct.set(it.productId, { units: it.actualUnits, line: it })
    }
    // «По учёту» — что было на полке в момент применения (для истории, как у сервера);
    // запоминается только то, что разошлось с листом
    const expected = []
    for (const [productId, c] of byProduct) {
      const p = productById(db, productId)
      if (!p) continue
      const have = unitsOf(db, p.id, now).units
      if (have !== c.units) {
        move(db, { opId, productId: p.id, kind: 'count', units: c.units - have, costC: p.costC, expiryDate: p.expiryDate ?? null, note: 'Пересчёт' }, { now })
      }
      if (c.line.expectedUnits !== have) expected.push({ id: c.line.id, units: have })
    }
    const apply = { at, expected }
    // Строки соседа — в поправку применения тоже: когда сервер его примет, лист останется
    // таким, каким его применили, а не потеряет их до своей следующей копии
    const lines = [...typed, ...peer]
    recordEdit(db, { opId, tbl: TBL, rowId: id, action: 'lines', data: { lines, apply }, now })
    enqueue(db, { id: opId, type: 'inventory.apply', accountId: ctx.user.accountId, payload: { id, at, items: [...changed, ...peer], ref: ref(id) }, now })
    return sheetView(base, [...edits, { opId, lines, apply }])
  })
}

// ── Удалить незаконченный лист ──
export function deleteInventory(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'inventory', id)
    if (!doc) throw bad(SHEET_NOT_FOUND)
    if (sheetView(doc.body, pendingEdits(db, id).get(id)).status === 'applied') throw bad(SHEET_APPLIED_NO_DELETE)
    const opId = newId()
    recordEdit(db, { opId, tbl: TBL, rowId: id, action: 'del', data: {}, now })
    enqueue(db, { id: opId, type: 'inventory.delete', accountId: ctx.user.accountId, payload: { id, at: iso(now), ref: ref(id) }, now })
    return { ok: true }
  })
}
