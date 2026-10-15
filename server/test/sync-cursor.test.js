// ── С какого места отдавать кассе изменения ──
//
// Касса называет отметку прошлого обмена. Сервер либо досылает изменения с неё,
// либо отдаёт весь магазин заново. Ошибиться здесь можно в обе стороны, и обе плохи:
// отдавать всё при каждом обмене — касса раз в пять минут качает весь магазин;
// досылать «изменения» кассе, у которой данные уже не от этой базы, — она молча
// останется с товарами и чеками, которых на сервере больше нет.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { mark, sinceOf } = require('../dist/sync/cursor')

// Обычное положение дел: касса называет ровно ту отметку, что получила в прошлый раз
const facts = (over = {}) => ({ asked: 500n, askedW: null, pruned: 0n, horizon: 900n, given: 500n, ...over })

test('отметка из запроса: только число в виде строки', () => {
  assert.equal(mark('12345'), 12345n)
  assert.equal(mark('9007199254740993'), 9007199254740993n, 'число больше, чем умеет JavaScript, не должно потерять точность')
  assert.equal(mark(''), null)
  assert.equal(mark(undefined), null)
  assert.equal(mark(null), null)
  assert.equal(mark('abc'), null)
  assert.equal(mark('-5'), null)
  assert.equal(mark('1.5'), null)
  assert.equal(mark('12345678901234567890'), null, 'длиннее, чем бывает номер транзакции')
})

test('обычный обмен: изменения досылаются с отметки кассы', () => {
  assert.equal(sinceOf(facts()), 500n)
  // Ничего не менялось с прошлого раза — тоже не повод отдавать всё
  assert.equal(sinceOf(facts({ asked: 900n, given: 900n })), 900n)
})

test('первый обмен и мусор вместо отметки — всё заново', () => {
  assert.equal(sinceOf(facts({ asked: null, given: null })), null)
  assert.equal(sinceOf(facts({ asked: mark('abc') })), null)
})

test('журнал за это время подчищен — досылать нечем, всё заново', () => {
  assert.equal(sinceOf(facts({ asked: 500n, pruned: 501n })), null)
  assert.equal(sinceOf(facts({ asked: 500n, pruned: 500n })), 500n, 'ровно на границе журнал ещё цел')
})

test('отметка «из будущего» — такой транзакции в этой базе ещё не было', () => {
  assert.equal(sinceOf(facts({ asked: 901n, given: 901n })), null)
})

test('ответ сервера до кассы не дошёл: она спрашивает с прежней отметки и получает изменения, а не весь магазин', () => {
  assert.equal(sinceOf(facts({ asked: 500n, given: 700n })), 500n)
})

test('базу сервера подняли из копии: касса впереди сервера — всё заново', () => {
  // Сервер помнит отметку на момент копии, а касса успела обменяться позже
  assert.equal(sinceOf(facts({ asked: 700n, given: 500n })), null)
})

test('базу перенесли на новый сервер: он этой кассе отметок не выдавал — всё заново', () => {
  assert.equal(sinceOf(facts({ asked: 500n, given: null })), null)
})

test('журнал списаний владельца: его отметка старше подчищенного — всё заново; иначе — нет', () => {
  assert.equal(sinceOf(facts({ askedW: 100n, pruned: 200n })), null)
  assert.equal(sinceOf(facts({ askedW: 300n, pruned: 200n })), 500n)
  // У кассира отметки списаний нет вовсе
  assert.equal(sinceOf(facts({ askedW: null, pruned: 200n })), 500n)
})
