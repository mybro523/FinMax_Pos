// ── Запрос обязан попадать в схему своей аптеки ──
// Это самое опасное место всего сервиса. Ошибка здесь не роняет программу и не
// пишет ничего в журнал — она просто показывает одной аптеке товары, закупочные
// цены и долги другой. Заметить такое можно только глазами клиента, и один раз
// этого достаточно, чтобы сервису не доверяли.
//
// Настоящая база тут не нужна: Prisma подключается при первом запросе, а нам важно
// не выполнение запроса, а то, к какому подключению он адресован. Поэтому пул
// отдаёт подставные «клиенты», подписанные именем схемы.
//
// Запуск: npm test (в папке server).

// Задаём до загрузки модуля: предел числа подключений читается один раз при старте
process.env.TENANT_MAX_CLIENTS = '3'
process.env.TENANT_CONNECTION_LIMIT = '2'
// «В работе» и «простаивает» — в проверках короткие, чтобы двигать время вручную
process.env.TENANT_BUSY_MS = '1000'
process.env.TENANT_IDLE_MS = '5000'
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka?sslmode=require'

const test = require('node:test')
const assert = require('node:assert/strict')

const { TenantPool, DEFAULT_SCHEMA } = require('../dist/prisma/tenant-pool.service')
const { runInTenant, currentTenantSchema } = require('../dist/prisma/tenant-context')

// Пул с подставными клиентами: каждый помнит свою схему и то, что его закрыли.
// Часы тоже свои: без управления временем «давно ли им пользовались» не проверить.
class FakePool extends TenantPool {
  constructor() {
    super()
    this.closed = []
    this.opened = []
    this.clock = 1_000_000
  }
  now() {
    return this.clock
  }
  // Сдвинуть время: всё, к чему не обращались, становится старше
  passes(ms) {
    this.clock += ms
  }
  createClient(url) {
    const schema = new URL(url).searchParams.get('schema')
    const closed = this.closed
    const opened = this.opened
    return {
      schema,
      url,
      product: { findMany: async () => `товары из ${schema}` },
      $connect: async () => void opened.push(schema),
      $disconnect: async () => void closed.push(schema),
    }
  }
}

test('без контекста запрос идёт в схему по умолчанию', () => {
  const pool = new FakePool()
  assert.equal(pool.current().schema, DEFAULT_SCHEMA)
})

test('внутри контекста запрос идёт в схему своей аптеки', () => {
  const pool = new FakePool()
  runInTenant('tenant_shifo', () => {
    assert.equal(pool.current().schema, 'tenant_shifo')
  })
  runInTenant('tenant_salom', () => {
    assert.equal(pool.current().schema, 'tenant_salom')
  })
})

test('контекст переживает await и не протекает наружу', async () => {
  const pool = new FakePool()
  const shifo = runInTenant('tenant_shifo', async () => {
    await new Promise((r) => setTimeout(r, 5))
    return pool.current().schema
  })
  const salom = runInTenant('tenant_salom', async () => {
    await new Promise((r) => setTimeout(r, 1))
    return pool.current().schema
  })
  // Обе работы идут одновременно и перемешиваются во времени — каждая обязана
  // остаться в своей схеме. Именно здесь ломаются наивные решения через глобальную
  // переменную: та, что закончилась второй, увела бы за собой первую.
  assert.equal(await shifo, 'tenant_shifo', 'первая аптека ушла в чужую схему')
  assert.equal(await salom, 'tenant_salom', 'вторая аптека ушла в чужую схему')
  assert.equal(currentTenantSchema(), undefined, 'контекст протёк за пределы работы')
})

test('одной аптеке — одно подключение, а не новое на каждый запрос', () => {
  const pool = new FakePool()
  const a = pool.for('tenant_shifo')
  const b = pool.for('tenant_shifo')
  assert.equal(a, b, 'на каждый запрос открывалось новое подключение')
  assert.equal(pool.size, 1)
})

test('простаивающие подключения закрываются, начиная с самого давнего', () => {
  const pool = new FakePool()
  pool.for('tenant_1')
  pool.for('tenant_2')
  pool.for('tenant_3')
  assert.equal(pool.size, 3, 'предел ещё не превышен')

  // Все три перестали быть «в работе»
  pool.passes(2000)
  // Возвращаемся к первой: теперь она снова в работе, а самая давняя — вторая
  pool.for('tenant_1')
  pool.for('tenant_4')

  assert.equal(pool.size, 3, `открыто больше предела: ${pool.size}`)
  assert.deepEqual(pool.closed, ['tenant_2'], 'закрыли не самое давнее подключение')
})

// ── Та самая ошибка, что нашлась под нагрузкой ──
// Первая версия закрывала самое давнее подключение всегда, лишь бы уложиться
// в предел. Пятнадцать аптек при пределе в десять — и подключение закрывалось
// ровно тогда, когда по нему шёл запрос: тот падал по времени, аптека открывала
// подключение заново, и так по кругу. Тридцать семь отказов из двухсот запросов.
test('подключение в работе не закрывают, даже если предел превышен', () => {
  const pool = new FakePool()
  // Четыре аптеки при пределе в три, и все только что работали
  for (let n = 1; n <= 4; n++) pool.for('tenant_' + n)

  assert.deepEqual(pool.closed, [], 'закрыли подключение, по которому шла работа')
  assert.equal(pool.size, 4, 'предел должен быть мягким: превысить лучше, чем оборвать продажу')

  // Как только работа закончилась, лишнее закрывается при следующем обращении
  pool.passes(2000)
  pool.for('tenant_5')
  assert.ok(pool.size <= 3, `место так и не освободилось: открыто ${pool.size}`)
  assert.ok(pool.closed.length > 0, 'простаивающие подключения не закрылись')
  assert.ok(!pool.closed.includes('tenant_5'), 'закрыли ту самую аптеку, которой нужен был клиент')
})

test('подключение, ради которого освобождали место, не закрывают', () => {
  const pool = new FakePool()
  for (let n = 1; n <= 8; n++) {
    pool.for('tenant_' + n)
    pool.passes(2000) // каждая успевает освободиться до прихода следующей
  }
  assert.ok(pool.size <= 3, `открыто больше предела: ${pool.size}`)
  assert.ok(!pool.closed.includes('tenant_8'), 'закрыли ту самую аптеку, которой нужен был клиент')
  assert.equal(pool.for('tenant_8').schema, 'tenant_8')
})

test('давно простаивающее закрывается само, даже когда место есть', () => {
  const pool = new FakePool()
  pool.for('tenant_1')
  pool.passes(6000) // дольше, чем TENANT_IDLE_MS
  pool.sweepIdle()
  assert.equal(pool.size, 0, 'аптека закрылась на ночь, а подключение осталось до утра')
  assert.deepEqual(pool.closed, ['tenant_1'])
})

test('состояние пула видно снаружи — предел базы не должен заставать врасплох', () => {
  const pool = new FakePool()
  for (let n = 1; n <= 4; n++) pool.for('tenant_' + n)
  const st = pool.stats()
  assert.equal(st.open, 4)
  assert.equal(st.softLimit, 3)
  assert.equal(st.connections, 8, 'подключений к базе: 4 клиента × 2')
  assert.equal(st.busy, 4, 'все четыре только что работали')
  assert.equal(st.overLimit, 1)
})

test('в адресе подключения стоит нужная схема и свой запас подключений', () => {
  const pool = new FakePool()
  const u = new URL(pool.url('tenant_shifo'))
  assert.equal(u.searchParams.get('schema'), 'tenant_shifo')
  assert.equal(u.searchParams.get('connection_limit'), '2', 'запас подключений не задан')
  assert.equal(u.searchParams.get('sslmode'), 'require', 'потеряны параметры, заданные хостингом')
})

test('закрытие схемы освобождает подключение', async () => {
  const pool = new FakePool()
  pool.for('tenant_shifo')
  await pool.close('tenant_shifo')
  assert.equal(pool.size, 0)
  assert.deepEqual(pool.closed, ['tenant_shifo'])
})

test('остановка сервера закрывает все подключения', async () => {
  const pool = new FakePool()
  pool.for('tenant_1')
  pool.for('tenant_2')
  await pool.onModuleDestroy()
  assert.equal(pool.size, 0)
  assert.deepEqual(pool.closed.sort(), ['tenant_1', 'tenant_2'])
})

// ── Вторая половина: сама подмена ──
// Сервисы пишут this.prisma.product.findMany(…) и ничего не знают про схемы.
// Проверяем, что за этой привычной записью оказывается клиент нужной аптеки.
const { PrismaService } = require('../dist/prisma/prisma.service')

test('обращение к модели уходит в схему текущей аптеки', async () => {
  const pool = new FakePool()
  const prisma = new PrismaService(pool)

  const shifo = await runInTenant('tenant_shifo', () => prisma.product.findMany())
  const salom = await runInTenant('tenant_salom', () => prisma.product.findMany())

  assert.equal(shifo, 'товары из tenant_shifo')
  assert.equal(salom, 'товары из tenant_salom')
})

test('один и тот же сервис обслуживает разные аптеки, не путая их', async () => {
  const pool = new FakePool()
  const prisma = new PrismaService(pool)

  // Так это и происходит в жизни: два запроса от разных аптек идут одновременно
  const [a, b] = await Promise.all([
    runInTenant('tenant_shifo', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return prisma.product.findMany()
    }),
    runInTenant('tenant_salom', async () => prisma.product.findMany()),
  ])
  assert.equal(a, 'товары из tenant_shifo', 'первая аптека получила чужие товары')
  assert.equal(b, 'товары из tenant_salom', 'вторая аптека получила чужие товары')
})

test('вне запроса подмена ведёт в схему по умолчанию, а не падает', async () => {
  const pool = new FakePool()
  const prisma = new PrismaService(pool)
  assert.equal(await prisma.product.findMany(), `товары из ${DEFAULT_SCHEMA}`)
})

// ── Тёплые подключения работающих аптек ──
// Prisma подключается лениво, и первый запрос дня платил за это полторы секунды.
// Пока за кассой кто-то стоит, подключение к её данным держим наготове.

test('аптека вышла на связь — подключение открывается заранее', () => {
  const pool = new FakePool()
  pool.keepWarm('tenant_shifo')
  assert.deepEqual(pool.opened, ['tenant_shifo'], 'подключение не открыли заранее')
  assert.equal(pool.stats().warm, 1)
})

test('простой не закрывает подключение аптеки, за которой стоят', () => {
  // Между покупателями бывает и полчаса. Закрыть подключение в это время значит
  // заставить следующего покупателя ждать пробуждения базы.
  const pool = new FakePool()
  pool.for('tenant_shifo')
  pool.for('tenant_salom')
  pool.keepWarm('tenant_shifo')

  pool.passes(60_000) // обе давно простаивают
  pool.sweepIdle()

  assert.deepEqual(pool.closed, ['tenant_salom'], 'закрыли подключение работающей аптеки')
  assert.equal(pool.size, 1)
})

test('когда подключений больше предела, тепло не спасает', () => {
  // Иначе полсотни аптек с открытой программой съели бы все подключения базы.
  // Тепло — привилегия, пока есть место.
  const pool = new FakePool() // предел 3
  for (const s of ['a', 'b', 'c', 'd']) {
    pool.for('tenant_' + s)
    pool.keepWarm('tenant_' + s)
  }
  assert.ok(pool.size > 3, 'предел не превышен — проверка ничего не проверяет')

  pool.passes(60_000)
  pool.sweepIdle()
  assert.ok(pool.closed.length > 0, 'при нехватке места тёплые подключения так и не закрылись')
})

test('все ушли с кассы — подключение перестаёт быть тёплым', () => {
  const pool = new FakePool()
  pool.keepWarm('tenant_shifo')
  pool.letCool('tenant_shifo')
  assert.equal(pool.stats().warm, 0)

  pool.passes(60_000)
  pool.sweepIdle()
  assert.deepEqual(pool.closed, ['tenant_shifo'], 'подключение осталось висеть после ухода всех')
})

test('закрытие аптеки снимает с неё тепло', async () => {
  // Приостановили или удалили — держать её подключение наготове незачем
  const pool = new FakePool()
  pool.keepWarm('tenant_shifo')
  await pool.close('tenant_shifo')
  assert.equal(pool.stats().warm, 0)
})
