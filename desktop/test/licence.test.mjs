// ── Срок работы без связи ──
//
// Программа продаёт без интернета, но подписку проверяет сервер. Здесь проверяется
// счёт дней и то, что отметку о проверке нельзя ни подправить, ни подложить.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/local/db.mjs'
import { createClock } from '../src/local/clock.mjs'
import { confirmLicence, lastFloor, lastSeen, licenceOf, offlineDaysOf, OFFLINE_DAYS_DEFAULT, touchLicence } from '../src/local/licence.mjs'
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

test('после проверки программа работает без связи семь дней — и ни часом дольше', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  const at = (ms) => licenceOf(db, 'apteka-1', NOW + ms, fakeSeal)

  assert.deepEqual([at(0).expired, at(0).warn, at(0).offlineDays], [false, false, 7])
  assert.equal(at(0).until, new Date(NOW + 7 * DAY).toISOString(), 'момент остановки известен заранее — его показывают кассиру')
  assert.equal(at(4 * DAY).warn, false)
  // За два дня до остановки — предупреждение
  assert.deepEqual([at(5 * DAY + HOUR).expired, at(5 * DAY + HOUR).warn], [false, true])
  assert.equal(at(7 * DAY - 1000).expired, false, 'последняя секунда седьмого дня ещё рабочая')
  assert.equal(at(7 * DAY).expired, true)
  assert.equal(at(30 * DAY).expired, true)
})

test('каждая проверка отсчитывает срок заново', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, fakeSeal).expired, true)
  // Интернет появился на шестой день
  confirmLicence(db, 'apteka-1', { now: NOW + 6 * DAY, days: 7 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, fakeSeal).expired, false)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 13 * DAY, fakeSeal).expired, true)
})

test('число дней назначает сервер — в границах от одного до тридцати', () => {
  assert.equal(offlineDaysOf(14), 14)
  assert.equal(offlineDaysOf(0), OFFLINE_DAYS_DEFAULT, 'ноль запретил бы работу без интернета вовсе')
  assert.equal(offlineDaysOf(-3), OFFLINE_DAYS_DEFAULT)
  assert.equal(offlineDaysOf('мусор'), OFFLINE_DAYS_DEFAULT)
  assert.equal(offlineDaysOf(undefined), OFFLINE_DAYS_DEFAULT)
  assert.equal(offlineDaysOf(365), 30, 'год без проверки — уже не проверка')
  assert.equal(offlineDaysOf(2.9), 2)

  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 14 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 10 * DAY, fakeSeal).expired, false)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 14 * DAY, fakeSeal).expired, true)
  // Ответ без числа (вход, «кто я» у прежней версии сервера) срок не сбрасывает
  confirmLicence(db, 'apteka-1', { now: NOW + DAY }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW + DAY, fakeSeal).offlineDays, 14)
  // А на компьютере, который сервер ещё ни разу не видел, — неделя
  confirmLicence(db, 'apteka-2', { now: NOW }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-2', NOW, fakeSeal).offlineDays, 7)
})

test('проверки не было — работать нельзя', () => {
  const db = core()
  const l = licenceOf(db, 'apteka-1', NOW, fakeSeal)
  assert.deepEqual([l.expired, l.checkedAt, l.until], [true, null, null])
})

test('отметка зашифрована: в файле базы её не прочитать и не поправить', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  const raw = stored(db)
  assert.ok(!raw.includes('checkedAt') && !raw.includes(String(NOW)), 'отметка лежит открытым текстом')

  // Подложили открытую запись «проверено вчера, работать можно месяц»
  put(db, 'plain:' + JSON.stringify({ code: 'apteka-1', checkedAt: NOW + 20 * DAY, offlineDays: 30 }))
  assert.equal(licenceOf(db, 'apteka-1', NOW + 21 * DAY, fakeSeal).expired, true, 'открытая запись принята там, где шифрование работает')

  // Испортили зашифрованную
  put(db, raw.slice(0, -4) + 'AAAA')
  assert.equal(licenceOf(db, 'apteka-1', NOW, fakeSeal).expired, true)
  put(db, 'мусор')
  assert.equal(licenceOf(db, 'apteka-1', NOW, fakeSeal).expired, true)
})

test('запись соседнего магазина, переложенная в чужую строку, не годится', () => {
  const db = core()
  confirmLicence(db, 'oplachena', { now: NOW + 20 * DAY, days: 30 }, fakeSeal)
  confirmLicence(db, 'dolzhnik', { now: NOW, days: 7 }, fakeSeal)
  put(db, stored(db, 'oplachena'), 'dolzhnik')
  assert.equal(licenceOf(db, 'dolzhnik', NOW + 21 * DAY, fakeSeal).expired, true)
  assert.equal(licenceOf(db, 'oplachena', NOW + 21 * DAY, fakeSeal).expired, false)
})

test('часы назад не помогают: «сейчас» раньше последней проверки — значит, время подменили', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  assert.equal(licenceOf(db, 'apteka-1', NOW - 5 * 60 * 1000, fakeSeal).expired, false, 'погрешность в пять минут — не подмена')
  assert.equal(licenceOf(db, 'apteka-1', NOW - DAY, fakeSeal).expired, true)
})

test('на компьютере без шифрования Windows отметка хранится открыто — иначе программа не работала бы вовсе', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, noSeal)
  assert.ok(stored(db).startsWith('plain:'))
  assert.equal(licenceOf(db, 'apteka-1', NOW + DAY, noSeal).expired, false)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 8 * DAY, noSeal).expired, true)
})

// ── До какого момента программа дожила ──

test('память часов стёрли и перевели дату на день проверки — неделя заново не начинается', () => {
  const db = core()
  confirmLicence(db, 'apteka-1', { now: NOW, days: 7 }, fakeSeal)
  // Программа проработала пять дней; раз в минуту она записывает, до какого момента дожила
  touchLicence(db, 'apteka-1', NOW + 5 * DAY, fakeSeal)
  assert.equal(lastSeen(db, fakeSeal), NOW + 5 * DAY)
  assert.equal(stored(db).includes(String(NOW + 5 * DAY)), false, 'отметка лежит в зашифрованной записи: поправить её в файле нельзя')

  // Строку часов из базы стёрли, дату компьютера вернули на день проверки
  const rewound = licenceOf(db, 'apteka-1', NOW + HOUR, fakeSeal)
  assert.equal(rewound.leftMs, 2 * DAY, 'осталось столько, сколько оставалось, — а не семь дней без часа')
  assert.equal(rewound.warn, true)

  // Часы программы после запуска продолжают с этой отметки, что бы ни показывал
  // компьютер, — и время чеков, и время срока. А раз сколько программа была выключена,
  // узнать не у кого (часы показывают прошлое), срок уменьшается ещё на полсуток
  const clock = createClock({ wall: () => NOW + HOUR, mono: () => 0, load: () => ({ seen: lastFloor(db, fakeSeal), licSeen: lastSeen(db, fakeSeal) }) })
  assert.equal(clock.now(), NOW + 5 * DAY)
  assert.equal(clock.lic(), NOW + 5 * DAY + 12 * HOUR)
  assert.equal(licenceOf(db, 'apteka-1', clock.lic(), fakeSeal).expired, false)
  assert.equal(licenceOf(db, 'apteka-1', clock.lic() + 2 * DAY, fakeSeal).expired, true)
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
  assert.equal(licenceOf(db, 'apteka-1', NOW, fakeSeal).leftMs, 7 * DAY - 22 * HOUR, 'срок считается от своей отметки')
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

  // Сервер ответил: его время и есть «сейчас», срок — заново
  confirmLicence(db, 'apteka-1', { now: NOW + 3 * DAY + HOUR, days: 7 }, fakeSeal)
  assert.equal(lastSeen(db, fakeSeal), NOW + 3 * DAY + HOUR)
  assert.equal(licenceOf(db, 'apteka-1', NOW + 3 * DAY + HOUR, fakeSeal).leftMs, 7 * DAY)
  // Проверки не было — и отмечать нечего
  touchLicence(db, 'drugaya', NOW, fakeSeal)
  assert.equal(licenceOf(db, 'drugaya', NOW, fakeSeal).expired, true)
})

test('запись прежней версии программы (без отметки «дожила до») читается как раньше', () => {
  const db = core()
  put(db, fakeSeal.seal(JSON.stringify({ code: 'apteka-1', checkedAt: NOW, offlineDays: 7 })))
  const l = licenceOf(db, 'apteka-1', NOW + DAY, fakeSeal)
  assert.deepEqual([l.expired, l.leftMs], [false, 6 * DAY])
  assert.equal(lastSeen(db, fakeSeal), NOW)
  assert.equal(lastFloor(db, fakeSeal), NOW)
  // И запись с одной отметкой «дожила до» (без отдельной отметки часов): тогда это был один момент
  put(db, fakeSeal.seal(JSON.stringify({ code: 'apteka-1', checkedAt: NOW, seenAt: NOW + 3 * DAY, offlineDays: 7 })))
  assert.deepEqual([lastSeen(db, fakeSeal), lastFloor(db, fakeSeal)], [NOW + 3 * DAY, NOW + 3 * DAY])
})
