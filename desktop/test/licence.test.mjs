// ── Последняя связь с сервером (бывший «срок работы без связи») ──
//
// С 1.6.5 срока работы без связи нет (решение владельца сервиса 05.11.2026): касса без
// интернета работает сколько угодно. Здесь проверяется, что срок больше ничего не закрывает,
// что отметка о последней проверке по-прежнему записывается (её видно кассиру) и что её нельзя
// ни подправить, ни подложить, — на ней держится память часов.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/local/db.mjs'
import { createClock } from '../src/local/clock.mjs'
import { confirmLicence, lastFloor, lastSeen, licenceOf, licenceTerms, offlineDaysOf, OFFLINE_DAYS_DEFAULT, sealStatus, touchLicence } from '../src/local/licence.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { fakeSeal } from '../test-support/server.mjs'
import { DAY, NOW } from '../test-support/pharmacy.mjs'

const HOUR = 3600000
const core = () => openDb(':memory:', CORE_SCHEMA)
// Компьютер, на котором шифрования Windows нет вовсе
const noSeal = { seal: () => null, open: () => null }
const stored = (db, code = 'apteka-1') => db.prepare('SELECT sealed FROM licences WHERE pharmacyCode = ?').get(code)?.sealed
const put = (db, sealed, code = 'apteka-1') =>
  db.prepare('INSERT INTO licences (pharmacyCode, sealed) VALUES (?, ?) ON CONFLICT(pharmacyCode) DO UPDATE SET sealed = excluded.sealed').run(code, sealed)

test('1.6.5: срока нет — и через год без связи программа работает', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  const at = (ms) => licenceOf(db, 'apteka-1', NOW + ms, fakeSeal)
  for (const ms of [0, 6 * DAY, 7 * DAY, 30 * DAY, 365 * DAY]) {
    assert.deepEqual([at(ms).expired, at(ms).warn, at(ms).unlimited], [false, false, true], 'день ' + ms / DAY)
  }
  assert.equal(at(365 * DAY).checkedAt, new Date(NOW).toISOString(), 'видно, когда касса последний раз была на связи')
})

test('каждая проверка — новая отметка «последняя связь с сервером»', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  confirmLicence(db, 'apteka-1', { now: NOW + 6 * DAY, days: 7 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, fakeSeal).checkedAt, new Date(NOW + 6 * DAY).toISOString())
})

test('прежнее число дней от сервера: границы те же, но на работу оно больше не влияет', () => {
  assert.equal(offlineDaysOf(14), 14)
  assert.equal(offlineDaysOf(0), OFFLINE_DAYS_DEFAULT)
  assert.equal(offlineDaysOf('мусор'), OFFLINE_DAYS_DEFAULT)
  assert.equal(offlineDaysOf(365), 30)
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 2 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 10 * DAY, fakeSeal).expired, false, 'два дня от сервера не закрывают кассу')
})

test('проверки не было — работать всё равно можно, отметки «последняя связь» нет', () => {
  const db = core()
  const l = licenceOf(db, 'apteka-1', NOW, fakeSeal)
  assert.deepEqual([l.expired, l.warn, l.checkedAt], [false, false, null])
})

test('отметка зашифрована: в файле базы её не прочитать, а подложенная или испорченная не принимается', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  const raw = stored(db)
  assert.ok(!raw.includes('checkedAt') && !raw.includes(String(NOW)), 'отметка лежит открытым текстом')

  // Подложили открытую запись «проверено позже» — там, где шифрование работает, она не принимается
  put(db, 'plain:' + JSON.stringify({ code: 'apteka-1', checkedAt: NOW + 20 * DAY, offlineDays: 30 }))
  assert.equal(licenceOf(db, 'apteka-1', NOW + 21 * DAY, fakeSeal).checkedAt, null)
  assert.equal(lastSeen(db, fakeSeal), 0, 'и память часов по ней не сдвигается')

  // Испортили зашифрованную
  put(db, raw.slice(0, -4) + 'AAAA')
  assert.equal(licenceOf(db, 'apteka-1', NOW, fakeSeal).checkedAt, null)
  put(db, 'мусор')
  assert.equal(licenceOf(db, 'apteka-1', NOW, fakeSeal).checkedAt, null)
})

test('запись соседнего магазина, переложенная в чужую строку, не годится', () => {
  const db = core()
  confirmLicence(db, 'oplachena', { now: NOW + 20 * DAY, days: 30 }, fakeSeal)
  confirmLicence(db, 'dolzhnik', { now: NOW, days: 7 }, fakeSeal)
  put(db, stored(db, 'oplachena'), 'dolzhnik')
  assert.equal(licenceOf(db, 'dolzhnik', NOW + 21 * DAY, fakeSeal).checkedAt, null)
  assert.equal(licenceOf(db, 'oplachena', NOW + 21 * DAY, fakeSeal).checkedAt, new Date(NOW + 20 * DAY).toISOString())
})

test('часы перевели назад — касса не закрывается: срока, который можно обмануть, больше нет', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW - DAY, fakeSeal).expired, false)
})

test('на компьютере без шифрования Windows отметка хранится открыто — иначе программа не работала бы вовсе', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, noSeal)
  assert.ok(stored(db).startsWith('plain:'))
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, noSeal).checkedAt, new Date(NOW).toISOString())
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, noSeal).expired, false)
})

// ── До какого момента программа дожила ──

test('память часов стёрли и перевели дату на день проверки — неделя заново не начинается', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  // Программа проработала пять дней; раз в минуту она записывает, до какого момента дожила
  touchLicence(db, 'apteka-1', NOW + 5 * DAY, fakeSeal)
  assert.equal(lastSeen(db, fakeSeal), NOW + 5 * DAY)
  assert.equal(stored(db).includes(String(NOW + 5 * DAY)), false, 'отметка лежит в зашифрованной записи: поправить её в файле нельзя')

  // Строку часов из базы стёрли, дату компьютера вернули на день проверки. Часы программы
  // после запуска продолжают с этой отметки, что бы ни показывал компьютер, — по ним идут
  // время чеков и дата окончания оплаты. Сколько программа была выключена, узнать не у кого
  // (часы показывают прошлое), поэтому время оплаты уходит ещё на полсуток вперёд
  const clock = createClock({ wall: () => NOW + HOUR, mono: () => 0, load: () => ({ seen: lastFloor(db, fakeSeal), licSeen: lastSeen(db, fakeSeal) }) })
  assert.equal(clock.now(), NOW + 5 * DAY)
  assert.equal(clock.lic(), NOW + 5 * DAY + 12 * HOUR)
  assert.equal(licenceOf(db, 'apteka-1', clock.lic() + 2 * DAY, fakeSeal).expired, false, 'срок без связи кассу не закрывает')
})

test('в зашифрованной записи два момента — срока и часов; каждый только растёт', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW, NOW])
  // Компьютер со сбитыми часами: за ночь срок ушёл вперёд на полсуток, а часам эту
  // ночь приписать нельзя — иначе выдуманное время попало бы в чеки
  touchLicence(db, 'apteka-1', NOW + 22 * HOUR, fakeSeal, NOW + 10 * HOUR)
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + 22 * HOUR, NOW + 10 * HOUR])
  touchLicence(db, 'apteka-1', NOW + 20 * HOUR, fakeSeal, NOW + 11 * HOUR)
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + 22 * HOUR, NOW + 11 * HOUR])
  // Вызов по-старому, с одним моментом, двигает обе
  touchLicence(db, 'apteka-1', NOW + DAY, fakeSeal)
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + DAY, NOW + DAY])
  // Новая проверка: обе отметки — время сервера
  confirmLicence(db, 'apteka-1', { now: NOW + 2 * HOUR, days: 7 }, fakeSeal)
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + 2 * HOUR, NOW + 2 * HOUR])
})

test('отметка «дожила до» назад не идёт и новой проверкой сбрасывается на время сервера', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  touchLicence(db, 'apteka-1', NOW + 3 * DAY, fakeSeal)
  touchLicence(db, 'apteka-1', NOW + DAY, fakeSeal)
  assert.equal(lastSeen(db, fakeSeal), NOW + 3 * DAY)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 3 * DAY, fakeSeal).checkedAt, new Date(NOW).toISOString(), 'сама проверка при этом не «обновляется»')

  // Сервер ответил: его время и есть «сейчас»
  confirmLicence(db, 'apteka-1', { now: NOW + 3 * DAY + HOUR, days: 7 }, fakeSeal)
  assert.equal(lastSeen(db, fakeSeal), NOW + 3 * DAY + HOUR)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 3 * DAY + HOUR, fakeSeal).checkedAt, new Date(NOW + 3 * DAY + HOUR).toISOString())
  // Проверки не было — и отмечать нечего
  touchLicence(db, 'drugaya', NOW, fakeSeal)
  assert.equal(licenceOf(db, 'drugaya', NOW, fakeSeal).checkedAt, null)
})

test('запись прежней версии программы (без отметки «дожила до») читается как раньше', () => {
  const db = core()
  put(db, fakeSeal.seal(JSON.stringify({ code: 'apteka-1', checkedAt: NOW, offlineDays: 7 })))
  const l = licenceOf(db, 'apteka-1', NOW + DAY, fakeSeal)
  assert.deepEqual([l.expired, l.checkedAt], [false, new Date(NOW).toISOString()])
  assert.equal(lastSeen(db, fakeSeal), NOW)
  assert.equal(lastFloor(db, fakeSeal), NOW)
  // И запись с одной отметкой «дожила до» (без отдельной отметки часов): тогда это был один момент
  put(db, fakeSeal.seal(JSON.stringify({ code: 'apteka-1', checkedAt: NOW, seenAt: NOW + 3 * DAY, offlineDays: 7 })))
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + 3 * DAY, NOW + 3 * DAY])
})

// ── 1.6.5: срок оплаты и состояние подписки — в зашифрованной записи ──

test('срок оплаты и состояние подписки лежат в зашифрованной записи и не теряются отметками часов', () => {
  const db = core()
  assert.equal(licenceTerms(db, 'apteka-1', fakeSeal), null, 'проверки не было — записи нет')
  confirmLicence(db, 'apteka-1', { now: NOW, days: 30, paidUntil: '2026-11-01T12:00:00.000Z', status: 'active' }, fakeSeal)
  assert.deepEqual(licenceTerms(db, 'apteka-1', fakeSeal), { paidUntil: '2026-11-01T12:00:00.000Z', status: 'active' })
  const raw = stored(db)
  assert.ok(!raw.includes('2026-11-01'), 'срок оплаты лежит зашифрованным')
  touchLicence(db, 'apteka-1', NOW + DAY, fakeSeal)
  assert.deepEqual(licenceTerms(db, 'apteka-1', fakeSeal), { paidUntil: '2026-11-01T12:00:00.000Z', status: 'active' })
  // Ответ прежней версии сервера (без срока) — срок прежний
  confirmLicence(db, 'apteka-1', { now: NOW + 2 * DAY, days: 30 }, fakeSeal)
  assert.equal(licenceTerms(db, 'apteka-1', fakeSeal).paidUntil, '2026-11-01T12:00:00.000Z')
  // Сервер закрыл работу
  sealStatus(db, 'apteka-1', 'suspended', fakeSeal)
  assert.equal(licenceTerms(db, 'apteka-1', fakeSeal).status, 'suspended')
  // Записи прежней версии программы срок не знают
  put(db, fakeSeal.seal(JSON.stringify({ code: 'apteka-1', checkedAt: NOW, offlineDays: 7 })))
  assert.deepEqual(licenceTerms(db, 'apteka-1', fakeSeal), { paidUntil: null, status: null })
})

