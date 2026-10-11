// ── Внесение и изъятие наличных ──
//
// Перенос серверных операций над ящиком (server/src/shifts/cash.service.ts). Кассир
// положил размен, владелец забрал выручку — это ни продажа, ни расход: деньги просто
// вошли в ящик или вышли из него, и смена обязана это знать. Работает без интернета:
// операция ложится в смену ЭТОЙ кассы и уходит на сервер, когда появится связь.
//
// Отменить запись касса сама не умеет — это делает сервер (см. gateway.mjs).
import { bodyOf, checker, MAX_MONEY } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { docByClientId, docsOfShift, enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, fromCents, toCents } from '../money.mjs'

// Текст отказа — слово в слово как у сервера (shifts/till.ts): человек читает его с
// экрана, и откуда пришёл ответ, он знать не должен
export const NO_OPEN_SHIFT_CASH = 'Нет открытой смены — внести или изъять наличные не из чего. Откройте смену.'

export function createCashMove(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const kind = c.oneOf(dto.kind, 'kind', ['in', 'out'])
  const amount = c.num(dto.amount, 'amount', { min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  c.done()

  return inTx(db, () => {
    // Окно переиграло запрос после заминки — второй записи не заводим
    if (clientId) {
      const already = docByClientId(db, 'cashmove', clientId)
      if (already) return already.body
    }
    if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')
    const open = myOpenShift(db, ctx.deviceId)
    if (!open) throw bad(NO_OPEN_SHIFT_CASH)

    const at = new Date(now).toISOString()
    const body = {
      id: newId(),
      clientId: clientId || null,
      shiftId: open.body.id,
      kind,
      amount: fromCents(toCents(amount)),
      note: (note || '').trim(),
      userId: ctx.user.id,
      date: at,
      createdAt: at,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'cashmove', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: newId(),
      type: 'cash.move',
      accountId: ctx.user.accountId,
      // Серверу — только сама операция: кто её сделал, он знает по учётной записи
      payload: { move: { id: body.id, shiftId: body.shiftId, kind, amount: body.amount, note: body.note, date: at }, deviceId: ctx.deviceId },
      now,
    })
    return body
  })
}

// Внесено и изъято за смену — по всем записям смены, своим и серверным. Своя запись,
// которую сервер уже принял, приходит его копией под тем же номером и замещает свою,
// поэтому дважды не считается. Отвергнутые записи не в счёт (docs.mjs)
export function cashMovesOf(db, shiftId) {
  let cashIn = D(0)
  let cashOut = D(0)
  for (const m of docsOfShift(db, 'cashmove', shiftId)) {
    if (m.kind === 'in') cashIn = cashIn.plus(m.amount || 0)
    else if (m.kind === 'out') cashOut = cashOut.plus(m.amount || 0)
  }
  return { cashIn, cashOut }
}
