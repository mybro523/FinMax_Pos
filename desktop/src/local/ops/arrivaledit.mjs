// ── Правка и удаление прихода — и без связи ──
//
// Перенос серверной правки (server/src/arrivals/arrivals.service.ts, updateArrivalIn и
// removeArrivalIn). Приход — не запись в журнале, а уже случившееся движение: он положил
// на полку партии, поднял остаток и сдвинул среднюю закупочную цену. Поэтому правка
// переделывает движение целиком (движение 'arrival-edit', stock.mjs): всё, что от прихода
// осталось на полке, снимается, и раскладывается заново новое количество за вычетом
// проданного; закупочная цена — заново по партиям на полке. Сколько продано, движение
// считает само, по партиям той кассы, где оно ложится: на соседней кассе из того же прихода
// могли продать то, чего эта касса ещё не видела. Удаление ('arrival-undo') снимает с полки
// всё, что от прихода осталось.
//
// Ниже проданного количество опускать нельзя: этих упаковок физически нет на полке.
import { bodyOf, checker, expiryOk, MAX_MONEY, MAX_UPP, sumOk } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { enqueue, liveDoc } from '../docs.mjs'
import { ADJ, adjMove, recordDocEdit, serverKnows } from '../edits.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { costCInPack, isDrob, KG, lineUpp } from '../piece.mjs'
import { move, productById } from '../stock.mjs'
import { supplierRow } from '../suppliers.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'

const at = (now) => new Date(now).toISOString()
const unitsOfLine = (it, upp) => (it.qty || 0) * upp + Math.max(0, Math.trunc(it.pieces || 0))

// Партии прихода на полке этой кассы — серверные и заведённые здесь. У прихода на склад
// (1.8.0) — его партии на складе
const batchesOf = (db, arrivalId, place = 'shop') =>
  q(db, `SELECT productId, units, expiryDate FROM ${place === 'sklad' ? 'sklad_batches' : 'batches'} WHERE arrivalId = ?`).all(arrivalId)

// ── Приход на склад (1.8.0) ── Не правится: удаляют и проводят заново (как у сервера)
export const SKLAD_ARRIVAL_EDIT = 'Приход на склад не правится — удалите его и проведите заново'
export const SKLAD_ARRIVAL_GONE = 'Часть товара этого прихода уже ушла со склада — удалить приход нельзя'
const isSklad = (a) => a?.place === 'sklad'

// ── Один приход для окна правки ──
// Как у сервера (findOne): сколько от каждой строки ещё лежит на полке, сколько уже
// продано и ниже чего нельзя опускать количество. Прихода на кассе нет — null (давний:
// за ним идут на сервер)
export function arrivalView(db, id) {
  const doc = liveDoc(db, 'arrival', id)
  if (!doc) return null
  const a = doc.body
  const batches = batchesOf(db, id, a.place)
  const left = new Map()
  const expiry = new Map()
  for (const b of batches) {
    left.set(b.productId, (left.get(b.productId) || 0) + b.units)
    const was = expiry.get(b.productId)
    if (was === undefined || (b.expiryDate && was && b.expiryDate < was)) expiry.set(b.productId, b.expiryDate)
  }
  const brought = new Map()
  const lines = new Map()
  for (const it of a.items || []) {
    if (!it.productId) continue
    const p = productById(db, it.productId)
    // Упаковка — снимком строки (1.5.12): товару могли сменить её после прихода. У строки без
    // снимка (её записала касса прежней версии) — как у сервера: весовой — килограммами
    brought.set(it.productId, (brought.get(it.productId) || 0) + unitsOfLine(it, it.unitsPerPack || lineUpp({}, p || {})))
    lines.set(it.productId, (lines.get(it.productId) || 0) + 1)
  }
  return {
    ...a,
    items: (a.items || []).map((it) => {
      const p = it.productId ? productById(db, it.productId) : null
      const upp = it.unitsPerPack || lineUpp({}, p || {})
      const soldUnits = it.productId ? Math.max(0, (brought.get(it.productId) || 0) - (left.get(it.productId) || 0)) : 0
      const exp = it.productId ? expiry.get(it.productId) : null
      return {
        ...it,
        unitsPerPack: upp,
        expiryDate: exp ? String(exp).slice(0, 10) : '',
        exists: !!p,
        soldUnits,
        minQty: (lines.get(it.productId || '') || 0) > 1 ? 0 : Math.ceil(soldUnits / upp),
      }
    }),
  }
}

export function updateArrival(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const supplier = c.str(dto.supplier, 'supplier', { optional: true })
  const supplierIdAsked = c.str(dto.supplierId, 'supplierId', { optional: true })
  const debtAsked = c.num(dto.debt, 'debt', { optional: true, max: MAX_MONEY })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    id: c.str(it?.id, `items.${n}.id`),
    qty: c.int(it?.qty, `items.${n}.qty`, { min: 0 }),
    pieces: it?.pieces === undefined || it?.pieces === null ? 0 : c.int(it.pieces, `items.${n}.pieces`, { min: 0, max: MAX_UPP }),
    cost: c.num(it?.cost, `items.${n}.cost`, { max: MAX_MONEY }),
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
    // Упаковка, по которой окно считало строку (1.5.12) — снимок строки прихода
    unitsPerPack: it?.unitsPerPack === undefined || it?.unitsPerPack === null ? undefined : c.int(it.unitsPerPack, `items.${n}.unitsPerPack`, { min: 1, max: MAX_UPP }),
  }))
  c.done()

  return inTx(db, () => {
    const doc = liveDoc(db, 'arrival', id)
    if (!doc) throw bad('Приход не найден')
    const a = doc.body
    if (isSklad(a)) throw bad(SKLAD_ARRIVAL_EDIT)
    const byLineId = new Map((a.items || []).map((i) => [i.id, i]))
    const lines = items.filter((l) => byLineId.has(l.id))
    if (!lines.length) throw bad('Строки прихода не найдены')
    if (!lines.some((l) => l.qty > 0 || l.pieces > 0)) throw bad('В приходе не осталось ни одной позиции. Чтобы убрать его целиком, удалите приход.')
    const expiryOf = lines.map((l) => {
      if (!l.expiryDate) return null
      const iso = isoOrNull(l.expiryDate)
      if (!iso) throw bad('Срок годности: неверная дата')
      expiryOk(iso)
      return iso
    })
    // Упаковка каждой строки правки — как окно её считало (снимок строки), у строки без
    // снимка — как у сервера (lineUpp): дробный — килограммами, остальные — по карточке
    const inUpp = new Map(lines.map((l) => {
      const it = byLineId.get(l.id)
      return [l.id, l.unitsPerPack || it.unitsPerPack || lineUpp({}, it.productId ? productById(db, it.productId) || {} : {})]
    }))
    const wanted = new Map(lines.map((l, n) => [l.id, { ...l, expiry: expiryOf[n] }]))
    const opId = newId()
    const ids = [...new Set((a.items || []).map((i) => i.productId).filter(Boolean))]
    const batches = batchesOf(db, id)
    for (const pid of ids) {
      const p = productById(db, pid)
      if (!p) continue
      const upp = uppOf(p)
      const mine = a.items.filter((i) => i.productId === pid)
      // Было — по упаковке, с которой строку записали (1.5.12); без снимка — как у сервера
      const brought = mine.reduce((s, i) => s + unitsOfLine(i, i.unitsPerPack || lineUpp({}, p)), 0)
      const mineBatches = batches.filter((b) => b.productId === pid)
      const left = mineBatches.reduce((s, b) => s + b.units, 0)
      const sold = Math.max(0, brought - left)
      const newLines = mine.map((i) => wanted.get(i.id)).filter(Boolean)
      const want = newLines.reduce((s, l) => s + unitsOfLine(l, inUpp.get(l.id)), 0)
      if (want < sold) {
        const skolko = isDrob(p.unit) ? `${sold / KG} ${String(p.unit).trim()}` : `${sold} шт (${Math.ceil(sold / upp)} уп)`
        throw bad(`«${p.name}»: из этого прихода уже продано ${skolko}. Меньше проданного поставить нельзя — этого товара на полке уже нет.`)
      }
      // Пустой срок в правке — «оставить как было»: стереть срок случайно нельзя
      let prevExpiry
      for (const b of mineBatches) if (prevExpiry === undefined || (b.expiryDate && prevExpiry && b.expiryDate < prevExpiry)) prevExpiry = b.expiryDate
      // Сколько было в приходе (b) и строки, какими он стал: штуки, цена упаковки, срок
      // Цена — за упаковку ТОВАРА: строка, посчитанная в другой упаковке, переводится
      const spec = { b: brought, l: newLines.map((l) => [unitsOfLine(l, inUpp.get(l.id)), costCInPack(toCents(l.cost), inUpp.get(l.id), upp), l.expiry ?? prevExpiry ?? null]) }
      move(db, { opId, productId: pid, kind: 'arrival-edit', units: want, arrivalId: id, note: JSON.stringify(spec) }, { now })
    }

    // Сами строки: убранные удаляем, остальные переписываем
    const nextItems = []
    for (const it of a.items || []) {
      const l = wanted.get(it.id)
      if (!l || unitsOfLine(l, inUpp.get(l.id)) <= 0) continue
      nextItems.push({ ...it, qty: l.qty, pieces: l.pieces, unitsPerPack: inUpp.get(l.id), cost: fromCents(toCents(l.cost)) })
    }
    let total = D(0)
    for (const l of lines) {
      const upp = inUpp.get(l.id)
      const units = unitsOfLine(l, upp)
      if (units > 0) total = total.plus(D(l.cost).times(D(units).div(upp)))
    }
    sumOk(total)
    total = D(fromCents(toCents(total)))

    // Поставщик и долг — как у сервера: прежняя неоплаченная часть снимается с прежнего
    // поставщика, новая ложится на нового (это может быть тот же)
    const nextSupplierId = supplierIdAsked === undefined ? a.supplierId : supplierIdAsked || null
    const sup = nextSupplierId ? supplierRow(db, nextSupplierId) : null
    if (nextSupplierId && !sup) throw bad('Поставщик не найден')
    const asked = debtAsked === undefined ? a.debt : debtAsked
    const debt = sup ? fromCents(toCents(D(Math.max(0, Number(asked) || 0)).gt(total) ? total : D(Math.max(0, Number(asked) || 0)))) : 0
    const next = {
      ...a,
      supplier: sup?.name || (supplierIdAsked === '' ? (supplier || '').trim() || '—' : (supplier || '').trim() || a.supplier),
      supplierId: sup?.id ?? null,
      debt,
      total: total.toNumber(),
      items: nextItems,
    }
    const was = recordDocEdit(db, { opId, kind: 'arrival', body: next, now })
    if (serverKnows(was)) {
      if (a.supplierId && Number(a.debt) > 0) adjMove(db, { opId, target: ADJ.supplierDebt, rowId: a.supplierId, deltaC: -toCents(a.debt), now })
      if (next.supplierId && debt > 0) adjMove(db, { opId, target: ADJ.supplierDebt, rowId: next.supplierId, deltaC: toCents(debt), now })
    }
    enqueue(db, {
      id: opId,
      type: 'arrival.update',
      accountId: ctx.user.accountId,
      payload: {
        at: at(now),
        arrival: {
          id,
          ...(supplier !== undefined ? { supplier } : {}),
          ...(supplierIdAsked !== undefined ? { supplierId: supplierIdAsked, debt: debtAsked ?? 0 } : debtAsked !== undefined ? { debt: debtAsked } : {}),
          items: lines.map((l, n) => ({ id: l.id, qty: l.qty, pieces: l.pieces, unitsPerPack: inUpp.get(l.id), cost: l.cost, ...(expiryOf[n] ? { expiryDate: expiryOf[n] } : {}) })),
        },
        ref: { kind: 'arrival', id },
      },
      now,
    })
    return next
  })
}

// ── Удалить приход ──
// Снимает с полки всё, что от него ещё осталось; проданное не трогаем
export function deleteArrival(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const doc = liveDoc(db, 'arrival', id)
    if (!doc) throw bad('Приход не найден')
    const a = doc.body
    const opId = newId()
    const pids = [...new Set((a.items || []).map((i) => i.productId).filter(Boolean))]
    if (isSklad(a)) {
      // Приход на склад удаляется, только пока его товар целиком лежит на складе: перенесённое
      // в магазин уже на полке и в средней закупочной
      const left = new Map()
      for (const b of batchesOf(db, id, 'sklad')) left.set(b.productId, (left.get(b.productId) || 0) + b.units)
      for (const pid of pids) {
        const p = productById(db, pid)
        if (!p) continue
        const brought = a.items.filter((i) => i.productId === pid).reduce((s, i) => s + unitsOfLine(i, i.unitsPerPack || lineUpp({}, p)), 0)
        if ((left.get(pid) || 0) < brought) throw bad(SKLAD_ARRIVAL_GONE)
      }
      for (const pid of pids) {
        if (productById(db, pid)) move(db, { opId, productId: pid, kind: 'sklad-undo', units: 0, arrivalId: id }, { now })
      }
    } else {
      for (const pid of pids) {
        if (productById(db, pid)) move(db, { opId, productId: pid, kind: 'arrival-undo', units: 0, arrivalId: id }, { now })
      }
    }
    const was = recordDocEdit(db, { opId, kind: 'arrival', body: a, del: true, now })
    // Неоплаченная часть удалённого прихода долгом больше не числится. У заведённого здесь
    // и не отправленного долг и так шёл из самого прихода — удалённый в него не входит
    if (serverKnows(was) && a.supplierId && Number(a.debt) > 0) adjMove(db, { opId, target: ADJ.supplierDebt, rowId: a.supplierId, deltaC: -toCents(a.debt), now })
    // Деньги, взятые из ящика на этот приход, остаются отданными: сервер, приняв приход,
    // запишет оплату, а удаление прихода её не отменяет. Пока заведение ждёт отправки, они
    // числятся за сменой и у удалённого здесь прихода (edits.mjs, unsentPaidCash)
    enqueue(db, { id: opId, type: 'arrival.delete', accountId: ctx.user.accountId, payload: { id, at: at(now), ref: { kind: 'arrival', id } }, now })
    return { ok: true }
  })
}
