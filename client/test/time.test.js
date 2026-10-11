// Время в системе — таджикское и серверное, а не с часов устройства.
// На живой кассе компьютер спешил почти на три минуты: только что созданный чек
// показывал одно время, а сохранённый на сервере — другое.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setServerTime, serverNow, serverSkew, dayKey, startOfDay, lastNDayKeys } from '../src/lib/time.js'

test('без ответа сервера берём часы устройства', () => {
  setServerTime(null)
  assert.equal(serverSkew(), 0)
  assert.ok(Math.abs(serverNow().getTime() - Date.now()) < 50)
})

test('часы устройства спешат — время берём серверное', () => {
  // Сервер на 3 минуты позади устройства (ровно случай с боевой кассы)
  const serverMoment = new Date(Date.now() - 3 * 60000)
  setServerTime(serverMoment.toUTCString())
  const diff = Math.abs(serverNow().getTime() - serverMoment.getTime())
  assert.ok(diff < 1500, `расхождение ${diff} мс — должно быть около нуля`)
  assert.ok(serverSkew() < -2 * 60000, 'сдвиг отрицательный: устройство впереди')
})

test('часы устройства отстают — тоже подтягиваемся к серверу', () => {
  const serverMoment = new Date(Date.now() + 5 * 60000)
  setServerTime(serverMoment.toUTCString())
  assert.ok(Math.abs(serverNow().getTime() - serverMoment.getTime()) < 1500)
})

test('битый заголовок не сбивает часы', () => {
  setServerTime(new Date(Date.now() + 60000).toUTCString())
  const before = serverSkew()
  setServerTime('чепуха')
  setServerTime(undefined)
  assert.equal(serverSkew(), before, 'при мусоре оставляем прежнее расхождение')
})

test('«сегодня» считается по серверу: дата устройства сбита на сутки', () => {
  // Устройство думает, что уже завтра, — выручка за день ушла бы не в тот день
  const realNow = new Date('2026-08-16T19:30:00.000Z') // 17 августа 00:30 по Душанбе
  setServerTime(realNow.toUTCString())
  assert.equal(dayKey(), '2026-08-17')
  assert.equal(startOfDay().toISOString(), new Date('2026-08-17T00:00:00.000+05:00').toISOString())
})

test('день по Душанбе, а не по UTC', () => {
  // 16 августа 20:00 UTC — в Душанбе уже 17-е
  setServerTime(new Date('2026-08-16T20:00:00.000Z').toUTCString())
  assert.equal(dayKey(), '2026-08-17')
  // 16 августа 18:00 UTC — в Душанбе ещё 16-е (23:00)
  setServerTime(new Date('2026-08-16T18:00:00.000Z').toUTCString())
  assert.equal(dayKey(), '2026-08-16')
})

test('последние дни отсчитываются от серверного времени', () => {
  setServerTime(new Date('2026-08-16T19:30:00.000Z').toUTCString())
  const keys = lastNDayKeys(3)
  assert.deepEqual(keys, ['2026-08-15', '2026-08-16', '2026-08-17'])
})
