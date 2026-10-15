// ── Деньги обязаны доехать до клиента числом ──
// Prisma хранит их объектами точной арифметики. Не превратив такой объект в число,
// сервер отдаёт клиенту структуру с внутренними полями — на экране появляется
// «[object Object]» вместо суммы, а расчёты на клиенте молча дают NaN.
//
// Клиентов Prisma в проекте два — магазина и панели управления, — и классы у них
// разные, хотя называются одинаково. Живой сервер показал это на сумме оплаты:
// проверка «этот объект из того класса» проходила только для своего клиента.
//
// Здесь проверяются оба, и намеренно через настоящие классы Prisma, а не через
// подделку: подделку легко сделать похожей на то, что мы ожидаем увидеть.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')

const { Prisma } = require('@prisma/client')
const { Prisma: AdminPrisma } = require('@prisma/admin-client')
const { DecimalInterceptor } = require('../dist/common/decimal.interceptor')

// Прогоняем значение через перехватчик ровно так, как это делает Nest:
// настоящим потоком rxjs, а не вызовом внутренней функции преобразования
const { of, lastValueFrom } = require('rxjs')
async function pass(value) {
  const res = new DecimalInterceptor().intercept({}, { handle: () => of(value) })
  return lastValueFrom(res)
}

test('деньги магазина-клиента приходят числом', async () => {
  const out = await pass({ total: new Prisma.Decimal('350.50') })
  assert.equal(typeof out.total, 'number')
  assert.equal(out.total, 350.5)
})

test('деньги панели управления тоже приходят числом', async () => {
  // Именно здесь всё и ломалось: класс другой, хотя выглядит так же
  const out = await pass({ amount: new AdminPrisma.Decimal('450.00') })
  assert.equal(typeof out.amount, 'number', 'сумма оплаты пришла не числом')
  assert.equal(out.amount, 450)
})

test('деньги находятся на любой глубине и в списках', async () => {
  const out = await pass({
    payments: [
      { amount: new AdminPrisma.Decimal('100.25'), pharmacy: { debt: new Prisma.Decimal('7.75') } },
      { amount: new AdminPrisma.Decimal('0') },
    ],
  })
  assert.equal(out.payments[0].amount, 100.25)
  assert.equal(out.payments[0].pharmacy.debt, 7.75)
  assert.equal(out.payments[1].amount, 0)
})

test('копейки не теряются', async () => {
  const out = await pass({ a: new Prisma.Decimal('0.01'), b: new Prisma.Decimal('12345678.99') })
  assert.equal(out.a, 0.01)
  assert.equal(out.b, 12345678.99)
})

test('даты остаются датами, а не рассыпаются по полям', async () => {
  const d = new Date('2026-09-20T00:00:00.000Z')
  const out = await pass({ paidUntil: d })
  assert.ok(out.paidUntil instanceof Date, 'дата превратилась во что-то другое')
  assert.equal(out.paidUntil.getTime(), d.getTime())
})

test('обычные значения не портятся', async () => {
  const out = await pass({ name: 'Шифо', qty: 3, ok: true, nothing: null, list: [1, 'два'] })
  assert.deepEqual(out, { name: 'Шифо', qty: 3, ok: true, nothing: null, list: [1, 'два'] })
})

// Страховка на будущее: если однажды классы Prisma снова разойдутся (новая версия,
// третий клиент), проверка по набору методов обязана поймать это сама
test('запасная проверка по набору методов действительно работает', async () => {
  const looksLikeMoney = {
    toNumber: () => 42,
    toFixed: () => '42.00',
    dividedBy: () => looksLikeMoney,
    times: () => looksLikeMoney,
  }
  const out = await pass({ amount: looksLikeMoney })
  assert.equal(out.amount, 42, 'запасная проверка не сработала — а именно она спасает при смене версии')
})
