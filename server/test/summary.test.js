// ── Сводка для владельца сервиса ──
// Числа, по которым он судит о своём деле: сколько пришло денег, сколько клиентов
// и в каком они состоянии. Ошибка здесь ничего не роняет — просто владелец видит
// не ту картину и принимает не те решения. Заметить такое можно только пересчитав
// вручную, а вручную никто не пересчитывает.
//
// Особое внимание — границам месяцев. Платёж первого числа в полночь и платёж
// последнего числа в 23:59 попадают в разные месяцы, и промах на одну секунду
// переносит выручку из месяца в месяц.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')
const { SummaryService, SILENT_DAYS } = require('../dist/admin/summary.service')

const DAY = 86400000
// Середина месяца — чтобы «прошлый месяц» и «этот» не сливались
const NOW = new Date(2026, 7, 15, 12, 0, 0) // 15 августа 2026

// Поддельная база панели
function fakeAdmin(pharmacies, payments) {
  return {
    pharmacy: { findMany: async () => pharmacies },
    payment: {
      findMany: async ({ where }) => payments.filter((p) => p.createdAt >= where.createdAt.gte),
      aggregate: async () => ({
        _sum: { amount: payments.reduce((s, p) => s + Number(p.amount), 0) },
        _count: payments.length,
      }),
    },
  }
}

const ph = (over = {}) => ({
  id: 'p' + Math.random().toString(36).slice(2, 8),
  paidUntil: new Date(NOW.getTime() + 30 * DAY),
  trial: false,
  blocked: false,
  createdAt: new Date(2025, 0, 1),
  lastSaleAt: new Date(NOW.getTime() - DAY),
  ...over,
})
const pay = (amount, at) => ({ amount, createdAt: at })

test('клиенты разложены по состояниям', async () => {
  const s = new SummaryService(
    fakeAdmin(
      [
        ph(), // оплачена
        ph(), // оплачена
        ph({ trial: true }), // пробный период
        ph({ paidUntil: new Date(NOW.getTime() - 2 * DAY) }), // срок вышел
        ph({ paidUntil: new Date(NOW.getTime() - 40 * DAY) }), // срок вышел давно
        ph({ blocked: true }), // приостановлена
      ],
      [],
    ),
  )
  const r = await s.build(NOW)
  assert.equal(r.clients.total, 6)
  assert.equal(r.clients.paying, 2)
  assert.equal(r.clients.trial, 1)
  assert.equal(r.clients.expired, 2, 'отсрочки больше нет: срок вышел — значит вышел')
  assert.equal(r.clients.blocked, 1)
})

test('деньги за этот месяц и за прошлый не смешиваются', async () => {
  // Границы намеренно впритык: последняя секунда июля и первая секунда августа
  const s = new SummaryService(
    fakeAdmin(
      [ph()],
      [
        pay(100, new Date(2026, 6, 31, 23, 59, 59)), // июль
        pay(200, new Date(2026, 7, 1, 0, 0, 0)), // август, первая секунда
        pay(300, new Date(2026, 7, 15, 10, 0, 0)), // август
      ],
    ),
  )
  const r = await s.build(NOW)
  assert.equal(r.money.thisMonth, 500, 'выручка августа')
  assert.equal(r.money.prevMonth, 100, 'выручка июля')
  assert.equal(r.money.allTime, 600)
})

test('средний платёж считается по всем платежам, а не по последним', async () => {
  const s = new SummaryService(fakeAdmin([ph()], [pay(100, NOW), pay(200, NOW), pay(300, NOW)]))
  const r = await s.build(NOW)
  assert.equal(r.money.avgPayment, 200)
})

test('без единого платежа сводка не ломается и не делит на ноль', async () => {
  const s = new SummaryService(fakeAdmin([ph(), ph()], []))
  const r = await s.build(NOW)
  assert.equal(r.money.allTime, 0)
  assert.equal(r.money.avgPayment, 0)
  assert.equal(r.money.expected30, 0, 'ожидать нечего, пока не с чего считать средний платёж')
  assert.equal(r.byMonth.length, 12)
})

test('график всегда из двенадцати месяцев, даже пустых', async () => {
  // Иначе новый сервис рисовал бы график из одного столбика, и по нему
  // невозможно было бы понять, растёт дело или нет
  const s = new SummaryService(fakeAdmin([ph()], [pay(500, new Date(2026, 7, 3))]))
  const r = await s.build(NOW)
  assert.equal(r.byMonth.length, 12)
  assert.equal(r.byMonth[11].month, '2026-08', 'последний столбик — текущий месяц')
  assert.equal(r.byMonth[11].amount, 500)
  assert.equal(r.byMonth[0].month, '2025-09', 'первый столбик — год назад')
  assert.equal(r.byMonth[0].amount, 0)
})

test('ожидаемые поступления считают и просроченных — они тоже должны заплатить', async () => {
  const s = new SummaryService(
    fakeAdmin(
      [
        ph({ paidUntil: new Date(NOW.getTime() + 5 * DAY) }), // скоро платить
        ph({ paidUntil: new Date(NOW.getTime() - 3 * DAY) }), // уже должен
        ph({ paidUntil: new Date(NOW.getTime() + 200 * DAY) }), // заплатил надолго
        ph({ blocked: true, paidUntil: new Date(NOW.getTime() - DAY) }), // с ней расстались
      ],
      [pay(100, NOW)],
    ),
  )
  const r = await s.build(NOW)
  // Двое из четырёх × средний платёж 100
  assert.equal(r.money.expected30, 200)
})

test('«оплачена, но не торгует» — только про работающих клиентов', async () => {
  const long = new Date(NOW.getTime() - (SILENT_DAYS + 3) * DAY)
  const s = new SummaryService(
    fakeAdmin(
      [
        ph({ lastSaleAt: long }), // оплачена и молчит — тревога
        ph({ lastSaleAt: new Date(NOW.getTime() - DAY) }), // торгует
        ph({ lastSaleAt: null }), // ещё не считали — не выдумываем тревогу
        ph({ blocked: true, lastSaleAt: long }), // приостановлена, молчать ей положено
        ph({ paidUntil: new Date(NOW.getTime() - 40 * DAY), lastSaleAt: long }), // только просмотр
      ],
      [],
    ),
  )
  const r = await s.build(NOW)
  assert.equal(r.clients.silent, 1, 'тревога должна быть ровно по одному магазину')
})

test('новые за месяц считаются от первого числа', async () => {
  const s = new SummaryService(
    fakeAdmin(
      [
        ph({ createdAt: new Date(2026, 7, 1, 0, 0, 1) }), // первое августа
        ph({ createdAt: new Date(2026, 7, 14) }), // на днях
        ph({ createdAt: new Date(2026, 6, 31, 23, 59) }), // последний день июля
      ],
      [],
    ),
  )
  const r = await s.build(NOW)
  assert.equal(r.clients.newThisMonth, 2)
})
