// ── Начать с чистого листа (1.8.11) ──
//
// Владелец магазина стирает рабочие данные и справочники, оставляя сотрудников (User)
// и кассы (Device). Здесь — без живой базы: подставляем поддельный Prisma и проверяем,
// что сервис требует подтверждающее слово, строит правильный TRUNCATE (без User/Device
// и без служебной таблицы миграций), заново заводит стартовые категории и оповещает
// устройства обо всех разделах.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')

const { ResetService, RESET_CONFIRM } = require('../dist/reset/reset.service')
const { runInTenant } = require('../dist/prisma/tenant-context')

// Поддельная схема магазина: что вернёт каталог базы на запрос списка таблиц
const TABLES = [
  'User', 'Device', '_prisma_migrations',
  'Product', 'Sale', 'SaleItem', 'Category', 'Supplier', 'Customer', 'Shift', 'ChangeLog', 'SkladBatch',
]

function build({ tables = TABLES } = {}) {
  const calls = { exec: [], seeded: 0, shift: 0, changed: null }
  const prisma = {
    async $queryRawUnsafe(sql, schema) {
      calls.query = { sql, schema }
      return tables.map((tablename) => ({ tablename }))
    },
    async $executeRawUnsafe(sql) {
      calls.exec.push(sql)
      return 0
    },
  }
  const categories = { async ensureSeeded() { calls.seeded++ } }
  const seed = { async ensureOneOpenShift() { calls.shift++ } }
  const events = { changed(...keys) { calls.changed = keys } }
  const svc = new ResetService(prisma, categories, seed, events)
  return { svc, calls }
}

const run = (svc, confirm) => runInTenant('tenant_demo', () => svc.wipeKeepStaff(confirm))

test('без подтверждающего слова — отказ, база не тронута', async () => {
  for (const bad of ['', '  ', 'очист', 'удалить', 'DELETE']) {
    const { svc, calls } = build()
    await assert.rejects(() => run(svc, bad), (e) => /ОЧИСТИТЬ/.test(e.message))
    assert.equal(calls.exec.length, 0, `«${bad}» не должно ничего стирать`)
  }
})

test('слово подтверждения распознаётся без учёта регистра и пробелов', async () => {
  for (const ok of [RESET_CONFIRM, 'очистить', '  Очистить  ']) {
    const { svc, calls } = build()
    await run(svc, ok)
    assert.equal(calls.exec.length, 1, `«${ok}» должно запустить очистку`)
  }
})

test('TRUNCATE: сотрудники, кассы и таблица миграций остаются, остальное стирается', async () => {
  const { svc, calls } = build()
  const res = await run(svc, RESET_CONFIRM)

  // Список таблиц спрашивали у каталога именно этой схемы
  assert.equal(calls.query.schema, 'tenant_demo')

  const sql = calls.exec[0]
  assert.match(sql, /^TRUNCATE TABLE /)
  assert.match(sql, /RESTART IDENTITY CASCADE$/)
  // Оставляем сотрудников, кассы и историю миграций
  for (const keep of ['User', 'Device', '_prisma_migrations']) {
    assert.ok(!sql.includes(`"${keep}"`), `${keep} не должен попасть в TRUNCATE`)
  }
  // Данные и справочники — стираем, имена со схемой
  for (const gone of ['Product', 'Sale', 'SaleItem', 'Category', 'Supplier', 'Customer', 'Shift', 'ChangeLog', 'SkladBatch']) {
    assert.ok(sql.includes(`"tenant_demo"."${gone}"`), `${gone} должен попасть в TRUNCATE`)
  }
  // Очищено столько, сколько таблиц без исключённых трёх
  assert.equal(res.cleared, 9)
})

test('после очистки магазин как новый: стартовые категории и защита смены, оповещение всех разделов', async () => {
  const { svc, calls } = build()
  await run(svc, RESET_CONFIRM)
  assert.equal(calls.seeded, 1, 'стартовые категории заводятся заново')
  assert.equal(calls.shift, 1, 'защита «одна открытая смена» перепроверяется')
  // Устройства перезапрашивают все основные разделы
  for (const sec of ['products', 'sales', 'shifts', 'suppliers', 'customers', 'categories', 'skladBatches']) {
    assert.ok(calls.changed.includes(sec), `должны оповестить про «${sec}»`)
  }
})

test('без контекста магазина — отказ', async () => {
  const { svc } = build()
  await assert.rejects(() => svc.wipeKeepStaff(RESET_CONFIRM), (e) => /магазин/i.test(e.message))
})
