// ── Продажа ──
//
// Перенос серверной продажи (server/src/sales/sales.service.ts) в локальную базу.
// Считает и отказывает так же, как сервер: те же формулы, те же тексты. Разница
// в одном — чек записывается на диск этого компьютера и встаёт в очередь на
// отправку, поэтому интернет для продажи не нужен.
import { customerRow, customerView, debtMove } from '../catalog.mjs'
import { bodyOf, checker, packOk, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId, notFound } from '../db.mjs'
import { docByClientId, enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, dmax, dmin, fromCents, fromCentsD, toCents } from '../money.mjs'
import { move, productById } from '../stock.mjs'
import { uppOf, wholeNonNeg } from '../units.mjs'

// Продажа без открытой смены не проводится — текст слово в слово как у сервера
// (server/src/shifts/till.ts). Проверяет маршрут /sales (local/api.mjs): сама продажа
// остаётся чистой механикой, которую проверки гоняют и без смены
export const NO_SHIFT_SALE = 'Сначала откройте смену: без открытой смены продажа невозможна.'

export function checkout(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    qty: c.int(it?.qty, `items.${n}.qty`),
    pieces: c.int(it?.pieces, `items.${n}.pieces`, { optional: true }),
    discount: c.num(it?.discount, `items.${n}.discount`, { optional: true }),
  }))
  const payment = c.oneOf(dto.payment, 'payment', ['cash', 'card', 'debt', 'transfer'])
  const payViaRaw = c.str(dto.payVia, 'payVia', { optional: true })
  const customerId = c.str(dto.customerId, 'customerId', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  c.done()

  if (payment === 'debt' && !customerId) throw bad('Для продажи в долг укажите клиента')
  // Перевод без сервиса не сверить с выпиской — тот же отказ, что у сервера
  const payVia = payment === 'transfer' ? (payViaRaw || '').trim().slice(0, 40) : ''
  if (payment === 'transfer' && !payVia) throw bad('Укажите сервис перевода')

  // Окно могло повторить запрос, хотя чек уже записан. Отдаём записанный, чтобы
  // не списать товар и деньги дважды
  if (clientId) {
    const already = docByClientId(db, 'sale', clientId)
    if (already) return already.body
  }

  // qty — упаковки, pieces — штуки из вскрытой упаковки
  const lines = items.map((it) => ({
    productId: it.productId,
    qty: wholeNonNeg(it.qty),
    pieces: wholeNonNeg(it.pieces),
    discount: it.discount || 0,
  }))
  for (const l of lines) {
    if (l.qty + l.pieces <= 0) throw bad('Укажите количество (упаковки или штуки)')
  }

  return inTx(db, () => {
    const byId = new Map()
    for (const l of lines) {
      if (!byId.has(l.productId)) byId.set(l.productId, productById(db, l.productId))
      if (!byId.get(l.productId)) throw bad('Товар не найден')
    }

    // Сколько ШТУК уходит по каждому товару (упаковки переводим в штуки)
    const unitsById = new Map()
    for (const l of lines) {
      const p = byId.get(l.productId)
      const upp = uppOf(p)
      packOk(upp, p.name)
      unitsOk(l.qty * upp + l.pieces)
      unitsById.set(l.productId, (unitsById.get(l.productId) || 0) + l.qty * upp + l.pieces)
    }

    const saleId = newId()
    const opId = newId()

    // Позиции чека и суммы. Цена за штуку = цена упаковки / штук в упаковке.
    // Суммы копятся точными и округляются один раз, при записи, — как на сервере
    let total = D(0)
    let cost = D(0)
    const saleItems = lines.map((l) => {
      const p = byId.get(l.productId)
      const upp = uppOf(p)
      const units = l.qty * upp + l.pieces
      const gross = fromCentsD(p.priceC).dividedBy(upp).times(units)
      const discount = dmin(dmax(0, D(l.discount)), gross)
      total = total.plus(gross.minus(discount))
      cost = cost.plus(fromCentsD(p.costC).dividedBy(upp).times(units))
      return {
        id: newId(),
        saleId,
        productId: p.id,
        name: p.name,
        qty: l.qty,
        pieces: l.pieces,
        unitsPerPack: upp,
        unit: p.unit || '',
        price: fromCents(p.priceC),
        cost: fromCents(p.costC),
        discount: fromCents(toCents(discount)),
      }
    })

    sumOk(total, cost)

    // Списываем по партиям: первой уходит ГОДНАЯ партия с ближайшим сроком.
    // Не хватило — отказ, и вся продажа откатывается целиком
    for (const [productId, units] of unitsById) {
      move(db, { opId, productId, kind: 'sale', units: -units, skipExpired: true }, { now })
    }

    let customer = null
    if (payment === 'debt' && customerId) {
      if (!customerRow(db, customerId)) throw notFound('Клиент не найден')
      debtMove(db, { opId, customerId, deltaC: toCents(total), kind: 'sale' }, now)
      customer = customerView(customerRow(db, customerId))
    }

    // Чек привязывается к открытой смене этой кассы (для Z-отчёта)
    const shift = myOpenShift(db, ctx.deviceId)

    const body = {
      id: saleId,
      clientId: clientId ?? null,
      date: new Date(now).toISOString(),
      total: fromCents(toCents(total)),
      cost: fromCents(toCents(cost)),
      profit: fromCents(toCents(total.minus(cost))),
      payment,
      payVia: payVia || null,
      customerId: payment === 'debt' ? customerId : null,
      shiftId: shift?.id ?? null,
      userId: ctx.user.id,
      items: saleItems,
      customer,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'sale', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, { id: opId, type: 'sale', accountId: ctx.user.accountId, payload: { sale: body, deviceId: ctx.deviceId }, now })
    return body
  })
}
