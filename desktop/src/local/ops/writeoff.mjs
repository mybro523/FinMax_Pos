// ── Списание ──
//
// Перенос серверного списания (server/src/writeoffs/writeoffs.service.ts).
// Просрочка, брак, порча, недостача: остаток уменьшается (первой уходит партия
// с ближайшим сроком — в том числе просроченная, ради неё списание и делают),
// а убыток записывается по закупочной цене из карточки товара.
import { bodyOf, checker, sumOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { enqueue, putDoc } from '../docs.mjs'
import { D, fromCents, fromCentsD, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { uppOf, wholeNonNeg } from '../units.mjs'

export function createWriteOff(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const reason = c.oneOf(dto.reason, 'reason', ['expired', 'damaged', 'lost', 'other'], { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    units: c.int(it?.units, `items.${n}.units`, { min: 1 }),
  }))
  c.done()

  return inTx(db, () => {
    const writeOffId = newId()
    const opId = newId()
    let totalCost = D(0)
    const rows = []

    for (const it of items) {
      const product = productById(db, it.productId)
      if (!product) throw bad('Товар не найден')
      const units = wholeNonNeg(it.units)
      if (units <= 0) continue

      const { taken } = move(db, { opId, productId: product.id, kind: 'writeoff', units: -units }, { now })
      const upp = uppOf(product)

      // Убыток считается по закупочной цене из карточки — той самой, что видна
      // владельцу во всех отчётах. Срок берётся у партии: он для истории.
      for (const t of taken) {
        totalCost = totalCost.plus(fromCentsD(product.costC).dividedBy(upp).times(t.units))
        rows.push({
          id: newId(),
          writeOffId,
          productId: product.id,
          name: product.name,
          units: t.units,
          cost: fromCents(product.costC),
          expiryDate: t.expiryDate,
        })
      }
    }

    if (!rows.length) throw bad('Укажите количество для списания')
    sumOk(totalCost)

    const body = {
      id: writeOffId,
      date: new Date(now).toISOString(),
      userId: ctx.user.id,
      reason: reason || 'expired',
      note: note || '',
      totalCost: fromCents(toCents(totalCost)),
      source: 'manual',
      items: rows,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'writeoff', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'writeoff',
      accountId: ctx.user.accountId,
      payload: {
        writeOff: body,
        // Серверу — что списать: по каким партиям это разойдётся, он решит сам
        ask: items.map((it) => ({ productId: it.productId, units: wholeNonNeg(it.units) })).filter((it) => it.units > 0),
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
