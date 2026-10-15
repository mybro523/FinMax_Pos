// ── Память сторожа ──
// Сторож на входе спрашивал базу о сотруднике при каждом запросе — сто тридцать пять
// миллисекунд, которые платили все разделы без исключения. Теперь ответ живёт
// несколько секунд в памяти.
//
// Ошибка здесь опаснее медленной работы: заблокированный сотрудник продолжал бы
// работать, приостановленный магазин — продавать. Поэтому проверяется не столько
// то, что память работает, сколько то, что она вовремя забывает.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'
process.env.ACCOUNT_CACHE_MS = '10000'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountCache } = require('../dist/admin/account-cache.service')

// Поддельная база: считает, сколько раз её спросили
function fakeAdmin(rows) {
  let asked = 0
  return {
    asked: () => asked,
    account: {
      findUnique: async ({ where }) => {
        asked++
        return rows.get(where.id) || null
      },
    },
  }
}

function account(id, pharmacyId = 'ph1', over = {}) {
  return { id, pharmacyId, login: id, role: 'cashier', active: true, passwordChangedAt: null, ...over }
}

test('второй раз подряд в базу уже не ходим', async () => {
  const rows = new Map([['a1', account('a1')]])
  const db = fakeAdmin(rows)
  const c = new AccountCache(db)

  await c.get('a1')
  await c.get('a1')
  await c.get('a1')
  assert.equal(db.asked(), 1, 'ходили в базу лишний раз — вся правка бессмысленна')
})

test('заблокированный сотрудник перестаёт работать сразу, а не через несколько секунд', async () => {
  const rows = new Map([['a1', account('a1')]])
  const db = fakeAdmin(rows)
  const c = new AccountCache(db)

  assert.equal((await c.get('a1')).active, true)

  // Владелец заблокировал кассира — и тут же сбросил память сторожа
  rows.set('a1', account('a1', 'ph1', { active: false }))
  c.drop('a1')
  assert.equal((await c.get('a1')).active, false, 'заблокированный сотрудник всё ещё работает')
})

test('приостановка магазина задевает всех его сотрудников разом', async () => {
  const rows = new Map([
    ['a1', account('a1', 'ph1')],
    ['a2', account('a2', 'ph1')],
    ['chuzhoy', account('chuzhoy', 'ph2')],
  ])
  const db = fakeAdmin(rows)
  const c = new AccountCache(db)

  await c.get('a1')
  await c.get('a2')
  await c.get('chuzhoy')
  assert.equal(db.asked(), 3)

  c.dropPharmacy('ph1')
  await c.get('a1')
  await c.get('a2')
  assert.equal(db.asked(), 5, 'сотрудники приостановленного магазина остались в памяти')

  // А чужой магазин это трогать не должно: приостановка одного клиента не повод
  // замедлять всех остальных
  await c.get('chuzhoy')
  assert.equal(db.asked(), 5, 'сброс задел чужой магазин')
})

test('срок жизни истекает и ответ перепрашивается', async () => {
  const rows = new Map([['a1', account('a1')]])
  const db = fakeAdmin(rows)
  // Отдельный срок для этой проверки: ждать десять секунд ради неё незачем
  process.env.ACCOUNT_CACHE_MS = '10000'
  const c = new AccountCache(db)
  await c.get('a1')

  // Подкручиваем время вместо ожидания
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 60_000
    await c.get('a1')
  } finally {
    Date.now = realNow
  }
  assert.equal(db.asked(), 2, 'ответ не протух — забытое место сброса осталось бы навсегда')
})

test('несуществующего не запоминаем', async () => {
  // Иначе подобранный чужой токен занимал бы память, а удалённый сотрудник
  // числился бы отсутствующим и после того, как его заведут заново
  const rows = new Map()
  const db = fakeAdmin(rows)
  const c = new AccountCache(db)

  assert.equal(await c.get('net-takogo'), null)
  rows.set('net-takogo', account('net-takogo'))
  assert.ok(await c.get('net-takogo'), 'заведённого заново сотрудника не видно')
  assert.equal(db.asked(), 2)
})

test('счётчик показывает, сколько запросов обошлось без базы', async () => {
  const c = new AccountCache(fakeAdmin(new Map([['a1', account('a1')]])))
  await c.get('a1')
  await c.get('a1')
  await c.get('a1')
  const s = c.stats()
  assert.equal(s.hits, 2)
  assert.equal(s.misses, 1)
  assert.equal(s.kept, 1)
})
