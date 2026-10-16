// ── Доходы без интернета и закрытие чужой смены ──
//
// Доход вносится и без связи, как расход: ложится в журнал в серверном виде и уходит
// на сервер очередью. Смену закрывает тот, кто её открыл, или тот, кому разрешено
// закрывать чужие (владелец — всегда): кассир не подпишет своим пересчётом деньги
// владельца.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal } from '../src/local/api.mjs'
import { listDocs } from '../src/local/docs.mjs'
import { createIncome, incomeCategoriesList, incomeDate, NO_SUCH_INCOME_CATEGORY } from '../src/local/ops/income.mjs'
import { closeShift, mayCloseShift, NOT_YOUR_SHIFT, openShift } from '../src/local/ops/shift.mjs'
import { ackOp, describeOp, pendingOps, touchedBy } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { ctx, NOW, pharmacy, refused, row } from '../test-support/pharmacy.mjs'

const ops = (db) => pendingOps(db, 100)
const call = (db, method, path, over = {}) => {
  const found = matchLocal(method, path)
  assert.ok(found, `маршрут ${method} ${path} не найден`)
  return found.handler({ db, now: NOW, deviceId: 'kassa-1', query: found.query, params: found.params, body: over.body, user: over.user })
}
const founder = { accountId: 'acc-1', id: 'user-1', name: 'admin', role: 'founder', permissions: [] }
const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassir', role: 'cashier', permissions: ['pos.sell', 'shift.view', 'shift.open', 'shift.cash'] }

test('доход вносится без связи: журнал в серверном виде и очередь на отправку', () => {
  const db = pharmacy()
  const inc = createIncome(ctx(db), { category: ' Аренда ', amount: 1200.456, note: '  склад ', date: '2026-10-01', clientId: 'inc_1' })
  assert.equal(inc.category, 'Аренда')
  assert.equal(inc.amount, 1200.46)
  assert.equal(inc.note, 'склад')
  assert.equal(inc.date, '2026-10-01T07:00:00.000Z')
  assert.deepEqual(inc.user, { id: 'user-1', name: 'kassir' })
  assert.deepEqual(listDocs(db, 'income'), [inc])
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'income'").sync, 'pending')

  const [op] = ops(db)
  assert.equal(op.type, 'income')
  assert.deepEqual(op.payload, {
    income: { id: inc.id, date: '2026-10-01T07:00:00.000Z', category: 'Аренда', amount: 1200.46, note: 'склад' },
    deviceId: 'kassa-1',
  })
  // Повтор того же запроса — второго дохода нет
  assert.equal(createIncome(ctx(db), { category: 'Аренда', amount: 1200.456, date: '2026-10-01', clientId: 'inc_1' }).id, inc.id)
  assert.equal(ops(db).length, 1)

  // Для списка «не принято сервером» — что это было
  assert.equal(describeOp(op).title, 'Аренда')
  assert.equal(describeOp(op).sum, 1200.46)
  assert.deepEqual(touchedBy(op), ['incomes'])

  // Сервер принял — документ больше не «ждёт отправки»
  ackOp(db, op)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'income'").sync, 'synced')
})

test('доход: статья из списка, сумма больше нуля, дата не в будущем', () => {
  const db = pharmacy()
  refused(() => createIncome(ctx(db), { category: 'Нет такой', amount: 10 }), 400, NO_SUCH_INCOME_CATEGORY)
  assert.throws(() => createIncome(ctx(db), { category: 'Аренда', amount: 0 }))
  refused(() => createIncome(ctx(db), { category: 'Аренда', amount: 10, date: '2026-10-20' }), 400, 'Дата дохода не может быть в будущем')
  assert.equal(incomeDate('2026-10-04', NOW), new Date(NOW).toISOString())
  assert.deepEqual(incomeCategoriesList(db).map((c) => c.name), ['Аренда', 'Бонус от поставщика', 'Прочие доходы', 'Услуги'])
})

test('доходы и статьи приходят с сервера и отдаются окну по правам', () => {
  const db = pharmacy()
  applyPull(
    db,
    {
      full: false,
      cursor: '50',
      data: {
        incomes: { upsert: [{ id: 'srv-inc', date: '2026-10-03T08:00:00.000Z', category: 'Услуги', amount: 300, note: '', user: { id: 'u', name: 'admin' } }], remove: [] },
        incomeCategories: { upsert: [{ id: 'inccat-9', name: 'Проценты банка', createdAt: '' }], remove: ['inccat-2'] },
      },
    },
    { now: NOW },
  )
  const list = call(db, 'GET', '/incomes', { user: founder })
  assert.deepEqual(list.map((x) => x.id), ['srv-inc'])
  assert.deepEqual(call(db, 'GET', '/income-categories', { user: founder }).map((c) => c.name), ['Аренда', 'Бонус от поставщика', 'Проценты банка', 'Прочие доходы'])
  // Кассиру без права доходы не отдаются
  assert.throws(() => call(db, 'GET', '/incomes', { user: cashier }), /Недостаточно прав/)
  // Внести доход без права тоже нельзя
  assert.throws(() => call(db, 'POST', '/incomes', { user: cashier, body: { category: 'Аренда', amount: 5 } }), /Недостаточно прав/)
})

test('смену закрывает тот, кто открыл; чужую — только с правом; владелец — всегда', () => {
  const db = pharmacy()
  // Смену открыл владелец
  openShift(ctx(db, { user: { ...founder } }), { openingCash: 100 })
  // Кассир за этой же кассой закрыть её не может
  refused(() => closeShift(ctx(db, { user: { ...cashier } }), { countedCash: 100 }), 400, NOT_YOUR_SHIFT)
  // С правом «закрыть смену другого сотрудника» — может
  const withRight = { ...cashier, permissions: [...cashier.permissions, 'shift.closeAny'] }
  assert.equal(mayCloseShift(listDocs(db, 'shift')[0], withRight), true)
  // Сам владелец — может
  const closed = closeShift(ctx(db, { user: { ...founder } }), { countedCash: 100 })
  assert.ok(closed.closedAt)
})

test('свою смену кассир закрывает; смену прежней версии без открывшего — тоже', () => {
  const db = pharmacy()
  openShift(ctx(db, { user: { ...cashier } }), { openingCash: 50 })
  assert.ok(closeShift(ctx(db, { user: { ...cashier } }), { countedCash: 50 }).closedAt)
  assert.equal(mayCloseShift({ id: 's', userId: null, user: null }, cashier), true)
  assert.equal(mayCloseShift({ id: 's', userId: 'user-9', user: { id: 'user-9', name: 'other' } }, cashier), false)
  // Номер сотрудника ещё не известен (acc:…), но имя то же — своя
  assert.equal(mayCloseShift({ id: 's', userId: 'acc:acc-2', user: { id: 'acc:acc-2', name: 'kassir' } }, { ...cashier, id: 'user-2' }), true)
})
