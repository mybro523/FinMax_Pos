// ── Фискализация продажи и смены ──
//
// Идёт мимо обычных обработчиков (local/api.mjs): те синхронны, а запрос к устройству —
// это сеть, его надо дождаться. Поэтому зовётся из асинхронного слоя шлюза (gateway.mjs,
// local()) — только когда включён и модуль «Фискальный принтер» магазина, и устройство
// на этой кассе (fiskal.enabled()).
//
// Правило владельца: нет фискального чека — нет продажи. Поэтому порядок строгий:
// посчитать → пробить на устройстве → и лишь при успехе записать. Отказ устройства
// (нет бумаги, занято, недоступно, ошибка ОФД) превращается в понятный отказ продажи,
// и товар с деньгами не трогаются.
import { hasPerm } from '../accounts.mjs'
import { ApiError, bad, forbidden, newId } from '../db.mjs'
import { myOpenShift } from '../docs.mjs'
import { assertSaleAllowed, commitSale, planSale } from '../ops/sale.mjs'
import { closeShift, mayCloseShift, NOT_YOUR_SHIFT, openShift } from '../ops/shift.mjs'
import { closeShiftReq, openShiftReq, saleReceipt } from './map.mjs'
import { fiscalHuman } from './messages.mjs'

const RIGHTS = 'Недостаточно прав'
// Устройство отказало или недоступно → отказ «нельзя сейчас» (409) с понятным текстом.
// Текст переводится на таджикский в окне (client/src/lib/i18n.js).
const fiscalError = (r) => new ApiError(409, fiscalHuman(r))
// Повторная регистрация того же externalId — для устройства «уже пробит»: значит фискализация
// на деле прошла (мы просто не узнали об этом в прошлый раз). Считаем успехом.
const okOrDuplicate = (r) => r.ok || r.code === 'DUPLICATED_EXTERNAL_ID'

// ── Продажа с фискализацией ──
export async function fiscalSell(ctx, fiskal, { log } = {}) {
  if (!hasPerm(ctx.user, 'pos.sell')) throw forbidden(RIGHTS)
  assertSaleAllowed(ctx)

  const plan = planSale(ctx, ctx.body)
  // Повтор уже записанного чека — отдаём записанный, устройство не трогаем
  if (plan.already) return plan.already

  // Долг не фискализируем в момент продажи (решение владельца): оплаты сейчас нет, чек ОФД
  // пробивается при погашении — это отдельный этап. Итог 0 (всё по скидке) бить нечем.
  const payload = ctx.body.payment === 'debt' ? null : saleReceipt(plan.fiscal, fiskal.config(), { externalId: plan.saleId })
  if (!payload) return commitSale(ctx, plan)

  let r = await fiskal.send('formReceipt', payload)
  // Смена кассы открыта, а на устройстве — нет (фискализацию включили при уже открытой смене,
  // или устройство перезагрузилось). Откроем смену на устройстве и повторим чек один раз —
  // иначе касса застряла бы «нельзя продавать» до закрытия смены кассы.
  if (!r.ok && r.code === 'SHIFT_MUST_BE_OPENED') {
    const opened = await fiskal.send('openShift', openShiftReq({ cashier: ctx.user.name, externalId: newId() }))
    if (opened.ok || opened.code === 'SHIFT_MUST_BE_CLOSED') r = await fiskal.send('formReceipt', payload)
  }
  if (!okOrDuplicate(r)) throw fiscalError(r)

  // Чек пробит на устройстве — записываем продажу. Если запись сорвётся здесь (крайне редко:
  // товар исчез между расчётом и записью), фискальный чек останется «висеть» — пишем об этом
  // в журнал, чтобы владелец мог оформить чек коррекции
  try {
    return commitSale(ctx, plan)
  } catch (e) {
    log?.error?.('продажа не записана ПОСЛЕ успешной фискализации — фискальный чек «висит», нужен чек коррекции', e)
    throw e
  }
}

// ── Открытие смены кассы: сначала открыть смену на устройстве ──
export async function fiscalOpenShift(ctx, fiskal) {
  if (!hasPerm(ctx.user, 'shift.open')) throw forbidden(RIGHTS)
  if (myOpenShift(ctx.db, ctx.deviceId)) throw bad('Смена уже открыта')
  // Уже открытая смена на устройстве — не ошибка: просто продолжаем
  const r = await fiskal.send('openShift', openShiftReq({ cashier: ctx.user.name, externalId: newId() }))
  if (!r.ok && r.code !== 'SHIFT_MUST_BE_CLOSED') throw fiscalError(r)
  return openShift(ctx, ctx.body)
}

// ── Закрытие смены кассы: сначала закрыть смену на устройстве (Z-отчёт) ──
export async function fiscalCloseShift(ctx, fiskal) {
  if (!hasPerm(ctx.user, 'shift.open')) throw forbidden(RIGHTS)
  const open = myOpenShift(ctx.db, ctx.deviceId)
  if (!open) throw bad('Нет открытой смены')
  if (!mayCloseShift(open.body, ctx.user)) throw bad(NOT_YOUR_SHIFT)
  // Уже закрытая смена на устройстве — не ошибка
  const r = await fiskal.send('closeShift', closeShiftReq({ cashier: ctx.user.name, externalId: newId() }))
  if (!r.ok && r.code !== 'SHIFT_MUST_BE_OPENED') throw fiscalError(r)
  return closeShift(ctx, ctx.body)
}
