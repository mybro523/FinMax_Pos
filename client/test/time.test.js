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

test('форматтеры дат создаются один раз — и пишут ровно то же, что прежний toLocaleString', async () => {
  const t = await import('../src/lib/time.js')
  const TZ = { timeZone: 'Asia/Dushanbe' }
  const was = {
    fmtDateTime: (d) => new Date(d).toLocaleString('ru-RU', { ...TZ }),
    fmtShort: (d) => new Date(d).toLocaleString('ru-RU', { ...TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    fmtTime: (d) => new Date(d).toLocaleString('ru-RU', { ...TZ, hour: '2-digit', minute: '2-digit' }),
    fmtDayMonth: (d) => new Date(d).toLocaleDateString('ru-RU', { ...TZ, day: '2-digit', month: '2-digit' }),
    fmtDate: (d) => new Date(d).toLocaleDateString('ru-RU', { ...TZ }),
    tjMoment: (d) => new Date(d).toLocaleString('ru-RU', { ...TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(', ', ' в '),
  }
  // Сотни моментов: каждые 7 ч 13 мин за два года, края суток и года по Душанбе
  const moments = ['2026-12-31T18:59:59.999Z', '2026-12-31T19:00:00.000Z', '2026-10-25T00:00:00Z', 1792918242265, '2026-10-25T08:36:04.657Z']
  for (let ms = Date.parse('2025-01-01T00:00:00Z'); ms < Date.parse('2027-01-01T00:00:00Z'); ms += 7 * 3600e3 + 13 * 60e3) moments.push(ms)
  for (const d of moments) for (const [name, f] of Object.entries(was)) assert.equal(t[name](d), f(d), `${name}(${new Date(d).toISOString()})`)
  // Неверная дата — как раньше «Invalid Date», а не ошибка, которая уронила бы экран
  for (const name of Object.keys(was)) assert.equal(t[name]('не дата'), 'Invalid Date', name)
  assert.equal(t.fmtDateTime(null), '—')
  // Номер чека — прежний
  assert.equal(t.chekNomer('2026-10-25T08:47:23Z'), '1025-134723')
})

test('суммы: один форматтер на всю программу — те же строки', async () => {
  const { money } = await import('../src/db/store.js')
  for (const n of [0, -0, 1, 18, 1000, 1234567.891, 0.1 + 0.2, 26.5, -482, '15', null, undefined, NaN, 99999999.995]) {
    const v = Math.round((Number(n) || 0) * 100) / 100
    assert.equal(money(n), new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v) + ' сомони', String(n))
  }
})
