// ── Доходы вне продаж ──
//
// Перенос серверных доходов (server/src/incomes/incomes.service.ts). Деньги, которые
// магазин получил не за проданный товар: сдал часть помещения, оказал услугу, получил
// бонус от поставщика. Владелец вносит доход и без интернета: он ложится в локальную
// базу и уходит на сервер, когда появится связь, — как расход.
//
// В денежный ящик смены доход не попадает (наличные в ящик вносятся «Внесением»),
// поэтому у него нет ни отметки «из кассы», ни смены.
//
// Править и удалять доход касса сама не умеет: это делает сервер, и для этого нужна
// связь (см. gateway.mjs). Здесь — только то, что должно работать без неё.
import { bodyOf, checker, MAX_MONEY } from '../check.mjs'
import { bad, inTx, newId, q } from '../db.mjs'
import { docByClientId, enqueue, putDoc } from '../docs.mjs'
import { fromCents, toCents } from '../money.mjs'
import { dayKeyTj } from '../time.mjs'

// Тексты отказов — слово в слово как у сервера
export const NO_SUCH_INCOME_CATEGORY = 'Этой статьи доходов уже нет в списке — добавьте её в настройках'

// Часы кассы и сервера расходятся не больше чем на минуты
const FUTURE_SLACK_MS = 5 * 60 * 1000
const MIN_DATE_MS = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_DATE_MS = Date.parse('9999-12-31T23:59:59.999Z')

// То же правило даты, что на сервере (incomeDate): день без времени — полдень по
// Душанбе, сегодняшний день — «сейчас», будущим числом доход не вносят
export function incomeDate(raw, now) {
  if (raw === undefined || raw === null || raw === '') return new Date(now).toISOString()
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  if (plainDay && raw === dayKeyTj(now)) return new Date(now).toISOString()
  const t = Date.parse(plainDay ? raw + 'T12:00:00.000+05:00' : raw)
  if (!Number.isFinite(t) || t < MIN_DATE_MS || t > MAX_DATE_MS) throw bad('Дата дохода: неверная дата')
  if (t > now + FUTURE_SLACK_MS) throw bad('Дата дохода не может быть в будущем')
  return new Date(t).toISOString()
}

// ── Статьи доходов ──
// Список приходит с сервера (snapshot.mjs); здесь — только чтение, по алфавиту
const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
export const incomeCategoriesList = (db) =>
  q(db, 'SELECT id, name, createdAt FROM income_categories')
    .all()
    .sort((a, b) => byName.compare(a.name, b.name))

export function createIncome(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const rawCategory = c.str(dto.category, 'category', { min: 1 })
  const amount = c.num(dto.amount, 'amount', { min: 0.01, max: MAX_MONEY })
  const note = c.str(dto.note, 'note', { optional: true })
  const rawDate = c.str(dto.date, 'date', { optional: true })
  const clientId = c.str(dto.clientId, 'clientId', { optional: true })
  c.done()

  return inTx(db, () => {
    // Тот же запрос пришёл второй раз — второго дохода не заводим
    if (clientId) {
      const already = docByClientId(db, 'income', clientId)
      if (already) return already.body
    }

    const category = rawCategory.trim()
    if (!category) throw bad('Укажите статью дохода')
    if (category.length > 60) throw bad('Категория: не длиннее 60 символов')
    if (!q(db, 'SELECT 1 FROM income_categories WHERE name = ?').get(category)) throw bad(NO_SUCH_INCOME_CATEGORY)
    if ((note || '').length > 500) throw bad('Примечание: не длиннее 500 символов')

    const at = new Date(now).toISOString()
    const body = {
      id: newId(),
      clientId: clientId || null,
      date: incomeDate(rawDate, now),
      category,
      amount: fromCents(toCents(amount)),
      note: (note || '').trim(),
      userId: ctx.user.id,
      createdAt: at,
      user: { id: ctx.user.id, name: ctx.user.name },
    }
    putDoc(db, 'income', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: newId(),
      type: 'income',
      accountId: ctx.user.accountId,
      payload: {
        // Серверу — только сам доход: кто его внёс, он знает по учётной записи
        income: { id: body.id, date: body.date, category, amount: body.amount, note: body.note },
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
