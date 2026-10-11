// ── Клиенты и долги ──
//
// Перенос серверных операций (server/src/customers/customers.service.ts):
// завести клиента и принять оплату долга. Без них не продать в долг и не взять
// деньги, поэтому обе работают без интернета. Удаление клиента — решение владельца,
// оно остаётся за сервером.
import { customerRow, customerView, debtMove } from '../catalog.mjs'
import { bodyOf, checker } from '../check.mjs'
import { bad, inTx, newId, notFound, q } from '../db.mjs'
import { enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, dmax, dmin, fromCents, fromCentsD, toCents } from '../money.mjs'

export function createCustomer(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const name = c.str(dto.name, 'name')
  const phone = c.str(dto.phone, 'phone', { optional: true })
  const debt = c.num(dto.debt, 'debt', { optional: true })
  c.done()
  // Сервер клиента без имени не заведёт. Отказать надо здесь и сейчас, а не через
  // неделю, когда на него уже записан долг
  if (!name.trim()) throw bad('Укажите имя клиента')

  return inTx(db, () => {
    const id = newId()
    const opId = newId()
    const createdAt = new Date(now).toISOString()
    const debtC = toCents(dmax(0, D(debt || 0)))
    q(db, 'INSERT INTO customers (id, name, phone, sDebtC, debtC, createdAt, local) VALUES (?, ?, ?, 0, 0, ?, 1)').run(
      id,
      name,
      phone || '',
      createdAt,
    )
    // Начальный долг — тоже движение: когда сервер пришлёт свои данные, долг
    // нового клиента сложится заново из журнала, и начальная сумма не потеряется
    debtMove(db, { opId, customerId: id, deltaC: debtC, kind: 'create' }, now)
    const view = customerView(customerRow(db, id))
    enqueue(db, { id: opId, type: 'customer.create', accountId: ctx.user.accountId, payload: { customer: view }, now })
    return view
  })
}

// Погашение долга — с журналом и защитой от ухода в минус
export function payDebt(ctx, customerId, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const amount = c.num(dto.amount, 'amount', { min: 0.01 })
  c.done()

  return inTx(db, () => {
    const customer = customerRow(db, customerId)
    if (!customer) throw notFound('Клиент не найден')

    // Гасим не больше текущего долга: переплата в минус не уходит
    const debt = fromCentsD(customer.debtC)
    const pay = dmin(D(amount), debt)
    if (pay.lte(0)) return customerView(customer)

    const opId = newId()
    debtMove(db, { opId, customerId, deltaC: toCents(debt.minus(pay)) - customer.debtC, kind: 'pay' }, now)

    // Деньги пришли в кассу — погашение привязывается к открытой смене
    const shift = myOpenShift(db, ctx.deviceId)
    const payment = {
      id: newId(),
      customerId,
      amount: fromCents(toCents(pay)),
      shiftId: shift?.id ?? null,
      createdAt: new Date(now).toISOString(),
      customer: { name: customer.name },
    }
    putDoc(db, 'payment', payment, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, { id: opId, type: 'debt.pay', accountId: ctx.user.accountId, payload: { payment, deviceId: ctx.deviceId }, now })
    return customerView(customerRow(db, customerId))
  })
}
