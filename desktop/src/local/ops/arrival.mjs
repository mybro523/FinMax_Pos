// ── Приход товара ──
//
// Перенос серверного прихода (server/src/arrivals/arrivals.service.ts, только
// оформление: правка и удаление прихода остаются за сервером). Каждая строка —
// партия со своим сроком годности; закупочная цена товара после прихода становится
// средневзвешенной между тем, что лежало, и тем, что привезли.
import { noExpiryCategories } from '../catalog.mjs'
import { bodyOf, checker, expiryOk, MAX_MONEY, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { enqueue, putDoc } from '../docs.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { supplierRow } from '../suppliers.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'

export function createArrival(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const supplier = c.str(dto.supplier, 'supplier', { optional: true })
  // Поставщик из справочника и неоплаченная часть — долг перед ним
  const supplierId = c.str(dto.supplierId, 'supplierId', { optional: true })
  const debtAsked = c.num(dto.debt, 'debt', { optional: true, max: MAX_MONEY })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    qty: c.int(it?.qty, `items.${n}.qty`, { min: 1 }),
    cost: c.num(it?.cost, `items.${n}.cost`),
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
  }))
  c.done()

  return inTx(db, () => {
    const byId = new Map()
    const lines = items.map((it) => {
      if (!byId.has(it.productId)) byId.set(it.productId, productById(db, it.productId))
      const p = byId.get(it.productId)
      if (!p) throw bad('Товар не найден')
      // Тот же отказ и теми же словами, что у сервера: позже его прислал бы он —
      // когда товар уже стоит на полке
      unitsOk(it.qty * uppOf(p), 'В приходе слишком большое количество')
      return { productId: p.id, name: p.name, qty: it.qty, cost: D(it.cost) }
    })

    // Срок годности партии: у лекарств он обязателен, иначе контроль сроков дырявый.
    // Где срок не нужен (бинты, вата, приборы) — решает владелец галочкой у категории
    const noExpiry = noExpiryCategories(db)
    const expiry = items.map((it) => {
      const p = byId.get(it.productId)
      if (it.expiryDate) {
        const iso = isoOrNull(it.expiryDate)
        if (!iso) throw bad('Некорректные данные запроса')
        expiryOk(iso)
        return iso
      }
      if (!noExpiry.has(p.category)) throw bad(`Укажите срок годности: ${p.name}`)
      return null
    })

    // Один товар может стоять в приходе несколькими строками. Среднюю цену считаем
    // по товару целиком: сколько упаковок пришло и на какую сумму
    const agg = new Map()
    let total = D(0)
    for (const l of lines) {
      const a = agg.get(l.productId) || { qty: 0, value: D(0) }
      a.qty += l.qty
      a.value = a.value.plus(l.cost.times(l.qty))
      agg.set(l.productId, a)
      total = total.plus(l.cost.times(l.qty))
    }
    sumOk(total)

    // Поставщика знает справочник, присланный сервером. Нового без связи не завести —
    // его заводит сервер; приход в долг тогда ждёт интернета
    let sup = null
    if (supplierId) {
      sup = supplierRow(db, supplierId)
      if (!sup) throw bad('Поставщик не найден')
    }
    const asked = D(debtAsked || 0)
    const debtD = !sup ? D(0) : asked.gt(total) ? total : asked
    const debt = fromCents(toCents(debtD))

    const arrivalId = newId()
    const opId = newId()
    const weighed = new Set()

    lines.forEach((l, n) => {
      const p = byId.get(l.productId)
      // Пересчёт средней цены — один раз на товар, перед первой его партией:
      // цена считается от остатка ДО прихода
      const first = !weighed.has(l.productId)
      weighed.add(l.productId)
      const a = agg.get(l.productId)
      move(
        db,
        {
          opId,
          productId: l.productId,
          kind: 'arrival',
          units: l.qty * uppOf(p),
          costC: toCents(l.cost),
          expiryDate: expiry[n],
          arrivalId,
          wPacks: first ? a.qty : null,
          wValue: first ? a.value.toString() : null,
        },
        { now },
      )
    })

    const body = {
      id: arrivalId,
      date: new Date(now).toISOString(),
      supplier: sup?.name || supplier || '—',
      supplierId: sup?.id ?? null,
      debt,
      userId: ctx.user.id,
      user: { id: ctx.user.id, name: ctx.user.name },
      total: fromCents(toCents(total)),
      items: lines.map((l) => ({
        id: newId(),
        arrivalId,
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        cost: fromCents(toCents(l.cost)),
      })),
    }
    putDoc(db, 'arrival', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'arrival',
      accountId: ctx.user.accountId,
      payload: {
        // Закупочную цену в документе храним до дирама, а сумма прихода посчитана по
        // цене, как её ввели: 33,333 × 3 = 100.00, а не 99.99. Сервер пересчитывает
        // сумму сам и сверяет с нашей — поэтому цену он получает неокруглённой
        arrival: { ...body, items: body.items.map((it, n) => ({ ...it, cost: lines[n].cost.toNumber() })) },
        // Срок годности в самом документе не хранится — он у партии. Серверу его
        // надо передать отдельно, построчно
        expiry,
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
