// ── Доходы, смена своего пароля, закрытие чужой смены, ключ обмена по сети ──
//
// Четыре доработки одной партии, у каждой — свои правила, которые нельзя нарушить
// молча:
//   • доход, внесённый в программе без связи, разбирается так же строго, как расход;
//   • кассир по умолчанию не меняет свой пароль, владелец — всегда;
//   • смену закрывает тот, кто её открыл, или сотрудник с правом закрывать чужие;
//   • у всех касс магазина один ключ обмена по сети, у соседнего магазина — другой.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')

const { parseIncome, OP_TYPES, FOUNDER_ONLY, Reject } = require('../dist/sync/payload')
const { mayCloseShift, NOT_YOUR_SHIFT } = require('../dist/shifts/closer')
const { mayChangeOwnPassword, NO_PASSWORD_CHANGE, ALL_PERMISSIONS, CASHIER_DEFAULT, ROLE_PRESETS, OP_PERMISSIONS } = require('../dist/auth/permissions')
const { incomeDate } = require('../dist/incomes/incomes.service')
const { collectionsFor } = require('../dist/events/change-events.interceptor')
const { lanKeyOf } = require('../dist/sync/sync.service')

const NOW = Date.parse('2026-10-16T09:00:00Z')
const op = (income) => ({ income })

test('доход из программы: разбирается поле за полем', () => {
  const p = parseIncome(op({ id: 'inc-1', date: '2026-10-15T10:00:00Z', category: ' Аренда ', amount: 1500.5, note: 'за октябрь' }), NOW)
  assert.equal(p.id, 'inc-1')
  assert.equal(p.category, 'Аренда')
  assert.equal(p.amount, 1500.5)
  assert.equal(p.note, 'за октябрь')
  assert.equal(p.date.toISOString(), '2026-10-15T10:00:00.000Z')
})

test('доход из программы: мусор отвергается, а не записывается', () => {
  const day = '2026-10-15T10:00:00Z'
  assert.throws(() => parseIncome(op({ id: 'inc-1', date: day, category: 'Аренда', amount: 0 }), NOW), Reject)
  assert.throws(() => parseIncome(op({ id: 'inc-1', date: day, category: 'Аренда', amount: -5 }), NOW), Reject)
  assert.throws(() => parseIncome(op({ id: 'inc-1', date: day, category: '   ', amount: 10 }), NOW), Reject)
  assert.throws(() => parseIncome(op({ id: 'не номер', date: day, category: 'Аренда', amount: 10 }), NOW), Reject)
  assert.throws(() => parseIncome(op({ id: 'inc-1', date: 'вчера', category: 'Аренда', amount: 10 }), NOW), Reject)
  assert.throws(() => parseIncome({}, NOW), Reject)
})

test('доход «из будущего» (часы кассы убежали) записывается текущим моментом', () => {
  const p = parseIncome(op({ id: 'inc-2', date: '2027-01-01T00:00:00Z', category: 'Услуги', amount: 10 }), NOW)
  assert.equal(p.date.getTime(), NOW)
})

test('доход — известная операция обмена со своим правом', () => {
  assert.ok(OP_TYPES.includes('income'))
  assert.deepEqual(OP_PERMISSIONS.income, ['incomes.create'])
  assert.equal(FOUNDER_ONLY.has('income'), true)
})

test('дата дохода: сегодняшний день — сейчас, будущее — отказ', () => {
  const now = new Date('2026-10-16T09:00:00Z')
  assert.equal(incomeDate('', now).getTime(), now.getTime())
  assert.equal(incomeDate('2026-10-16', now).getTime(), now.getTime())
  assert.equal(incomeDate('2026-10-10', now).toISOString(), '2026-10-10T07:00:00.000Z')
  assert.throws(() => incomeDate('2026-10-20', now), /в будущем/)
  assert.throws(() => incomeDate('мусор', now), /неверная дата/)
})

test('запись дохода обновляет журнал доходов, но не смены', () => {
  assert.deepEqual(collectionsFor('POST', '/api/incomes'), ['incomes'])
  assert.deepEqual(collectionsFor('PATCH', '/api/incomes/abc'), ['incomes'])
  assert.deepEqual(collectionsFor('POST', '/api/income-categories'), ['incomeCategories'])
  assert.deepEqual(collectionsFor('GET', '/api/incomes'), [])
})

test('свой пароль: кассир по умолчанию не меняет, владелец и владелец сервиса — всегда', () => {
  assert.equal(mayChangeOwnPassword({ role: 'founder' }), true)
  assert.equal(mayChangeOwnPassword({ role: 'superadmin' }), true)
  // Кассир прежней версии без роли получает права кассира по умолчанию — в них этого нет
  assert.equal(CASHIER_DEFAULT.includes('profile.password'), false)
  assert.equal(mayChangeOwnPassword({ role: 'cashier', roleRef: null }), false)
  assert.equal(mayChangeOwnPassword({ role: 'cashier', roleRef: { permissions: ['pos.sell'] } }), false)
  // Владелец включил право роли — можно
  assert.equal(mayChangeOwnPassword({ role: 'cashier', roleRef: { permissions: ['pos.sell', 'profile.password'] } }), true)
  assert.match(NO_PASSWORD_CHANGE, /Сотрудники/)
})

test('заготовки ролей: заведующий и наблюдатель меняют свой пароль, закрыть чужую смену может только заведующий', () => {
  const manager = ROLE_PRESETS.find((r) => r.name === 'Заведующий')
  const viewer = ROLE_PRESETS.find((r) => r.name === 'Наблюдатель')
  assert.ok(manager.permissions.includes('profile.password'))
  assert.ok(viewer.permissions.includes('profile.password'))
  assert.ok(manager.permissions.includes('shift.closeAny'))
  assert.equal(viewer.permissions.includes('shift.closeAny'), false)
  assert.ok(viewer.permissions.includes('incomes.view'))
  assert.equal(viewer.permissions.includes('incomes.create'), false)
  for (const k of ['incomes.view', 'incomes.create', 'incomes.edit', 'settings.incomeCategories', 'profile.password', 'shift.closeAny']) {
    assert.ok(ALL_PERMISSIONS.includes(k), k)
  }
})

test('закрыть смену: свою — можно, чужую — только с правом, владелец — всегда', () => {
  const shift = { userId: 'u-owner' }
  const cashier = { role: 'cashier', permissions: CASHIER_DEFAULT, tenantUserId: 'u-cashier' }
  assert.equal(mayCloseShift(shift, cashier), false)
  assert.equal(mayCloseShift({ userId: 'u-cashier' }, cashier), true)
  assert.equal(mayCloseShift(shift, { ...cashier, permissions: [...CASHIER_DEFAULT, 'shift.closeAny'] }), true)
  assert.equal(mayCloseShift(shift, { role: 'founder', permissions: [], tenantUserId: 'u-x' }), true)
  // Кто открыл — неизвестно: закрыть может любой, кому можно закрывать смены
  assert.equal(mayCloseShift({ userId: null }, cashier), true)
  // Без своего номера в базе магазина чужую смену не закрыть
  assert.equal(mayCloseShift(shift, { role: 'cashier', permissions: CASHIER_DEFAULT, tenantUserId: null }), false)
  assert.match(NOT_YOUR_SHIFT, /владелец/)
})

test('ключ обмена по сети: один у всех касс магазина, у соседнего магазина — другой', () => {
  const a1 = lanKeyOf('ph-a')
  const a2 = lanKeyOf('ph-a')
  const b = lanKeyOf('ph-b')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  assert.ok(a1.length >= 40)
  assert.match(a1, /^[A-Za-z0-9_-]+$/)
})
