// ── Возврат товара поставщику ──
//
// Перенос серверного возврата (server/src/supplier-returns/supplier-returns.service.ts,
// только оформление: удалить возврат можно только через сервер). Товар уходит со склада
// из партий с ближайшим сроком — просроченный тоже: его чаще всего и отдают назад.
// Деньги поставщик возвращает одним из способов: в счёт долга (долг уменьшается — не
// больше, чем он есть), в кассу (наличные в ящик открытой смены этой кассы), наличными
// мимо кассы, на карту.
//
// Закупочная цена в карточке не меняется — как при списании и продаже: уходят штуки,
// средняя цена оставшегося считается той же.
import { bodyOf, checker, MAX_MONEY, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { docsOfShift, enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, fixed2, fromCents, fromCentsD, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { pendingDebtOf, supplierRow } from '../suppliers.mjs'
import { uppOf } from '../units.mjs'

export const REFUNDS = ['debt', 'cash', 'own', 'card']

// Тексты — слово в слово как у сервера: человек читает их с экрана, и откуда пришёл
// ответ, он знать не должен
export const NO_TILL_FOR_REFUND = 'Нет открытой смены — положить деньги в кассу некуда.'
// Долг поставщика сервер присылает только тем, кому видны долги. Не прислал — касса
// не знает, хватит ли долга, а уйти в минус без проверки возврат не должен
export const DEBT_UNKNOWN = 'Долг этому поставщику на кассе неизвестен — выберите, как поставщик вернул деньги.'

export function createSupplierReturn(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const supplierId = c.str(dto.supplierId, 'supplierId', { min: 1 })
  const refund = c.oneOf(dto.refund, 'refund', REFUNDS)
  const note = c.str(dto.note, 'note', { optional: true })
  // Смену окно называет по списку касс (/shifts/cash-sources), а здесь он один — эта
  // касса. Поле принимаем, но деньги кладём в ящик своей открытой смены
  c.str(dto.shiftId, 'shiftId', { optional: true })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    // Целые упаковки (у весового товара — килограммы); ноль допустим при pieces > 0
    qty: c.int(it?.qty, `items.${n}.qty`, { min: 0 }),
    // Штуки (граммы) сверх целых упаковок
    pieces: it?.pieces === undefined || it?.pieces === null ? 0 : c.int(it.pieces, `items.${n}.pieces`, { min: 0, max: 99999 }),
    // Цена возврата за упаковку (килограмм) — как договорились с поставщиком
    price: c.num(it?.price, `items.${n}.price`, { max: MAX_MONEY }),
  }))
  c.done()
  if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

  return inTx(db, () => {
    const byId = new Map()
    let total = D(0)
    const lines = items.map((it) => {
      if (!byId.has(it.productId)) byId.set(it.productId, productById(db, it.productId))
      const p = byId.get(it.productId)
      if (!p) throw bad('Товар не найден')
      const upp = uppOf(p)
      const units = it.qty * upp + it.pieces
      if (units <= 0) throw bad(`Укажите количество: ${p.name}`)
      unitsOk(units)
      // Цена — за упаковку (за килограмм): штуки и граммы оплачиваются долей
      total = total.plus(D(it.price).times(D(units).div(upp)))
      return { p, units, qty: it.qty, pieces: it.pieces, price: D(it.price) }
    })
    sumOk(total)
    const totalC = toCents(total)

    const sup = supplierRow(db, supplierId)
    if (!sup) throw bad('Поставщик не найден')
    if (refund === 'debt') {
      if (sup.sDebtC === null || sup.sDebtC === undefined) throw bad(DEBT_UNKNOWN)
      // Долг — как его знает касса: по словам сервера и со своими неотправленными
      // приходами и возвратами
      const debt = fromCentsD(sup.sDebtC).plus(pendingDebtOf(db, sup.id))
      if (debt.plus(D('0.005')).lt(fromCentsD(totalC))) {
        throw bad(`Долг поставщику (${fixed2(debt)}) меньше суммы возврата (${fixed2(fromCentsD(totalC))}) — выберите, как поставщик вернул деньги`)
      }
    }
    let shiftId = null
    if (refund === 'cash') {
      const open = myOpenShift(db, ctx.deviceId)
      if (!open) throw bad(NO_TILL_FOR_REFUND)
      shiftId = open.body.id
    }

    const returnId = newId()
    const opId = newId()
    const at = new Date(now).toISOString()
    // Первой уходит партия с ближайшим сроком — в том числе просроченная. Товара
    // меньше, чем отдаём, — отказ теми же словами, что у сервера
    const rows = lines.map((l) => {
      const { taken } = move(db, { opId, productId: l.p.id, kind: 'supreturn', units: -l.units }, { now })
      return {
        id: newId(),
        returnId,
        productId: l.p.id,
        name: l.p.name,
        qty: l.qty,
        pieces: l.pieces,
        price: fromCents(toCents(l.price)),
        cost: fromCents(l.p.costC),
        batches: taken.map((t) => ({ units: t.units, cost: String(fromCents(t.costC)), expiryDate: t.expiryDate ?? null })),
      }
    })

    const body = {
      id: returnId,
      date: at,
      supplierId: sup.id,
      supplier: sup.name,
      total: fromCents(totalC),
      refund,
      shiftId,
      note: (note || '').trim(),
      userId: ctx.user.id,
      user: { id: ctx.user.id, name: ctx.user.name },
      createdAt: at,
      items: rows,
    }
    putDoc(db, 'supplierreturn', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'supplier.return',
      accountId: ctx.user.accountId,
      payload: {
        // Цену сервер получает как ввели: сумму он пересчитывает сам и сверяет с нашей.
        // Партии он выберет по своим остаткам — их в операцию не кладём
        ret: {
          id: body.id,
          date: body.date,
          supplierId: body.supplierId,
          supplier: body.supplier,
          refund,
          shiftId,
          note: body.note,
          total: body.total,
          items: rows.map((r, n) => ({ id: r.id, productId: r.productId, name: r.name, qty: r.qty, pieces: r.pieces, price: lines[n].price.toNumber() })),
        },
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}

// Вернули поставщики наличными в ящик этой смены — по всем возвратам смены, своим и
// серверным (возврат «в кассу» могли оформить и на сайте, выбрав эту кассу). Свой,
// принятый сервером, приходит его копией под тем же номером и замещает свой, поэтому
// дважды не считается. Отвергнутые не в счёт (docs.mjs)
export function supplierRefundOf(db, shiftId) {
  let sum = D(0)
  for (const r of docsOfShift(db, 'supplierreturn', shiftId)) if (r.refund === 'cash') sum = sum.plus(r.total || 0)
  return sum
}
