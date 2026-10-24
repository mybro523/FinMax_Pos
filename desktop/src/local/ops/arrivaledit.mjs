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
import { bodyOf, checker, expiryOk, MAX_MONEY, sumOk } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { enqueue, liveDoc } from '../docs.mjs'
import { ADJ, adjMove, recordDocEdit, serverKnows } from '../edits.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { supplierRow } from '../suppliers.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'

const at = (now) => new Date(now).toISOString()
const unitsOfLine = (it, upp) => (it.qty || 0) * upp + Math.max(0, Math.trunc(it.pieces || 0))

// Партии прихода на полке этой кассы — серверные и заведённые здесь
const batchesOf = (db, arrivalId) => q(db, 'SELECT productId, units, expiryDate FROM batches WHERE arrivalId = ?').all(arrivalId)

// ── Один приход для окна правки ──
// Как у сервера (findOne): сколько от каждой строки ещё лежит на полке, сколько уже
// продано и ниже чего нельзя опускать количество. Прихода на кассе нет — null (давний:
// за ним идут на сервер)
export function arrivalView(db, id) {
  const doc = liveDoc(db, 'arrival', id)
  if (!doc) return null
  const a = doc.body
  const batches = batchesOf(db, id)
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
    brought.set(it.productId, (brought.get(it.productId) || 0) + unitsOfLine(it, uppOf(p || {})))
    lines.set(it.productId, (lines.get(it.productId) || 0) + 1)
  }
  return {
    ...a,
    items: (a.items || []).map((it) => {
      const p = it.productId ? productById(db, it.productId) : null
      const upp = uppOf(p || {})
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
    pieces: it?.pieces === undefined || it?.pieces === null ? 0 : c.int(it.pieces, `items.${n}.pieces`, { min: 0, max: 99999 }),
    cost: c.num(it?.cost, `items.${n}.cost`, { max: MAX_MONEY }),
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
  }))
  c.done()

  return inTx(db, () => {
    const doc = liveDoc(db, 'arrival', id)
    if (!doc) throw bad('Приход не найден')
    const a = doc.body
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
    const wanted = new Map(lines.map((l, n) => [l.id, { ...l, expiry: expiryOf[n] }]))
    const opId = newId()
    const ids = [...new Set((a.items || []).map((i) => i.productId).filter(Boolean))]
    const batches = batchesOf(db, id)
    for (const pid of ids) {
      const p = productById(db, pid)
      if (!p) continue
      const upp = uppOf(p)
      const mine = a.items.filter((i) => i.productId === pid)
      const brought = mine.reduce((s, i) => s + unitsOfLine(i, upp), 0)
      const mineBatches = batches.filter((b) => b.productId === pid)
      const left = mineBatches.reduce((s, b) => s + b.units, 0)
      const sold = Math.max(0, brought - left)
      const newLines = mine.map((i) => wanted.get(i.id)).filter(Boolean)
      const want = newLines.reduce((s, l) => s + unitsOfLine(l, upp), 0)
      if (want < sold) {
        const skolko = p.unit === 'кг' ? `${sold / 1000} кг` : `${sold} шт (${Math.ceil(sold / upp)} уп)`
        throw bad(`«${p.name}»: из этого прихода уже продано ${skolko}. Меньше проданного поставить нельзя — этого товара на полке уже нет.`)
      }
      // Пустой срок в правке — «оставить как было»: стереть срок случайно нельзя
      let prevExpiry
      for (const b of mineBatches) if (prevExpiry === undefined || (b.expiryDate && prevExpiry && b.expiryDate < prevExpiry)) prevExpiry = b.expiryDate
      // Сколько было в приходе (b) и строки, какими он стал: штуки, цена упаковки, срок
      const spec = { b: brought, l: newLines.map((l) => [unitsOfLine(l, upp), toCents(l.cost), l.expiry ?? prevExpiry ?? null]) }
      move(db, { opId, productId: pid, kind: 'arrival-edit', units: want, arrivalId: id, note: JSON.stringify(spec) }, { now })
    }

    // Сами строки: убранные удаляем, остальные переписываем
    const nextItems = []
    for (const it of a.items || []) {
      const l = wanted.get(it.id)
      const p = it.productId ? productById(db, it.productId) : null
      if (!l || unitsOfLine(l, uppOf(p || {})) <= 0) continue
      nextItems.push({ ...it, qty: l.qty, pieces: l.pieces, cost: fromCents(toCents(l.cost)) })
    }
    let total = D(0)
    for (const l of lines) {
      const it = byLineId.get(l.id)
      const upp = uppOf(productById(db, it.productId) || {})
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
          items: lines.map((l, n) => ({ id: l.id, qty: l.qty, pieces: l.pieces, cost: l.cost, ...(expiryOf[n] ? { expiryDate: expiryOf[n] } : {}) })),
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
    for (const pid of [...new Set((a.items || []).map((i) => i.productId).filter(Boolean))]) {
      if (productById(db, pid)) move(db, { opId, productId: pid, kind: 'arrival-undo', units: 0, arrivalId: id }, { now })
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
