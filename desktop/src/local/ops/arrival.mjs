// ── Приход товара ──
//
// Перенос серверного прихода (server/src/arrivals/arrivals.service.ts, только
// оформление: правка и удаление прихода остаются за сервером). Каждая строка —
// партия со своим сроком годности; закупочная цена товара после прихода становится
// средневзвешенной между тем, что лежало, и тем, что привезли.
import { bodyOf, checker, expiryOk, MAX_MONEY, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { enqueue, putDoc } from '../docs.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { myOpenShift } from '../docs.mjs'
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
  // Чем заплатили и сколько из этого — деньгами из ящика кассы
  const payMethod = c.oneOf(dto.payMethod ?? '', 'payMethod', ['', 'cash', 'own', 'card', 'debt'])
  const paidCashAsked = c.num(dto.paidCash, 'paidCash', { optional: true, max: MAX_MONEY })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    // Целые упаковки (у весового товара — килограммы); ноль допустим при pieces > 0
    qty: c.int(it?.qty, `items.${n}.qty`, { min: 0 }),
    // Штуки (граммы) сверх целых упаковок
    pieces: it?.pieces === undefined || it?.pieces === null ? 0 : c.int(it.pieces, `items.${n}.pieces`, { min: 0, max: 99999 }),
    cost: c.num(it?.cost, `items.${n}.cost`),
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
    // Новая цена продажи, назначенная наценкой в приходе. Нет — цена прежняя
    price: it?.price === undefined || it?.price === null ? null : c.num(it.price, `items.${n}.price`, { max: MAX_MONEY }),
  }))
  c.done()

  return inTx(db, () => {
    const byId = new Map()
    const lines = items.map((it) => {
      if (!byId.has(it.productId)) byId.set(it.productId, productById(db, it.productId))
      const p = byId.get(it.productId)
      if (!p) throw bad('Товар не найден')
      const units = it.qty * uppOf(p) + it.pieces
      if (units <= 0) throw bad(`Укажите количество: ${p.name}`)
      // Тот же отказ и теми же словами, что у сервера: позже его прислал бы он —
      // когда товар уже стоит на полке
      unitsOk(units, 'В приходе слишком большое количество')
      return { productId: p.id, name: p.name, qty: it.qty, pieces: it.pieces, units, cost: D(it.cost) }
    })

    // Срок годности партии не обязателен: впишут — партия под контролем сроков,
    // оставят пустым — партия без срока (хлеб, шампунь и прочее без даты)
    const expiry = items.map((it) => {
      if (!it.expiryDate) return null
      const iso = isoOrNull(it.expiryDate)
      if (!iso) throw bad('Некорректные данные запроса')
      expiryOk(iso)
      return iso
    })

    // Один товар может стоять в приходе несколькими строками. Среднюю цену считаем
    // по товару целиком: сколько упаковок пришло и на какую сумму
    const agg = new Map()
    let total = D(0)
    for (const l of lines) {
      const upp = uppOf(byId.get(l.productId))
      // Цена — за упаковку (за килограмм): граммы оплачиваются долей
      const dolya = D(l.units).div(upp)
      const a = agg.get(l.productId) || { units: 0, value: D(0) }
      a.units += l.units
      a.value = a.value.plus(l.cost.times(dolya))
      agg.set(l.productId, a)
      total = total.plus(l.cost.times(dolya))
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

    // «Из кассы»: деньги уходят из ящика ОТКРЫТОЙ смены этой кассы. Пока приход
    // не отправлен, закрытие смены само добавит эту сумму к «оплачено поставщикам»
    // (см. ops/shift.mjs); сервер при приёме запишет ту же оплату поставщику
    const paidCash = fromCents(toCents(D(paidCashAsked || 0)))
    let paidShiftId = null
    if (paidCash > 0) {
      if (!sup) throw bad('Для оплаты из кассы выберите поставщика из справочника')
      if (D(paidCash).gt(total.minus(debtD).plus(D('0.01')))) throw bad('Из кассы оплачено больше, чем стоит приход без долга')
      const shift = myOpenShift(db, ctx.deviceId)
      if (!shift) throw bad('Нет открытой смены — из кассы взять нечего.')
      paidShiftId = shift.id
    }

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
          units: l.units,
          costC: toCents(l.cost),
          expiryDate: expiry[n],
          arrivalId,
          // Дробные «упаковки» (12,35 кг) — это нормально: средняя цена считается в штуках
          wPacks: first ? Number(D(a.units).div(uppOf(p))) : null,
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
      payMethod,
      paidCash,
      shiftId: paidShiftId,
      userId: ctx.user.id,
      user: { id: ctx.user.id, name: ctx.user.name },
      total: fromCents(toCents(total)),
      items: lines.map((l) => ({
        id: newId(),
        arrivalId,
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        pieces: l.pieces,
        cost: fromCents(toCents(l.cost)),
      })),
    }
    // Новая цена продажи — сразу в карточке: касса продаёт по ней, не дожидаясь связи.
    // Один товар может стоять в приходе дважды — решает последняя строка
    const newPrice = new Map()
    items.forEach((it) => { if (it.price !== null && it.price !== undefined) newPrice.set(it.productId, toCents(D(it.price))) })
    for (const [pid, priceC] of newPrice) q(db, 'UPDATE products SET priceC = ? WHERE id = ?').run(priceC, pid)

    putDoc(db, 'arrival', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'arrival',
      accountId: ctx.user.accountId,
      payload: {
        // Закупочную цену в документе храним до дирама, а сумма прихода посчитана по
        // цене, как её ввели: 33,333 × 3 = 100.00, а не 99.99. Сервер пересчитывает
        // сумму сам и сверяет с нашей — поэтому цену он получает неокруглённой
        arrival: {
          ...body,
          items: body.items.map((it, n) => ({
            ...it,
            cost: lines[n].cost.toNumber(),
            ...(items[n].price !== null && items[n].price !== undefined ? { price: items[n].price } : {}),
          })),
        },
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
