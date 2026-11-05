// Кассы магазина без интернета (1.7.0): код подключения, его срок и значок внизу
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPair, mainProblemText, normalizePair, pairLeft, soloNetBadge } from '../src/lib/kassy.js'

const t = (s) => s

test('код подключения: заглавными, без лишнего, похожие буквы — как у главного', () => {
  assert.equal(normalizePair('ab12-cd34'), 'AB12CD34')
  assert.equal(normalizePair(' o1il-zz99 extra'), '0111ZZ99')
  // Русские буквы-двойники (раскладка не та)
  assert.equal(normalizePair('АВСЕ-КМНР'), 'ABCEKMHP')
  assert.equal(formatPair('ab12cd34'), 'AB12-CD34')
  assert.equal(formatPair('ab1'), 'AB1')
  assert.equal(normalizePair(null), '')
})

test('сколько коду осталось — по часам окна, не больше 10 минут', () => {
  const now = Date.parse('2026-11-05T10:00:00Z')
  assert.equal(pairLeft(now + 581000, now), '9:41')
  assert.equal(pairLeft(now + 5000, now), '0:05')
  assert.equal(pairLeft(now - 1000, now), '')
  assert.equal(pairLeft(0, now), '')
  // Часы программы впереди окна — больше 10 минут не показываем
  assert.equal(pairLeft(now + 601000, now), '10:00')
})

test('значок внизу: касса — связь с главным, главный — кассы на связи', () => {
  assert.equal(soloNetBadge(null, t), null)
  assert.deepEqual(soloNetBadge({ role: 'register', main: { online: true }, pending: 0 }, t), { tone: 'ok', label: 'Главный компьютер: на связи' })
  assert.deepEqual(soloNetBadge({ role: 'register', main: { online: false }, pending: 3 }, t), { tone: 'muted', label: 'Главный компьютер: нет связи · ждут: 3' })
  assert.equal(soloNetBadge({ role: 'register', main: { online: false, error: 'star' }, pending: 0 }, t).tone, 'warn')
  assert.equal(soloNetBadge({ role: 'main', registers: [] }, t), null)
  assert.deepEqual(soloNetBadge({ role: 'main', registers: [{ online: true }, { online: false }] }, t), { tone: 'ok', label: 'Кассы на связи: 1 из 2' })
  assert.match(mainProblemText('epoch', t), /копию базы/)
  assert.match(mainProblemText('gone', t), /подключите кассу заново/i)
  assert.equal(soloNetBadge({ role: 'register', main: { online: false, error: 'gone' }, pending: 0 }, t).tone, 'warn')
  assert.equal(mainProblemText('error', t), '')
})
