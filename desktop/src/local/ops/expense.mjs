// ── Расходы магазина ──
//
// Перенос серверных расходов (server/src/expenses/expenses.service.ts). Аренда,
// зарплата, свет, налоги — всё, на что магазин тратит деньги помимо закупки товара.
// Владелец вносит расход и без интернета: он ложится в локальную базу и уходит на
// сервер, когда появится связь, — как списание.
//
// Расход бывает оплачен наличными из кассы. Тогда он привязан к открытой смене ЭТОЙ
// кассы и уменьшает наличные, которые в ней ждут: денег в ящике уже нет. Дата у него
// всегда «сейчас» — он принадлежит смене, а смена идёт сейчас.
//
// Править и удалять расход касса сама не умеет: это делает сервер, и для этого нужна
// связь (см. gateway.mjs). Здесь — только то, что должно работать без неё.
import { bodyOf, checker, MAX_MONEY } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { docByClientId, enqueue, myOpenShift, putDoc } from '../docs.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { dayKeyTj } from '../time.mjs'

// Тексты отказов — слово в слово как у сервера: человек читает их с экрана, и
// откуда пришёл ответ, он знать не должен
export const NO_OPEN_SHIFT = 'Нет открытой смены — расход из кассы привязать не к чему. Откройте смену или снимите отметку «из кассы».'
export const NO_SUCH_CATEGORY = 'Этой статьи расходов уже нет в списке — добавьте её в настройках'
// Месяц зарплаты: «2026-10» — как у сервера (server/src/expenses/dto.ts)
const SALARY_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
// День периода бонуса: «2026-10-10»
const BONUS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// Часы кассы и сервера расходятся не больше чем на минуты
const FUTURE_SLACK_MS = 5 * 60 * 1000
// Дальше 9999 года и раньше первого база сервера дат не хранит
const MIN_DATE_MS = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_DATE_MS = Date.parse('9999-12-31T23:59:59.999Z')

// День без времени (так его отдаёт поле даты) ставим на полдень по Душанбе: в какой бы
// часовой пояс ни попал отчёт, расход останется в своём дне. Сегодняшний день — это
// «сейчас»; будущим числом расход не вносят. То же правило, что на сервере (expenseDate)
export function expenseDate(raw, now) {
  if (raw === undefined || raw === null || raw === '') return new Date(now).toISOString()
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  if (plainDay && raw === dayKeyTj(now)) return new Date(now).toISOString()
  const t = Date.parse(plainDay ? raw + 'T12:00:00.000+05:00' : raw)
  if (!Number.isFinite(t) || t < MIN_DATE_MS || t > MAX_DATE_MS) throw bad('Дата расхода: неверная дата')
  if (t > now + FUTURE_SLACK_MS) throw bad('Дата расхода не может быть в будущем')
  return new Date(t).toISOString()
}

// ── Статьи расходов ──
// Список приходит с сервера (snapshot.mjs); здесь — только чтение. Порядок — по
// алфавиту, как отдаёт сервер
const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
export const expenseCategoriesList = (db) =>
  q(db, 'SELECT id, name, createdAt FROM expense_categories')
    .all()
    .sort((a, b) => byName.compare(a.name, b.name))

// ── Из какой кассы можно взять деньги ──
// У программы касса одна — своя: её открытая смена. Чужих ящиков отсюда не видно,
// да и брать из них деньги, стоя за этой кассой, некому
export function cashSources(db, deviceId) {
  const open = myOpenShift(db, deviceId)
  return open ? [{ shiftId: open.body.id, deviceId, deviceName: '', openedAt: open.body.openedAt }] : []
}

// ── Расходы из кассы, которых сервер ещё не учёл ──
// Сумму расходов из кассы сервер ведёт в самой смене (expenseCash), и она приходит
// с каждым обменом. Внесённое здесь и ещё не принятое им в эту сумму не входит —
// его прибавляем сами. Принял — прибавка переходит в сумму смены (outbox.mjs, ackOp)
export function pendingCashExpenses(db, shiftId) {
  let sum = D(0)
  const rows = q(db, "SELECT body FROM docs WHERE kind = 'expense' AND shiftId = ? AND sync = 'pending'").all(shiftId)
  for (const r of rows) {
    const e = JSON.parse(r.body)
    if (e.fromCash) sum = sum.plus(e.amount || 0)
  }
  return sum
}

// Сколько всего взято из кассы за смену: что уже знает сервер плюс своё неотправленное
export const expenseCashOf = (db, shift) => D(shift.expenseCash || 0).plus(pendingCashExpenses(db, shift.id))

export function createExpense(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const rawCategory = c.str(dto.category, 'category', { min: 1 })
  const amount = c.num(dto.amount, 'amount', { min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const rawDate = c.str(dto.date, 'date', { optional: true })
  const fromCash = c.bool(dto.fromCash, 'fromCash', { optional: true }) === true
  const askedShift = c.str(dto.shiftId, 'shiftId', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  // Зарплата: кому выдана. Имя запомнит сервер — по своему списку сотрудников
  const employeeId = c.str(dto.employeeId, 'employeeId', { optional: true })
  // И за какой месяц («2026-10»): по нему считается, сколько ещё осталось выдать
  const rawMonth = c.str(dto.salaryMonth, 'salaryMonth', { optional: true })
  // И за какие дни считали бонус от продаж — «с» и «по» включительно
  const rawFrom = c.str(dto.bonusFrom, 'bonusFrom', { optional: true })
  const rawTo = c.str(dto.bonusTo, 'bonusTo', { optional: true })
  c.done()
  if (rawMonth && !SALARY_MONTH.test(rawMonth)) throw bad('Месяц зарплаты — в виде ГГГГ-ММ, например 2026-10')
  for (const d of [rawFrom, rawTo]) if (d && !BONUS_DAY.test(d)) throw bad('Дата периода бонуса — в виде ГГГГ-ММ-ДД, например 2026-10-10')
  if (rawFrom && rawTo && rawFrom > rawTo) throw bad('Период бонуса: дата «с» позже даты «по»')
  const salaryMonth = employeeId ? rawMonth || '' : ''
  // Одна дата без другой — не период
  const withDays = !!(employeeId && rawFrom && rawTo)
  const bonusFrom = withDays ? rawFrom : ''
  const bonusTo = withDays ? rawTo : ''

  return inTx(db, () => {
    // Тот же запрос пришёл второй раз (окно переиграло его после заминки) — второго
    // расхода не заводим
    if (clientId) {
      const already = docByClientId(db, 'expense', clientId)
      if (already) return already.body
    }

    const category = rawCategory.trim()
    if (!category) throw bad('Укажите статью расхода')
    if (category.length > 60) throw bad('Категория: не длиннее 60 символов')
    if (!q(db, 'SELECT 1 FROM expense_categories WHERE name = ?').get(category)) throw bad(NO_SUCH_CATEGORY)
    if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

    let shiftId = null
    if (fromCash) {
      const open = myOpenShift(db, ctx.deviceId)
      // Смену могли закрыть, пока форма была открыта, — или окно назвало не ту
      if (!open || (askedShift && askedShift !== open.body.id)) throw bad(NO_OPEN_SHIFT)
      shiftId = open.body.id
    }

    const at = new Date(now).toISOString()
    const body = {
      id: newId(),
      clientId: clientId || null,
      // Расход из кассы принадлежит смене, а смена идёт сейчас
      date: fromCash ? at : expenseDate(rawDate, now),
      category,
      amount: fromCents(toCents(amount)),
      note: (note || '').trim(),
      fromCash,
      shiftId,
      employeeId: employeeId || null,
      employeeName: '',
      salaryMonth,
      bonusFrom,
      bonusTo,
      userId: ctx.user.id,
      createdAt: at,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'expense', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: newId(),
      type: 'expense',
      accountId: ctx.user.accountId,
      payload: {
        // Серверу — только сам расход: кто его внёс, он знает по учётной записи
        expense: {
          id: body.id, date: body.date, category, amount: body.amount, note: body.note, fromCash, shiftId,
          ...(employeeId ? { employeeId } : {}),
          ...(salaryMonth ? { salaryMonth } : {}),
          ...(withDays ? { bonusFrom, bonusTo } : {}),
        },
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
