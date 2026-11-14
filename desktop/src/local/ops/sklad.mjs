// ── Склад магазина — и без связи (версия 1.8.0) ──
//
// Перенос серверного склада (server/src/sklad, договор SKLAD-CONTRACT). Склад — отдельный
// запас рядом с полкой: партии склада (sklad_batches) продажа, сроки, списание и пересчёт не
// видят. Здесь — то, что касса умеет со складом сама:
//   • список партий склада (GET /sklad) и журнал движений (GET /sklad/moves — docs, kind skladmove);
//   • перенос в магазин (POST /sklad/to-shop): со склада по партиям — ближайший срок первым, без
//     срока последними, при равных — заведённые раньше; на полку — обычными партиями с теми же
//     ценой и сроком, средняя закупочная товара — как от прихода (движение 'sklad-ship', stock.mjs);
//   • правка остатка склада (POST /sklad/edit): поставить остаток товара на складе = units.
// Приход на склад — обычный приход с place = 'sklad' (ops/arrival.mjs).
//
// Всё сделанное здесь записано журналом движений и операцией в очереди ('sklad.toShop',
// 'sklad.edit'): сервер, приняв её, сделает то же у себя, а свежий склад с сервера ляжет основой,
// поверх которой касса проиграет то, что сервер ещё не принял.
import { bodyOf, checker, expiryOk, MAX_MONEY, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { docByClientId, enqueue, putDoc } from '../docs.mjs'
import { D, fromCents, fromCentsD, toCents } from '../money.mjs'
import { move, productById, skladShort, skladUnitsOf } from '../stock.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'

const iso = (now) => new Date(now).toISOString()

// ── Партии склада — в том виде, в каком их отдаёт сервер ──
export function skladList(db) {
  return q(db, 'SELECT id, productId, units, costC, expiryDate, arrivalId, createdAt FROM sklad_batches WHERE units > 0 ORDER BY createdAt, id')
    .all()
    .map((b) => ({
      id: b.id,
      productId: b.productId,
      units: b.units,
      cost: fromCents(b.costC),
      expiryDate: b.expiryDate ?? null,
      arrivalId: b.arrivalId ?? null,
      createdAt: b.createdAt,
    }))
}

const noteOf = (note) => {
  const text = (note || '').trim()
  if (text.length > 500) throw bad('Примечание: не длиннее 500 символов')
  return text
}

// ── Перенос в магазин ──
export function skladToShop(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    units: c.int(it?.units, `items.${n}.units`, { min: 1 }),
  }))
  c.done()

  return inTx(db, () => {
    // Тот же запрос пришёл второй раз — второй раз не переносим
    if (clientId) {
      const already = docByClientId(db, 'skladmove', clientId)
      if (already) return already.body
    }
    const text = noteOf(note)
    // Один товар может стоять в списке дважды — считаем по товару целиком. Не хватает хоть
    // одного — не переносится ничего
    const want = new Map()
    for (const it of items) want.set(it.productId, (want.get(it.productId) || 0) + it.units)
    for (const [pid, units] of want) {
      const p = productById(db, pid)
      if (!p) throw bad('Товар не найден')
      unitsOk(units, 'Количество слишком велико. Проверьте количество.')
      const have = skladUnitsOf(db, pid)
      if (have < units) throw bad(skladShort(p.name, have))
    }

    const opId = newId()
    const lines = []
    let total = D(0)
    for (const [pid, units] of want) {
      const p = productById(db, pid)
      const r = move(db, { opId, productId: pid, kind: 'sklad-ship', units: -units }, { now })
      // Строки документа — что ушло в магазин: по частям, с ценой и сроком каждой
      for (const t of r.taken) {
        lines.push({ productId: pid, name: p.name, units: t.units, cost: fromCents(t.costC), expiryDate: t.expiryDate ?? null })
        total = total.plus(fromCentsD(t.costC).times(t.units).div(uppOf(p)))
      }
    }
    sumOk(total)
    const id = newId()
    const body = {
      id,
      // Ключ повтора: копия сервера (с тем же ключом) потом заменит документ кассы
      clientId: clientId || id,
      kind: 'toShop',
      date: iso(now),
      userId: ctx.user.id,
      note: text,
      items: lines,
      total: fromCents(toCents(total)),
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'skladmove', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'sklad.toShop',
      accountId: ctx.user.accountId,
      // Серверу — как POST /sklad/to-shop (договор) и номер документа кассы
      payload: { id, clientId: body.clientId, items: [...want].map(([productId, units]) => ({ productId, units })), note: text, date: body.date, deviceId: ctx.deviceId },
      now,
    })
    return body
  })
}

// ── Правка остатка склада ──
// units — сколько ШТУК товара должно стать на складе. Больше нынешнего — новая партия на
// разницу (цена — присланная за упаковку или нынешняя закупочная товара, срок — присланный);
// меньше — снимается по тем же правилам, что перенос
export function skladEdit(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  const productId = c.str(dto.productId, 'productId')
  const units = c.int(dto.units, 'units', { min: 0 })
  const cost = c.num(dto.cost, 'cost', { optional: true, max: MAX_MONEY })
  const expiryRaw = c.str(dto.expiryDate, 'expiryDate', { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  c.done()

  return inTx(db, () => {
    if (clientId) {
      const already = docByClientId(db, 'skladmove', clientId)
      if (already) return already.body
    }
    const text = noteOf(note)
    const p = productById(db, productId)
    if (!p) throw bad('Товар не найден')
    unitsOk(units, 'Количество слишком велико. Проверьте количество.')
    let expiryDate = null
    if (expiryRaw) {
      expiryDate = isoOrNull(expiryRaw)
      if (!expiryDate) throw bad('Срок годности: неверная дата')
      expiryOk(expiryDate)
    }
    const have = skladUnitsOf(db, productId)
    const diff = units - have
    if (diff === 0) throw bad('Остаток не изменился')

    const opId = newId()
    const upp = uppOf(p)
    let costC = p.costC
    if (diff > 0) {
      if (cost !== undefined) costC = toCents(D(cost))
      move(db, { opId, productId, kind: 'sklad-in', units: diff, costC, expiryDate }, { now })
    } else {
      const r = move(db, { opId, productId, kind: 'sklad-out', units: diff }, { now })
      // Цена убавки — средняя по снятым партиям (в документе — одна строка)
      const taken = r.taken.reduce((s, t) => s + t.units, 0)
      if (taken > 0) costC = toCents(r.taken.reduce((s, t) => s.plus(fromCentsD(t.costC).times(t.units)), D(0)).div(taken))
    }
    const total = fromCentsD(costC).times(Math.abs(diff)).div(upp)
    sumOk(total)
    const id = newId()
    const body = {
      id,
      clientId: clientId || id,
      kind: 'edit',
      date: iso(now),
      userId: ctx.user.id,
      note: text,
      items: [{ productId, name: p.name, units: diff, cost: fromCents(costC), expiryDate: diff > 0 ? expiryDate : null }],
      total: fromCents(toCents(total)),
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'skladmove', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'sklad.edit',
      accountId: ctx.user.accountId,
      payload: {
        id,
        clientId: body.clientId,
        productId,
        units,
        // Сколько стало по словам кассы и на сколько поменяли: сервер ставит остаток = units
        diff,
        ...(cost !== undefined ? { cost } : {}),
        ...(expiryDate ? { expiryDate } : {}),
        note: text,
        date: body.date,
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
