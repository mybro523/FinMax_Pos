// ── Возврат товара ──
//
// Перенос серверного возврата (server/src/returns/returns.service.ts). Оформляется
// по чеку; по каждой позиции кассир указывает, вернуть товар в продажу или сразу
// списать. Деньги возвращаются тем же способом, каким платили: наличные и карта —
// из кассы, долг — уменьшением долга клиента.
import { customerRow, debtMove } from '../catalog.mjs'
import { bodyOf, checker, enteredExpiry, packOk, sumOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { docByClientId, enqueue, getDoc, myOpenShift, putDoc, returnsOfSale } from '../docs.mjs'
import { D, fixed2, fromCents, fromCentsD, toCents } from '../money.mjs'
import { move, productById, returnExpiry } from '../stock.mjs'
import { uppOf, wholeNonNeg } from '../units.mjs'

export const REJECTED_SALE = 'Этот чек сервер не принял — возврат по нему оформить нельзя. Чек есть у владельца в списке «Не принято сервером».'

export function createReturn(ctx, raw) {
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
    if (already) return already.body
  }

  return inTx(db, () => {
    const saleDoc = saleId ? getDoc(db, 'sale', saleId) : null
    const sale = saleDoc?.body ?? null
    if (saleId && !sale) throw bad('Чек не найден')
    // Чек, который сервер отверг, там не существует: возврат по нему он отверг бы тоже,
    // а товар к тому времени уже вернулся бы на полку
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
    const toWriteOff = []

    for (const it of items) {
      // Карточку читаем заново на каждой позиции: предыдущая позиция того же
      // товара могла вернуть штуки на полку и изменить ближайший срок
      const product = productById(db, it.productId)
      if (!product) throw bad('Товар не найден')
      const units = wholeNonNeg(it.units)
      if (units <= 0) continue

      const line = sale?.items.find((si) => si.productId === it.productId)
      if (sale && !line) throw bad(`«${product.name}» нет в этом чеке`)
      const restock = it.restock !== false
      // Срок годности возвращённого: вписанный кассиром с упаковки, а если он его не
      // вписал — самый ранний из тех, с какими товар продавался в день покупки
      const expiry = it.expiry ?? returnExpiry(db, product.id, sale ? sale.date : now, product.expiryDate)

      if (line) {
        const lineUpp = Math.max(1, line.unitsPerPack || 1)
        const sold = line.qty * lineUpp + line.pieces
        const already = returnedBefore.get(it.productId) || 0
        if (already + units > sold) {
          throw bad(`По «${product.name}» уже возвращено ${already} из ${sold} шт`)
        }
      }

      // Деньги возвращаются пропорционально тому, сколько реально заплатили за
      // штуку (с учётом скидки на позицию) — иначе при скидке касса не сошлась бы
      const upp = line ? Math.max(1, line.unitsPerPack || 1) : uppOf(product)
      packOk(upp, product.name)
      const price = line ? D(line.price) : fromCentsD(product.priceC)
      const cost = line ? D(line.cost) : fromCentsD(product.costC)
      const soldUnits = line ? line.qty * upp + line.pieces : units
      const gross = price.dividedBy(upp).times(soldUnits)
      const paid = line ? gross.minus(D(line.discount)) : gross
      const perUnit = soldUnits > 0 ? paid.dividedBy(soldUnits) : D(0)
      const amount = perUnit.times(units)
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
        // Вписанный срок уходит на сервер вместе с возвратом. Не вписан — поля нет, и
        // срок сервер поставит сам: он знает больше партий, чем касса
        ...(restock && it.expiry ? { expiryDate: it.expiry } : {}),
      })

      if (restock) {
        // Обратно в продажу — партией со своим сроком
        move(
          db,
          {
            opId,
            productId: product.id,
            kind: 'return',
            units,
            costC: toCents(cost),
            expiryDate: expiry,
            arrivalId: null,
            note: 'Возврат от покупателя',
          },
          { now },
        )
      } else {
        toWriteOff.push({ productId: product.id, name: product.name, units, cost, expiryDate: expiry, upp })
      }
    }

    if (!returnItems.length) throw bad('Укажите количество для возврата')
    sumOk(total)
    // Сумма возврата — до дирама, как суммы чеков и долг клиента: продажа прибавила к
    // долгу округлённую сумму (треть упаковки по 100 — 33,33), и точная 33,333… не должна
    // оказаться «больше долга» — иначе продажу в долг нельзя вернуть целиком
    total = fromCentsD(toCents(total))

    const shift = myOpenShift(db, ctx.deviceId)
    const refund = refundAsked || sale?.payment || 'cash'
    // Деньги вернули переводом: сервис — названный кассиром, иначе тот, каким платили
    const refundVia = refund === 'transfer' ? (refundViaAsked || '').trim().slice(0, 40) || sale?.payVia || null : null

    // Возврат «в долг» уменьшает долг клиента, а не выдаёт наличные. Списать больше
    // текущего долга нельзя: клиент ушёл бы в минус. Так бывает, когда долг уже
    // погасили, а товар принесли позже — тогда деньги отдают из кассы.
    if (refund === 'debt') {
      const customerId = sale?.customerId
      if (!customerId) throw bad('Возврат в долг возможен только по чеку, оформленному на клиента')
      const customer = customerRow(db, customerId)
      const debt = fromCentsD(customer?.debtC ?? 0)
      if (debt.lt(total)) {
        throw bad(`Долг клиента ${fixed2(debt)} меньше суммы возврата ${fixed2(total)} — верните деньги наличными или картой`)
      }
      if (!customer) throw bad('Долг клиента изменился, обновите данные и повторите')
      // Новый долг = (долг − возврат), округлённый до дирама: вычитается точная
      // сумма, а не округлённая, — так считает база сервера
      debtMove(db, { opId, customerId, deltaC: toCents(debt.minus(total)) - customer.debtC, kind: 'return' }, now)
    }

    const date = new Date(now).toISOString()
    const user = { id: ctx.user.id, name: ctx.user.name }

    // Позиции, которые в продажу не вернулись, сразу оформляются списанием —
    // для учёта убытка. Со склада при этом ничего не уходит: товар уже был продан
    let writeOff = null
    if (toWriteOff.length) {
      const writeOffId = newId()
      // Убыток = себестоимость штуки (цена упаковки / штук в упаковке) × число штук
      const totalCost = toWriteOff.reduce((s, w) => s.plus(D(w.cost).dividedBy(Math.max(1, w.upp)).times(w.units)), D(0))
      writeOff = {
        id: writeOffId,
        date,
        userId: ctx.user.id,
        reason: 'damaged',
        note: 'Возврат покупателя без возврата в продажу',
        totalCost: fromCents(toCents(totalCost)),
        source: 'return',
        items: toWriteOff.map((w) => ({
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

    const body = {
      id: returnId,
      clientId: clientId ?? null,
      date,
      saleId: saleId ?? null,
      userId: ctx.user.id,
      shiftId: shift?.id ?? null,
      refund,
      refundVia,
      total: fromCents(toCents(total)),
      note: note || '',
      items: returnItems,
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
