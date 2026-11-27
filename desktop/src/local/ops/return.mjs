// ── Возврат товара ──
//
// Перенос серверного возврата (server/src/returns/returns.service.ts). Оформляется
// по чеку; по каждой позиции кассир указывает, вернуть товар в продажу или сразу
// списать. Деньги возвращаются тем же способом, каким платили: наличные и карта —
// из кассы, долг — уменьшением долга клиента.
//
// Как и продажа, возврат разделён на planReturn (считает, не пишет) и commitReturn
// (пишет уже посчитанное). Между ними фискальный модуль (local/fiskal/sell.mjs) пробивает
// чек возврата (REVERT_INCOME) на устройстве — не прошло, возврат не записывается. Без
// фискального модуля оба шага идут подряд, как и прежде — createReturn.
import { customerRow, debtMove } from '../catalog.mjs'
import { bodyOf, checker, enteredExpiry, packOk, sumOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { docByClientId, enqueue, getDoc, myOpenShift, putDoc, returnsOfSale } from '../docs.mjs'
import { D, fixed2, fromCents, fromCentsD, toCents } from '../money.mjs'
import { grossOf, isDrob, KG, refundOf } from '../piece.mjs'
import { move, productById, returnExpiry } from '../stock.mjs'
import { uppOf, wholeNonNeg } from '../units.mjs'

export const REJECTED_SALE = 'Этот чек сервер не принял — возврат по нему оформить нельзя. Чек есть у владельца в списке «Не принято сервером».'

// ── Шаг 1: посчитать возврат, ничего не записывая ──
// Бросает те же отказы, что и возврат целиком. Возвращает план для записи и «фискальную»
// выжимку (итог и строки в дирамах) для local/fiskal/map.mjs. Повтор уже записанного
// возврата (clientId найден) — { already: тело }.
export function planReturn(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const saleId = c.str(dto.saleId, 'saleId', { optional: true })
  const refundAsked = c.oneOf(dto.refund, 'refund', ['cash', 'card', 'debt', 'transfer'], { optional: true })
  const refundViaAsked = c.str(dto.refundVia, 'refundVia', { optional: true })
  const note = c.str(dto.note, 'note', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    units: c.int(it?.units, `items.${n}.units`, { min: 1 }),
    restock: c.bool(it?.restock, `items.${n}.restock`, { optional: true }),
    // Срок годности с упаковки — если кассир его вписал
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
  }))
  c.done()
  // Вписанный срок проверяется до всего остального: отказ не должен оставить после
  // себя половину возврата
  for (const it of items) it.expiry = enteredExpiry(it.expiryDate, it.restock !== false, now)

  if (clientId) {
    const already = docByClientId(db, 'return', clientId)
    if (already) return { already: already.body }
  }

  const saleDoc = saleId ? getDoc(db, 'sale', saleId) : null
  const sale = saleDoc?.body ?? null
  if (saleId && !sale) throw bad('Чек не найден')
  // Чек, который сервер отверг, там не существует: возврат по нему он отверг бы тоже
  if (saleDoc?.sync === 'rejected') throw bad(REJECTED_SALE)

  // Сколько уже возвращали по этому чеку — нельзя вернуть больше, чем покупали
  const returnedBefore = new Map()
  for (const r of saleId ? returnsOfSale(db, saleId) : []) {
    for (const ri of r.items || []) {
      if (!ri.productId) continue
      returnedBefore.set(ri.productId, (returnedBefore.get(ri.productId) || 0) + ri.units)
    }
  }

  const returnId = newId()
  const opId = newId()
  let total = D(0)
  const returnItems = []
  const fiscalLines = []
  const restocks = []
  const toWriteOff = []

  for (const it of items) {
    const product = productById(db, it.productId)
    if (!product) throw bad('Товар не найден')
    const units = wholeNonNeg(it.units)
    if (units <= 0) continue

    const line = sale?.items.find((si) => si.productId === it.productId)
    if (sale && !line) throw bad(`«${product.name}» нет в этом чеке`)
    const restock = it.restock !== false
    // Срок годности возвращённого: вписанный кассиром, иначе самый ранний из тех, с какими
    // товар продавался в день покупки. У одного возврата каждый товар в позициях один раз,
    // поэтому возврат на полку одной позиции не влияет на срок другой — считать до записи можно.
    const expiry = it.expiry ?? returnExpiry(db, product.id, sale ? sale.date : now, product.expiryDate)

    if (line) {
      const lineUpp = Math.max(1, line.unitsPerPack || 1)
      const sold = line.qty * lineUpp + line.pieces
      const already = returnedBefore.get(it.productId) || 0
      if (already + units > sold) {
        const ed = line.unit || product.unit
        const skolko = (n) => (isDrob(ed) ? `${n / KG}` : `${n}`)
        throw bad(`По «${product.name}» уже возвращено ${skolko(already)} из ${skolko(sold)} ${isDrob(ed) ? String(ed).trim() : 'шт'}`)
      }
    }

    // Деньги возвращаются пропорционально тому, сколько реально заплатили за штуку
    const upp = line ? Math.max(1, line.unitsPerPack || 1) : uppOf(product)
    packOk(upp, product.name)
    const price = line ? D(line.price) : fromCentsD(product.priceC)
    const cost = line ? D(line.cost) : fromCentsD(product.costC)
    const soldUnits = line ? line.qty * upp + line.pieces : units
    const unit = line?.unit || product.unit
    const gross = line ? grossOf({ qty: line.qty, pieces: line.pieces, price: line.price, piecePrice: line.piecePrice, unitsPerPack: upp, unit }) : price.dividedBy(upp).times(soldUnits)
    const paid = line ? gross.minus(D(line.discount)) : gross
    const amount = line
      ? refundOf({ qty: line.qty, pieces: line.pieces, price: line.price, piecePrice: line.piecePrice, unitsPerPack: upp, unit, discount: line.discount }, units, returnedBefore.get(it.productId) || 0)
      : (soldUnits > 0 ? paid.dividedBy(soldUnits) : D(0)).times(units)
    total = total.plus(amount)

    returnItems.push({
      id: newId(),
      returnId,
      productId: product.id,
      name: product.name,
      units,
      unitsPerPack: upp,
      unit: product?.unit || '',
      price: fromCents(toCents(price)),
      cost: fromCents(toCents(cost)),
      amount: fromCents(toCents(amount)),
      restock,
      ...(restock && it.expiry ? { expiryDate: it.expiry } : {}),
    })
    // Фискальная строка возврата: товар возвращается поштучно (units), сумма — чистые деньги
    fiscalLines.push({ name: product.name, qty: 0, pieces: units, sumC: toCents(amount) })

    if (restock) {
      restocks.push({ productId: product.id, units, costC: toCents(cost), expiryDate: expiry })
    } else {
      toWriteOff.push({ productId: product.id, name: product.name, units, cost, expiryDate: expiry, upp })
    }
  }

  if (!returnItems.length) throw bad('Укажите количество для возврата')
  sumOk(total)
  const totalC = toCents(total)
  const refund = refundAsked || sale?.payment || 'cash'
  const refundVia = refund === 'transfer' ? (refundViaAsked || '').trim().slice(0, 40) || sale?.payVia || null : null

  return {
    returnId,
    opId,
    clientId: clientId ?? null,
    saleId: saleId ?? null,
    note: note || '',
    refund,
    refundVia,
    customerId: sale?.customerId ?? null,
    total: fromCents(totalC),
    returnItems,
    restocks,
    toWriteOff,
    // Выжимка для фискального чека возврата (REVERT_INCOME). Долг не фискализируем.
    fiscal: { totalC, payment: refund, lines: fiscalLines },
  }
}

// ── Шаг 2: записать посчитанный возврат ──
export function commitReturn(ctx, plan) {
  const { db, now } = ctx
  return inTx(db, () => {
    // Повтор мог записаться между планом и фиксацией (например, пока шла фискализация)
    if (plan.clientId) {
      const already = docByClientId(db, 'return', plan.clientId)
      if (already) return already.body
    }
    const { returnId, opId } = plan
    const total = D(plan.total)

    // Возврат в продажу — партией со своим сроком
    for (const r of plan.restocks) {
      move(db, { opId, productId: r.productId, kind: 'return', units: r.units, costC: r.costC, expiryDate: r.expiryDate, arrivalId: null, note: 'Возврат от покупателя' }, { now })
    }

    // Возврат «в долг» уменьшает долг клиента, а не выдаёт наличные. Списать больше
    // текущего долга нельзя. Долг читаем в транзакции — он мог измениться.
    if (plan.refund === 'debt') {
      const customerId = plan.customerId
      if (!customerId) throw bad('Возврат в долг возможен только по чеку, оформленному на клиента')
      const customer = customerRow(db, customerId)
      const debt = fromCentsD(customer?.debtC ?? 0)
      if (debt.lt(total)) {
        throw bad(`Долг клиента ${fixed2(debt)} меньше суммы возврата ${fixed2(total)} — верните деньги наличными или картой`)
      }
      if (!customer) throw bad('Долг клиента изменился, обновите данные и повторите')
      debtMove(db, { opId, customerId, deltaC: toCents(debt.minus(total)) - customer.debtC, kind: 'return' }, now)
    }

    const date = new Date(now).toISOString()
    const user = { id: ctx.user.id, name: ctx.user.name }

    // Позиции, не вернувшиеся в продажу, сразу оформляются списанием — для учёта убытка
    let writeOff = null
    if (plan.toWriteOff.length) {
      const writeOffId = newId()
      const totalCost = plan.toWriteOff.reduce((s, w) => s.plus(D(w.cost).dividedBy(Math.max(1, w.upp)).times(w.units)), D(0))
      writeOff = {
        id: writeOffId,
        date,
        userId: ctx.user.id,
        reason: 'damaged',
        note: 'Возврат покупателя без возврата в продажу',
        totalCost: fromCents(toCents(totalCost)),
        source: 'return',
        items: plan.toWriteOff.map((w) => ({
          id: newId(),
          writeOffId,
          productId: w.productId,
          name: w.name,
          units: w.units,
          cost: fromCents(toCents(w.cost)),
          expiryDate: w.expiryDate,
        })),
        user,
      }
      putDoc(db, 'writeoff', writeOff, { sync: 'pending', deviceId: ctx.deviceId })
    }

    const shift = myOpenShift(db, ctx.deviceId)
    const body = {
      id: returnId,
      clientId: plan.clientId,
      date,
      saleId: plan.saleId,
      userId: ctx.user.id,
      shiftId: shift?.id ?? null,
      refund: plan.refund,
      refundVia: plan.refundVia,
      total: fromCents(toCents(total)),
      note: plan.note,
      items: plan.returnItems,
      user,
    }
    putDoc(db, 'return', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'return',
      accountId: ctx.user.accountId,
      payload: { ret: body, writeOff, deviceId: ctx.deviceId },
      now,
    })
    return body
  })
}

// Обычный возврат (без фискализации): посчитать и сразу записать — как было до разделения.
export function createReturn(ctx, raw) {
  const plan = planReturn(ctx, raw)
  if (plan.already) return plan.already
  return commitReturn(ctx, plan)
}
