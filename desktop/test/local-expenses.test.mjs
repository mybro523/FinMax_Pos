// ── Расходы магазина без интернета ──
//
// Владелец вносит расход и тогда, когда связи нет: запись ложится в локальную базу
// и уходит на сервер позже. Самое тонкое здесь — расход «из кассы». Денег в ящике
// уже нет, и касса обязана помнить об этом каждую минуту: пока расход не отправлен,
// когда сервер его принял, а свежая смена от него ещё не пришла, и когда пришла.
// Ни в одном из этих состояний сумма не должна ни потеряться, ни посчитаться дважды —
// иначе смена «не сойдётся» у кассира, который ни в чём не ошибся.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { matchLocal } from '../src/local/api.mjs'
import { getMeta, openDb, setMeta } from '../src/local/db.mjs'
import { listDocs, listShifts, myOpenShift } from '../src/local/docs.mjs'
import { cashSources, createExpense, expenseCategoriesList, expenseDate, NO_OPEN_SHIFT, NO_SUCH_CATEGORY } from '../src/local/ops/expense.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift, shiftView } from '../src/local/ops/shift.mjs'
import { ackOp, describeOp, pendingOps, rejectedOps, rejectOp, touchedBy } from '../src/local/outbox.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { ctx, EXPENSE_CATEGORIES, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

const iso = (t) => new Date(t).toISOString()
const apteka = () => pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })] })
const ops = (db) => pendingOps(db, 100)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const up = (...list) => ({ upsert: list, remove: [] })
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
// Сколько расходов из кассы числится за открытой сменой — как это видит окно
const cashOut = (db, deviceId = 'kassa-1') => shiftView(db, listShifts(db, deviceId).find((s) => !s.closedAt)).expenseCash
// Смена, о которой сервер уже знает
function openedShift(db, openingCash = 100) {
  const shift = openShift(ctx(db), { openingCash })
  ackOp(db, opOf(db, 'shift.open'))
  return shift
}

// ── Обычный расход ──

test('расход вносится без связи: ложится в журнал таким, каким его отдаёт сервер, и встаёт в очередь на отправку', () => {
  const db = apteka()
  const e = createExpense(ctx(db), { category: ' Аренда ', amount: 1500.456, note: '  за октябрь ', date: '2026-10-01', clientId: 'exp_1' })
  assert.deepEqual(e, {
    id: e.id,
    clientId: 'exp_1',
    // День без времени — полдень по Душанбе: расход остаётся в своём дне в любом поясе
    date: '2026-10-01T07:00:00.000Z',
    category: 'Аренда',
    amount: 1500.46,
    note: 'за октябрь',
    fromCash: false,
    shiftId: null,
    userId: 'user-1',
    createdAt: iso(NOW),
    user: { id: 'user-1', name: 'kassir' },
  })
  assert.deepEqual(listDocs(db, 'expense'), [e])
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'pending')

  const [op] = ops(db)
  assert.equal(op.type, 'expense')
  assert.equal(op.accountId, 'acc-1')
  // Серверу — только сам расход, без лишнего: кто внёс, он знает по учётной записи
  assert.deepEqual(op.payload, {
    expense: { id: e.id, date: '2026-10-01T07:00:00.000Z', category: 'Аренда', amount: 1500.46, note: 'за октябрь', fromCash: false, shiftId: null },
    deviceId: 'kassa-1',
  })

  // Окно переиграло запрос после заминки — второго расхода нет
  const again = createExpense(ctx(db), { category: 'Аренда', amount: 1500.456, date: '2026-10-01', clientId: 'exp_1' })
  assert.equal(again.id, e.id)
  assert.equal(listDocs(db, 'expense').length, 1)
  assert.equal(ops(db).length, 1)
})

test('дата расхода: без даты и «сегодня» — сейчас, прошедший день — его полдень, будущее и мусор — отказ', () => {
  // NOW — 4 октября 2026, 15:00 по Душанбе
  assert.equal(expenseDate(undefined, NOW), iso(NOW))
  assert.equal(expenseDate('', NOW), iso(NOW))
  assert.equal(expenseDate('2026-10-04', NOW), iso(NOW), 'сегодняшний день — это сейчас, а не полдень')
  assert.equal(expenseDate('2026-10-03', NOW), '2026-10-03T07:00:00.000Z')
  // Сразу после полуночи по Душанбе по Гринвичу ещё вчера — день всё равно сегодняшний
  const night = Date.parse('2026-10-04T19:10:00.000Z')
  assert.equal(expenseDate('2026-10-05', night), iso(night))
  refused(() => expenseDate('2026-10-05', NOW), 400, 'Дата расхода не может быть в будущем')
  refused(() => expenseDate('2027-01-01', NOW), 400, 'Дата расхода не может быть в будущем')
  for (const bad of ['вчера', '2026-13-45', '99999-01-01']) refused(() => expenseDate(bad, NOW), 400, 'Дата расхода: неверная дата')
  // Часы кассы и сервера расходятся на минуты — это не «будущее»
  assert.equal(expenseDate(iso(NOW + 3 * 60000), NOW), iso(NOW + 3 * 60000))
})

test('расход: отказы — теми же словами, что у сервера, и без следов в базе', () => {
  const db = apteka()
  const c = ctx(db)
  refused(() => createExpense(c, { category: 'Охрана', amount: 10 }), 400, NO_SUCH_CATEGORY)
  refused(() => createExpense(c, { category: '   ', amount: 10 }), 400, 'Укажите статью расхода')
  refused(() => createExpense(c, { amount: 10 }), 400, 'Категория: только текст')
  refused(() => createExpense(c, { category: 'Аренда', amount: 0 }), 400, 'Сумма: не меньше 0.01')
  refused(() => createExpense(c, { category: 'Аренда', amount: -5 }), 400, 'Сумма: не меньше 0.01')
  refused(() => createExpense(c, { category: 'Аренда', amount: '10' }), 400, 'Сумма: только число')
  refused(() => createExpense(c, { category: 'Аренда', amount: 1e12 }), 400, 'Сумма: не больше 9999999999.99')
  refused(() => createExpense(c, { category: 'Аренда', amount: 10, date: '2026-10-09' }), 400, 'Дата расхода не может быть в будущем')
  refused(() => createExpense(c, { category: 'Аренда', amount: 10, date: 'когда-то' }), 400, 'Дата расхода: неверная дата')
  refused(() => createExpense(c, { category: 'Аренда', amount: 10, note: 'х'.repeat(501) }), 400, 'Примечание: не длиннее 500 символов')
  refused(() => createExpense(c, { category: 'Аренда', amount: 10, fromCash: 'да' }), 400, 'Из кассы: только «да» или «нет»')
  // Расход из кассы без открытой смены привязать не к чему
  refused(() => createExpense(c, { category: 'Аренда', amount: 10, fromCash: true }), 400, NO_OPEN_SHIFT)
  assert.equal(listDocs(db, 'expense').length, 0)
  assert.equal(ops(db).length, 0)
  // Тексты — слово в слово как у сервера (server/src/expenses/expenses.service.ts)
  assert.equal(NO_OPEN_SHIFT, 'Нет открытой смены — расход из кассы привязать не к чему. Откройте смену или снимите отметку «из кассы».')
  assert.equal(NO_SUCH_CATEGORY, 'Этой статьи расходов уже нет в списке — добавьте её в настройках')
})

// ── Расход из кассы ──

test('расход из кассы ложится в смену этой кассы и сразу уменьшает «ожидается в кассе»', () => {
  const db = apteka()
  const c = ctx(db)
  assert.deepEqual(cashSources(db, 'kassa-1'), [], 'смены нет — брать деньги неоткуда')
  const shift = openShift(c, { openingCash: 100 })
  assert.deepEqual(cashSources(db, 'kassa-1'), [{ shiftId: shift.id, deviceId: 'kassa-1', deviceName: '', openedAt: shift.openedAt }])
  assert.equal(cashOut(db), 0)
  checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })

  // Дата расхода из кассы — «сейчас», что бы ни прислало окно: он принадлежит смене
  const taxi = createExpense({ ...c, now: NOW + 60000 }, { category: 'Транспорт', amount: 40, fromCash: true, shiftId: shift.id, date: '2026-09-01' })
  assert.equal(taxi.fromCash, true)
  assert.equal(taxi.shiftId, shift.id)
  assert.equal(taxi.date, iso(NOW + 60000))
  assert.equal(opOf(db, 'expense').payload.expense.shiftId, shift.id)
  assert.equal(cashOut(db), 40)

  createExpense(c, { category: 'Другое', amount: 10.5, fromCash: true })
  assert.equal(cashOut(db), 50.5)
  // Обычный расход наличные в ящике не трогает
  createExpense(c, { category: 'Аренда', amount: 999 })
  assert.equal(cashOut(db), 50.5)
  // Окно назвало не ту смену (её закрыли, пока форма была открыта) — отказ, а не чужая смена
  refused(() => createExpense(c, { category: 'Другое', amount: 1, fromCash: true, shiftId: 'другая' }), 400, NO_OPEN_SHIFT)

  // Закрытие: 100 на начало + 150 наличными − 50.5 расходов
  const closed = closeShift({ ...c, now: NOW + 3600_000 }, { countedCash: 199.5 })
  assert.deepEqual([closed.salesCash, closed.expenseCash, closed.expectedCash, closed.difference], [150, 50.5, 199.5, 0])
  // Прибыль смены расходами не уменьшается: это прибыль от продаж за смену
  assert.equal(closed.profit, 50)
  assert.deepEqual(Object.keys(closed), [
    'id', 'openedAt', 'closedAt', 'openingCash', 'countedCash', 'totalSales', 'salesCash', 'salesCard', 'salesDebt', 'debtPaid',
    'refundCash', 'refundTotal', 'refundCost', 'expenseCash', 'cashIn', 'cashOut', 'supplierCash', 'salesTransfer', 'transferBy', 'profit',
    'discount', 'count', 'expectedCash', 'difference', 'userId', 'user',
  ])
  // Смена закрыта — брать из неё деньги больше нельзя
  assert.deepEqual(cashSources(db, 'kassa-1'), [])
  refused(() => createExpense(c, { category: 'Другое', amount: 1, fromCash: true }), 400, NO_OPEN_SHIFT)
})

test('сервер принял расход из кассы: сумма не теряется, пока свежая смена от него не пришла, и не задваивается, когда пришла', () => {
  const db = apteka()
  const c = ctx(db)
  const shift = openedShift(db)
  const e = createExpense(c, { category: 'Транспорт', amount: 40, fromCash: true })
  assert.equal(cashOut(db), 40, 'пока не отправлен — прибавляется здесь')

  // Сервер принял. Связь могла оборваться сразу после этого — свежей смены ещё нет
  const op = opOf(db, 'expense')
  ackOp(db, op, { status: 'ok', docId: e.id })
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'synced')
  assert.equal(cashOut(db), 40, 'расход принят, а из суммы смены пропал — «ожидается в кассе» выросло бы обратно')
  // Повторное «принято» (ответ пришёл и на отправку, и на вопрос о судьбе) ничего не добавляет
  ackOp(db, op, { status: 'ok', docId: e.id })
  assert.equal(cashOut(db), 40)

  // Пришла смена с сервера — в ней расход уже посчитан
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', expenseCash: 40 }), expenses: up({ ...e, clientId: null }) })
  assert.equal(cashOut(db), 40, 'принятый расход посчитан дважды')

  // Владелец взял из этой же кассы ещё 15 — уже на сайте. Касса узнаёт об этом из смены
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', expenseCash: 55 }) }, '110')
  assert.equal(cashOut(db), 55)
  // И ещё один — здесь, без связи: к тому, что знает сервер, прибавляется своё
  createExpense(c, { category: 'Другое', amount: 5, fromCash: true })
  assert.equal(cashOut(db), 60)
  const closed = closeShift(c, { countedCash: 40 })
  assert.deepEqual([closed.expenseCash, closed.expectedCash, closed.difference], [60, 40, 0])
})

test('смена ещё не дошла до сервера: расходы из неё считаются здесь, а после отправки — ровно один раз', () => {
  const db = apteka()
  const c = ctx(db)
  const shift = openShift(c, { openingCash: 100 })
  createExpense(c, { category: 'Транспорт', amount: 40, fromCash: true })
  assert.equal(cashOut(db), 40)
  // Очередь уходит по порядку: открытие смены, затем расход
  assert.deepEqual(ops(db).map((o) => o.type), ['shift.open', 'expense'])
  ackOp(db, opOf(db, 'shift.open'))
  assert.equal(cashOut(db), 40)
  ackOp(db, opOf(db, 'expense'))
  assert.equal(cashOut(db), 40)
  assert.equal(myOpenShift(db, 'kassa-1').body.expenseCash, 40, 'принятый расход перешёл в сумму самой смены')
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', expenseCash: 40 }) })
  assert.equal(cashOut(db), 40)
})

test('расход принят, когда смена уже закрыта здесь: её итоги посчитаны с ним, второй раз он не прибавляется', () => {
  const db = apteka()
  const c = ctx(db)
  const shift = openedShift(db)
  createExpense(c, { category: 'Транспорт', amount: 40, fromCash: true })
  const closed = closeShift(c, { countedCash: 60 })
  assert.deepEqual([closed.expenseCash, closed.expectedCash], [40, 60])
  ackOp(db, opOf(db, 'expense'))
  const kept = listShifts(db, 'kassa-1').find((s) => s.id === shift.id)
  assert.deepEqual([kept.expenseCash, kept.expectedCash], [40, 60])
})

test('сервер отверг расход из кассы: он снят с учёта, деньги снова числятся в ящике, владелец видит отказ', () => {
  const db = apteka()
  const c = ctx(db)
  openedShift(db)
  const e = createExpense(c, { category: 'Транспорт', amount: 40, note: 'такси', fromCash: true })
  const op = opOf(db, 'expense')
  rejectOp(db, op, 'Недостаточно прав')
  assert.equal(cashOut(db), 0)
  assert.deepEqual(listDocs(db, 'expense'), [], 'отвергнутого расхода в журнале нет')
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'expense'").sync, 'rejected')
  // В списке «не принято сервером» он показан целиком — по нему его вносят заново
  const [bad] = rejectedOps(db)
  assert.equal(bad.error, 'Недостаточно прав')
  assert.deepEqual(describeOp(bad), { sum: 40, title: 'Транспорт', detail: { category: 'Транспорт', note: 'такси', date: e.date, fromCash: true } })
  // Окну — какие разделы перечитать
  assert.deepEqual(touchedBy(bad), ['expenses', 'shifts'])
  assert.equal(getMeta(db, 'needFull'), '1', 'после отказа касса забирает у сервера всё заново')
})

test('закрытие смены отвергнуто: смена снова открыта, а неотправленный расход из кассы не посчитан дважды', () => {
  // Расход ещё не принят сервером: при закрытии он вошёл в итог, у открытой смены
  // прибавляется отдельно
  const a = apteka()
  openedShift(a)
  createExpense(ctx(a), { category: 'Транспорт', amount: 40, fromCash: true })
  closeShift(ctx(a), { countedCash: 60 })
  rejectOp(a, opOf(a, 'shift.close'), 'Недопустимая дата: закрытие смены')
  assert.equal(myOpenShift(a, 'kassa-1').body.expenseCash, 0, 'сервер этого расхода ещё не знает')
  assert.equal(cashOut(a), 40)

  // Один расход сервер уже принял, второй — нет
  const b = apteka()
  openedShift(b)
  createExpense(ctx(b), { category: 'Транспорт', amount: 40, fromCash: true })
  ackOp(b, opOf(b, 'expense'))
  createExpense(ctx(b), { category: 'Другое', amount: 10, fromCash: true })
  assert.equal(closeShift(ctx(b), { countedCash: 50 }).expenseCash, 50)
  rejectOp(b, opOf(b, 'shift.close'), 'Недопустимая дата: закрытие смены')
  assert.equal(myOpenShift(b, 'kassa-1').body.expenseCash, 40)
  assert.equal(cashOut(b), 50)
  // И закрыть её заново можно — с той же суммой
  assert.deepEqual([closeShift(ctx(b), { countedCash: 50 }).expenseCash], [50])
})

test('за кассой только кассир: расходов у кассы нет, а сумма «из кассы» приходит в самой смене', () => {
  const db = apteka()
  const cashier = ctx(db, { user: { accountId: 'acc-2', id: 'user-2', name: 'nilufar', role: 'cashier' } })
  const shift = openShift(cashier, { openingCash: 200 })
  ackOp(db, opOf(db, 'shift.open'))
  // Владелец на сайте взял из ящика этой кассы 25. Кассиру сервер расходы не отдаёт —
  // только смену
  delta(db, { shifts: up({ ...shift, deviceId: 'kassa-1', expenseCash: 25 }) })
  assert.equal(listDocs(db, 'expense').length, 0)
  assert.equal(cashOut(db), 25)
  const closed = closeShift(cashier, { countedCash: 175 })
  assert.deepEqual([closed.expenseCash, closed.expectedCash, closed.difference], [25, 175, 0])
})

// ── Что касса отвечает сама и кому ──

test('расходы и статьи — только владельцу: кассиру касса отказывает так же, как сервер', () => {
  const db = apteka()
  const call = (method, path, user, body) => {
    const found = matchLocal(method, path)
    return found.handler({ ...ctx(db, user ? { user } : {}), query: found.query, params: found.params, body })
  }
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'nilufar', role: 'cashier' }
  for (const [method, path] of [['GET', '/expenses'], ['GET', '/expenses/cash-sources'], ['GET', '/expense-categories'], ['POST', '/expenses']]) {
    refused(() => call(method, path, cashier, { category: 'Аренда', amount: 10 }), 403, 'Недостаточно прав')
  }
  assert.equal(listDocs(db, 'expense').length, 0)

  // Владельцу: внести, прочитать журнал и список статей
  const e = call('POST', '/expenses', null, { category: 'Аренда', amount: 10 })
  assert.deepEqual(call('GET', '/expenses?days=180'), [e])
  assert.deepEqual(call('GET', '/expense-categories').map((x) => x.name), ['Аренда', 'Другое', 'Зарплата', 'Налоги', 'Транспорт'])
  assert.deepEqual(call('GET', '/expenses/cash-sources'), [])
  // «За всё время» и давние даты касса у себя не держит — за ними идут на сервер
  assert.deepEqual(call('GET', '/expenses?days=0'), { __deep: { kind: 'expense', from: null, to: null } })

  // Смена в списке смен — с расходами из кассы, которых сервер ещё не знает
  openShift(ctx(db), { openingCash: 0 })
  call('POST', '/expenses', null, { category: 'Транспорт', amount: 7, fromCash: true })
  assert.equal(call('GET', '/shifts')[0].expenseCash, 7)

  // Править и удалять расход, менять статьи касса сама не умеет — это запросы к серверу
  for (const [method, path] of [['PATCH', '/expenses/abc'], ['DELETE', '/expenses/abc'], ['POST', '/expense-categories'], ['DELETE', '/expense-categories/abc']]) {
    assert.equal(matchLocal(method, path), null, `${method} ${path} не должен обслуживаться локально`)
  }
})

// ── Обмен с сервером ──

test('обмен: расходы и статьи приходят владельцу; обмены кассира их не трогают', () => {
  const db = apteka()
  const mine = createExpense(ctx(db), { category: 'Аренда', amount: 10 })
  const fromSite = { id: 'e-site', date: '2026-10-03T07:00:00.000Z', category: 'Зарплата', amount: 1800, note: '', fromCash: false, shiftId: null, user: { id: 'u', name: 'hoz' } }
  const all = (list) => ({ upsert: list, remove: [] })

  // Владелец получает всё заново: расходы сервера и его список статей
  const changed = applyPull(
    db,
    { full: true, cursor: '10', data: { products: all([]), sales: all([]), writeoffs: all([]), expenses: all([fromSite]), expenseCategories: all([...EXPENSE_CATEGORIES, { id: 'c-own', name: 'Охрана' }]) } },
    { now: NOW },
  )
  assert.ok(changed.includes('expenses') && changed.includes('expenseCategories'), 'окно должно перечитать расходы и статьи: ' + changed)
  // Свой неотправленный расход остаётся — сервер о нём ещё не знает
  assert.deepEqual(listDocs(db, 'expense').map((e) => e.id).sort(), [fromSite.id, mine.id].sort())
  assert.deepEqual(expenseCategoriesList(db).map((c) => c.name), ['Аренда', 'Другое', 'Зарплата', 'Налоги', 'Охрана', 'Транспорт'])
  // Своя статья сразу годится для расхода без связи
  assert.equal(createExpense(ctx(db), { category: 'Охрана', amount: 5 }).category, 'Охрана')

  // Частичный ответ владельцу: расход поправили на сайте, статью убрали. (Разделы
  // владельца сервер отдаёт все вместе — и списания тоже, хоть бы и пустые.)
  delta(db, { writeoffs: up(), expenses: up({ ...fromSite, amount: 2000 }), expenseCategories: { upsert: [], remove: ['c-own'] } }, '20')
  assert.equal(listDocs(db, 'expense').find((e) => e.id === fromSite.id).amount, 2000)
  assert.ok(!expenseCategoriesList(db).some((c) => c.name === 'Охрана'))
  refused(() => createExpense(ctx(db), { category: 'Охрана', amount: 5 }), 400, NO_SUCH_CATEGORY)
  // Расход удалили на сайте — касса убирает его и у себя
  delta(db, { writeoffs: up(), expenses: { upsert: [], remove: [fromSite.id] }, expenseCategories: up() }, '30')
  assert.ok(!listDocs(db, 'expense').some((e) => e.id === fromSite.id))

  // За кассой кассир: этих разделов в ответах нет — что лежало, то и лежит, а отметка
  // разделов владельца стоит на месте: по ней он доберёт пропущенное
  delta(db, { products: up() }, '40')
  assert.equal(listDocs(db, 'expense').length, 2)
  assert.equal(expenseCategoriesList(db).length, EXPENSE_CATEGORIES.length)
  assert.deepEqual([getMeta(db, 'cursor'), getMeta(db, 'wcursor')], ['40', '30'])
})

test('обновление программы с прежней версии: список статей появляется, а владелец получает расходы и статьи заново', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'apteka-exp-')), 'p.db')
  // Версия 1.0.0: базу создал первый шаг схемы, касса уже обменивалась с сервером
  let db = openDb(file, PHARMACY_SCHEMA.slice(0, 1))
  setMeta(db, 'cursor', '500')
  setMeta(db, 'wcursor', '500')
  setMeta(db, 'loaded', '1')
  db.prepare("INSERT INTO docs (kind, id, date, body, sync) VALUES ('sale', 's1', '2026-10-01T00:00:00.000Z', '{\"id\":\"s1\"}', 'pending')").run()
  db.close()

  // Версия 1.0.1 открывает ту же базу
  db = openDb(file, PHARMACY_SCHEMA)
  assert.deepEqual(rows(db, 'SELECT * FROM expense_categories'), [])
  // Отметок «докуда получили» нет ни общей, ни владельца: первый обмен будет полным и
  // принесёт то, чего прежняя версия не брала, — статьи с расходами, поставщиков и
  // сервисы перевода (версия 1.0.2 сбрасывает обе отметки, см. schema.mjs). Загруженной
  // база при этом считается — без связи касса работает на том, что есть
  assert.equal(getMeta(db, 'cursor'), null)
  assert.equal(getMeta(db, 'loaded'), '1')
  assert.equal(getMeta(db, 'wcursor'), null)
  assert.deepEqual(rows(db, 'SELECT * FROM suppliers'), [])
  assert.deepEqual(rows(db, 'SELECT * FROM pay_services'), [])
  // Сделанное до обновления и не отправленное — на месте
  assert.equal(row(db, "SELECT sync FROM docs WHERE id = 's1'").sync, 'pending')
  db.close()
  // Повторный запуск ничего не выполняет заново
  db = openDb(file, PHARMACY_SCHEMA)
  setMeta(db, 'wcursor', '600')
  db.close()
  db = openDb(file, PHARMACY_SCHEMA)
  assert.equal(getMeta(db, 'wcursor'), '600')
  db.close()
})
