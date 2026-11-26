// ── Сброс пароля владельца из панели (1.8.14) ──
//
// Владелец сервиса задаёт новый пароль основному (первому активному) владельцу магазина.
// Здесь — без живой базы: подставляем поддельный admin/events/accounts и проверяем, что
// выбирается нужная учётка, пароль хэшируется (и проверяется новым паролём), ставится
// отметка смены пароля, рвутся сессии и сбрасывается кэш, а короткий пароль не проходит.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')

const { PharmaciesService } = require('../dist/admin/pharmacies.service')
const { verifyPassword } = require('../dist/auth/password')

function build({ accounts } = {}) {
  const list = accounts || [{ id: 'own1', login: 'rukhshona', role: 'founder', active: true, createdAt: new Date('2026-01-01') }]
  const calls = { update: null, dropped: null, cacheDropped: null, audit: null }
  const admin = {
    pharmacy: { findUnique: async () => ({ id: 'ph1', code: 'rukhshona' }) },
    account: {
      findFirst: async ({ where }) => {
        const f = list.filter((a) => a.role === where.role && (where.active ? a.active : true))
        f.sort((a, b) => a.createdAt - b.createdAt)
        return f[0] || null
      },
      findUnique: async () => ({ login: 'service-owner' }),
      update: async ({ where, data }) => { calls.update = { where, data }; return { id: where.id, ...data } },
    },
    auditLog: { create: async ({ data }) => { calls.audit = data } },
  }
  const events = { dropUser: (id, reason) => { calls.dropped = { id, reason } } }
  const accountsCache = { drop: (id) => { calls.cacheDropped = id } }
  // Прочие зависимости методу не нужны
  const svc = new PharmaciesService(admin, {}, {}, {}, {}, {}, {}, {}, events, accountsCache, {})
  return { svc, calls }
}

test('сброс идёт основному (первому активному) владельцу, пароль хэшируется', async () => {
  const { svc, calls } = build({ accounts: [
    { id: 'own2', login: 'second', role: 'founder', active: true, createdAt: new Date('2026-05-01') },
    { id: 'own1', login: 'rukhshona', role: 'founder', active: true, createdAt: new Date('2026-01-01') },
    { id: 'kas1', login: 'kassir', role: 'cashier', active: true, createdAt: new Date('2026-01-02') },
  ] })
  const res = await svc.resetOwnerPassword('ph1', 'novyparol1', 'service-acc')
  assert.equal(res.ownerLogin, 'rukhshona', 'основной — самый ранний активный founder')
  assert.equal(calls.update.where.id, 'own1')
  assert.notEqual(calls.update.data.passwordHash, 'novyparol1', 'в базу идёт хэш, не сам пароль')
  assert.ok(await verifyPassword('novyparol1', calls.update.data.passwordHash), 'хэш проверяется новым паролём')
  assert.ok(calls.update.data.passwordChangedAt instanceof Date, 'стоит отметка смены пароля (старые токены гаснут)')
  assert.equal(calls.dropped.id, 'own1', 'открытые сессии владельца оборваны')
  assert.equal(calls.cacheDropped, 'own1', 'кэш учётки сброшен — новый пароль действует сразу')
  assert.equal(calls.audit.action, 'reset-password', 'сброс записан в журнал')
})

test('короткий пароль — отказ, база не тронута', async () => {
  const { svc, calls } = build()
  await assert.rejects(() => svc.resetOwnerPassword('ph1', '123', 'a'), (e) => /короткий|6/.test(e.message))
  assert.equal(calls.update, null)
  assert.equal(calls.dropped, null)
})

test('у магазина нет действующего владельца — отказ', async () => {
  const { svc } = build({ accounts: [{ id: 'k', login: 'kassir', role: 'cashier', active: true, createdAt: new Date() }] })
  await assert.rejects(() => svc.resetOwnerPassword('ph1', 'novyparol1', 'a'), (e) => /владел/i.test(e.message))
})
