// ── Дата расхода ──
//
// Владелец вносит расход и задним числом: аренду за месяц записывают не обязательно
// в день оплаты. Поле даты отдаёт день без времени — и от того, как сервер его
// поймёт, зависит, в какой день расход попадёт в отчёте. Здесь стережётся это
// правило: день остаётся своим днём, «сегодня» — это сейчас, будущим числом расход
// не вносят.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { expenseDate } = require('../dist/expenses/expenses.service')

// 7 октября 2026, 09:30 по Душанбе (UTC+5)
const NOW = new Date('2026-10-07T04:30:00.000Z')

test('дата не указана — расход вносится «сейчас»', () => {
  assert.equal(expenseDate(undefined, NOW), NOW)
  assert.equal(expenseDate(null, NOW), NOW)
  assert.equal(expenseDate('', NOW), NOW)
})

test('прошедший день ставится на полдень по Душанбе — и остаётся своим днём в любом поясе', () => {
  assert.equal(expenseDate('2026-10-01', NOW).toISOString(), '2026-10-01T07:00:00.000Z')
  assert.equal(expenseDate('2026-10-06', NOW).toISOString(), '2026-10-06T07:00:00.000Z')
})

test('сегодняшний день — это «сейчас», а не полдень, который ещё не наступил', () => {
  assert.equal(expenseDate('2026-10-07', NOW), NOW)
  // Сразу после полуночи по Душанбе по Гринвичу ещё вчера — день всё равно сегодняшний
  const night = new Date('2026-10-06T19:10:00.000Z')
  assert.equal(expenseDate('2026-10-07', night), night)
  assert.equal(expenseDate('2026-10-06', night).toISOString(), '2026-10-06T07:00:00.000Z')
})

test('будущим числом расход не вносится', () => {
  assert.throws(() => expenseDate('2026-10-08', NOW), /в будущем/)
  assert.throws(() => expenseDate('2027-01-01', NOW), /в будущем/)
  assert.throws(() => expenseDate('2026-10-07T04:40:00.000Z', NOW), /в будущем/)
})

test('точное время принимается; расхождение часов в пару минут — не «будущее»', () => {
  assert.equal(expenseDate('2026-10-07T04:00:00.000Z', NOW).toISOString(), '2026-10-07T04:00:00.000Z')
  assert.equal(expenseDate('2026-10-07T04:33:00.000Z', NOW).toISOString(), '2026-10-07T04:33:00.000Z')
})

test('мусор и дата, которую базе не записать, отвергаются словами, а не ошибкой сервера', () => {
  for (const bad of ['вчера', '2026-13-45', '07.10.2026x', '99999-01-01', '0000-00-00']) {
    assert.throws(() => expenseDate(bad, NOW), /неверная дата/, bad)
  }
})
