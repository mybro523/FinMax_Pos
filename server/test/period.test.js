// Тесты периода выборки журналов. Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { periodWhere, periodFilter, MAX_ROWS } = require('../dist/common/period')

const DAY = 86400000
const daysAgo = (w) => Math.round((Date.now() - w.gte.getTime()) / DAY)

test('без параметров берётся период по умолчанию', () => {
  assert.equal(daysAgo(periodWhere({}, 90)), 90)
  assert.equal(daysAgo(periodWhere({}, 60)), 60)
  assert.equal(daysAgo(periodWhere(undefined, 30)), 30)
})

test('число дней задаётся запросом', () => {
  assert.equal(daysAgo(periodWhere({ days: '7' }, 90)), 7)
  assert.equal(daysAgo(periodWhere({ days: '365' }, 90)), 365)
})

test('ноль дней означает «всё время»', () => {
  // Так выгружают историю целиком — например, для разбора старых операций
  assert.equal(periodWhere({ days: '0' }, 90), undefined)
  assert.deepEqual(periodFilter({ days: '0' }, 90), {})
})

test('мусор в параметре не ломает выборку', () => {
  assert.equal(periodWhere({ days: 'ерунда' }, 90), undefined, 'непонятное значение — отдаём всё, а не падаем')
  assert.equal(daysAgo(periodWhere({ days: '' }, 45)), 45, 'пустая строка — период по умолчанию')
  assert.equal(periodWhere({ days: '-5' }, 90), undefined)
})

test('слишком большой период упирается в потолок', () => {
  const w = periodWhere({ days: '999999' }, 90)
  assert.equal(daysAgo(w), 3650, 'десять лет — дальше уже «всё время»')
})

test('отрезок дат разбирается', () => {
  const w = periodWhere({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' })
  assert.equal(w.gte.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(w.lte.toISOString(), '2026-02-01T00:00:00.000Z')
})

test('половина отрезка тоже годится', () => {
  const onlyFrom = periodWhere({ from: '2026-01-01T00:00:00.000Z' })
  assert.ok(onlyFrom.gte)
  assert.equal(onlyFrom.lte, undefined)

  const onlyTo = periodWhere({ to: '2026-02-01T00:00:00.000Z' })
  assert.equal(onlyTo.gte, undefined)
  assert.ok(onlyTo.lte)
})

test('битые даты не превращаются в Invalid Date внутри запроса', () => {
  // Раньше сюда уходил new Date('ерунда'), и Prisma отвечала невнятной ошибкой
  assert.equal(periodWhere({ from: 'ерунда' }), undefined)
  assert.equal(periodWhere({ from: 'ерунда', to: 'тоже' }), undefined)
})

test('отрезок важнее числа дней', () => {
  const w = periodWhere({ days: '7', from: '2026-01-01T00:00:00.000Z' })
  assert.equal(w.gte.toISOString(), '2026-01-01T00:00:00.000Z')
})

test('поле даты можно задать — у погашений долга оно называется иначе', () => {
  const f = periodFilter({ days: '30' }, 90, 'createdAt')
  assert.ok(f.createdAt, 'условие построено по нужному полю')
  assert.equal(f.date, undefined)
})

test('предохранитель по числу строк на месте', () => {
  assert.ok(MAX_ROWS >= 10000, 'слишком маленький потолок обрежет историю')
})
