// ── Деньги, штуки и время локальной базы ──
//
// Чек, пробитый без интернета, должен сойтись с сервером до дирама. Поэтому счёт
// здесь обязан повторять серверный не «по смыслу», а буквально — вместе с его
// округлениями. Эти проверки держат три копии одних и тех же правил (сервер, окно,
// основная часть программы) вместе.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClock, RHYTHM_DEFAULT } from '../src/local/clock.mjs'
import { D, dmax, dmin, fixed2, fromCents, fromCentsD, toCents } from '../src/local/money.mjs'
import { dayKeyTj, expiryLimit, isExpired, isoOrNull, startOfTodayTj, tjMoment } from '../src/local/time.mjs'
import { packsToUnits, splitUnits, uppOf, wholeNonNeg } from '../src/local/units.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── Деньги ──

test('счёт идёт с той же точностью, что на сервере: 20 значащих цифр', () => {
  // Три штуки из пачки в двенадцать по 2,50. По-школьному это ровно 0,625,
  // то есть 63 дирама. Сервер делит с двадцатью цифрами и получает на волосок
  // меньше — 62 дирама. Касса обязана получить те же 62: чек уже напечатан.
  const sum = D(2.5).dividedBy(12).times(3)
  assert.equal(sum.toString(), '0.62499999999999999999')
  assert.equal(toCents(sum), 62)
})

test('библиотека точных чисел — той же версии, что у сервера', () => {
  // Сервер считает деньги через Prisma, внутри которой decimal.js 10.4.3.
  // Другая версия вправе округлять иначе — и чеки разойдутся молча
  const mine = JSON.parse(readFileSync(join(ROOT, 'desktop', 'node_modules', 'decimal.js', 'package.json'), 'utf8')).version
  assert.equal(mine, '10.4.3')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['decimal.js'], '10.4.3', 'версия должна быть закреплена точно, без «^»')
})

test('округление до дирама: половина — от нуля, как в базе сервера', () => {
  assert.equal(toCents('0.125'), 13)
  assert.equal(toCents('0.135'), 14)
  assert.equal(toCents('0.124999'), 12)
  assert.equal(toCents('-0.125'), -13)
  assert.equal(toCents(0), 0)
  assert.equal(toCents(1234567.89), 123456789)
  // Обычная беда дробных чисел: 0.1 + 0.2 ≠ 0.3. Здесь её нет
  assert.equal(toCents(D(0.1).plus(0.2)), 30)
  assert.equal(toCents(D(1.005)), 101)
})

test('дирамы превращаются в то же число, что отдаёт сервер', () => {
  // Сервер отдаёт сумму обычным числом: 0.63, 150, 12.5
  assert.equal(fromCents(63), 0.63)
  assert.equal(fromCents(15000), 150)
  assert.equal(fromCents(1250), 12.5)
  assert.equal(JSON.stringify(fromCents(1999)), '19.99')
  assert.equal(fromCentsD(1999).toString(), '19.99')
  // Туда и обратно — без потерь на всём диапазоне разумных сумм
  for (const c of [0, 1, 5, 99, 100, 101, 12345, 999999999]) assert.equal(toCents(fromCents(c)), c)
})

test('пустое и мусор считаются нулём, а не роняют продажу', () => {
  for (const v of [undefined, null, '', 'abc', NaN, Infinity, {}]) assert.equal(toCents(D(v)), 0, String(v))
  assert.equal(dmin(5, 3).toString(), '3')
  assert.equal(dmax(0, -2).toString(), '0')
  assert.equal(fixed2(D(12.5)), '12.50')
  assert.equal(fixed2(D(0)), '0.00')
})

// ── Упаковки и штуки ──

test('штуки раскладываются на упаковки и вскрытую так же, как в окне', async () => {
  const client = await import(pathToFileURL(join(ROOT, 'client', 'src', 'lib', 'units.js')).href)
  for (const upp of [1, 2, 10, 12, 20, 0, null, undefined, 'x', -3]) {
    assert.equal(uppOf({ unitsPerPack: upp }), client.uppOf({ unitsPerPack: upp }), `штук в упаковке: ${upp}`)
    for (const units of [0, 1, 9, 10, 11, 239, -5]) {
      assert.deepEqual(splitUnits(units, upp), client.splitUnits(units, { unitsPerPack: upp }), `${units} шт по ${upp}`)
    }
  }
  assert.equal(packsToUnits(3, 7, 10), 37)
  assert.equal(packsToUnits(3, 7, 10), client.stockUnits({ stock: 3, looseUnits: 7, unitsPerPack: 10 }))
  assert.equal(wholeNonNeg(2.9), 2)
  assert.equal(wholeNonNeg(-1), 0)
  assert.equal(wholeNonNeg('abc'), 0)
})

// ── Время ──

test('сутки считаются по Душанбе, а не по часам компьютера', async () => {
  const client = await import(pathToFileURL(join(ROOT, 'client', 'src', 'lib', 'time.js')).href)
  // 23:30 по Душанбе 3 октября и 00:30 4 октября — по всемирному времени это один день
  const before = Date.parse('2026-10-03T18:30:00.000Z')
  const after = Date.parse('2026-10-03T19:30:00.000Z')
  assert.equal(dayKeyTj(before), '2026-10-03')
  assert.equal(dayKeyTj(after), '2026-10-04')
  assert.equal(startOfTodayTj(after).toISOString(), '2026-10-03T19:00:00.000Z')
  for (const t of [before, after]) {
    assert.equal(dayKeyTj(t), client.dayKey(new Date(t)))
    assert.equal(startOfTodayTj(t).getTime(), client.startOfDay(new Date(t)).getTime())
  }
})

test('срок годности — последний день, когда товар годен', () => {
  const now = Date.parse('2026-10-04T10:00:00.000Z') // 4 октября, день
  assert.equal(expiryLimit(now), '2026-10-03T19:00:00.000Z')
  assert.equal(isExpired('2026-10-04T00:00:00.000Z', now), false, '«годен до 4-го» — 4-го ещё продаём')
  assert.equal(isExpired('2026-10-03T00:00:00.000Z', now), true, '«годен до 3-го» — 4-го уже нет')
  assert.equal(isExpired(null, now), false, 'без срока просроченным не бывает')
  // Ночью по Душанбе, когда по всемирному времени ещё вчера
  const night = Date.parse('2026-10-03T20:00:00.000Z') // 01:00 4 октября
  assert.equal(isExpired('2026-10-03T00:00:00.000Z', night), true)
  assert.equal(isExpired('2026-10-04T00:00:00.000Z', night), false)
})

test('даты приводятся к одному виду, мусор — к пустому', () => {
  assert.equal(isoOrNull('2026-09-24'), '2026-09-24T00:00:00.000Z')
  assert.equal(isoOrNull('2026-09-24T00:00:00.000Z'), '2026-09-24T00:00:00.000Z')
  assert.equal(isoOrNull(new Date('2026-09-24T05:00:00+05:00')), '2026-09-24T00:00:00.000Z')
  for (const v of [null, undefined, '', 'не дата']) assert.equal(isoOrNull(v), null)
  assert.equal(tjMoment('2026-08-23T12:00:00.000Z'), '23.08.2026 в 17:00')
})

// ── Часы программы ──

function fakeTime(wall0 = 1_000_000) {
  const t = { wall: wall0, mono: 500 }
  let saved = null
  return {
    t,
    saved: () => saved,
    opts: (initial = null) => ({
      wall: () => t.wall,
      mono: () => t.mono,
      load: () => initial,
      save: (s) => (saved = s),
    }),
    // Прошло столько-то настоящего времени
    pass(ms) {
      t.wall += ms
      t.mono += ms
    },
  }
}

test('часы: без сервера идут по часам компьютера', () => {
  const f = fakeTime()
  const clock = createClock(f.opts())
  assert.equal(clock.now(), 1_000_000)
  f.pass(5000)
  assert.equal(clock.now(), 1_005_000)
})

test('часы: ответ сервера поправляет время, поправка переживает перезапуск', () => {
  const f = fakeTime()
  const clock = createClock(f.opts())
  // Часы компьютера отстают: сервер говорит, что сейчас на час больше
  const server = new Date(f.t.wall + 3_600_000)
  assert.equal(clock.serverTime(server.toUTCString()), true)
  assert.ok(Math.abs(clock.now() - (f.t.wall + 3_600_000)) < 1000)
  assert.ok(f.saved(), 'поправка не записана на диск')

  // Перезапуск без интернета: поправка читается с диска
  f.pass(60_000)
  const again = createClock(f.opts(f.saved()))
  assert.ok(Math.abs(again.now() - (f.t.wall + 3_600_000)) < 1000)
  // Мусор вместо времени сервера ничего не меняет
  assert.equal(again.serverTime('ерунда'), false)
})

test('часы: перевод часов компьютера на время программы не влияет', () => {
  const f = fakeTime()
  const clock = createClock(f.opts())
  f.pass(10_000)
  const before = clock.now()
  // Кассир (или кто-то хитрый) перевёл часы на сутки назад
  f.t.wall -= 86_400_000
  assert.equal(clock.now(), before, 'время программы скакнуло вслед за часами компьютера')
  f.pass(1000)
  assert.equal(clock.now(), before + 1000)
  // И вперёд тоже: опечатка в дате не уводит время, пока программа работает
  f.t.wall += 40 * 86_400_000
  assert.equal(clock.now(), before + 1000)
})

test('часы: после перезапуска время не раньше последнего запомненного', () => {
  const f = fakeTime()
  const clock = createClock(f.opts())
  f.pass(30_000)
  clock.persist()
  const seen = f.saved().seen
  assert.equal(seen, 1_030_000)

  // Программу закрыли, часы перевели на неделю назад, открыли снова
  f.t.wall -= 7 * 86_400_000
  const again = createClock(f.opts(f.saved()))
  assert.ok(again.now() >= seen, 'перевод часов назад дал бы лишнюю неделю работы без связи')
  assert.equal(again.doubtful(), true)
  const from = again.now()
  f.pass(5000)
  assert.equal(again.now(), from + 5000)

  // А сервер прав всегда — даже если он «позади» запомненного
  again.serverTime(new Date(seen - 600_000).toUTCString())
  assert.ok(Math.abs(again.now() - (seen - 600_000)) < 1000)
  assert.equal(again.doubtful(), false)
})

test('часы: сбой записи на диск время не останавливает', () => {
  const f = fakeTime()
  const clock = createClock({ ...f.opts(), save: () => assert.fail('диск недоступен') })
  assert.doesNotThrow(() => clock.persist())
  assert.equal(clock.now(), 1_000_000)
})

// Настоящее время, а не миллион миллисекунд от начала эпохи: счёт идёт на часы и дни
const OCT4 = Date.parse('2026-10-04T10:00:00.000Z')
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
// Села батарейка на плате: при каждом включении часы компьютера начинают с этого дня
const BIOS = Date.parse('2015-01-01T00:00:00.000Z')

test('часы: компьютер после запуска показывает время раньше уже виденного — время не выдумывается, а программа говорит, что часам верить нельзя', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  assert.equal(clock.doubtful(), false)
  assert.equal(clock.unverified(), false)
  f.pass(10 * HOUR_MS) // рабочий день
  clock.persist()
  const evening = f.saved().seen
  assert.equal(evening, OCT4 + 10 * HOUR_MS)

  // Утром компьютер включили — на его часах 2015 год. Сколько он был выключен, узнать не у кого
  f.t.wall = BIOS + 60_000
  const morning = createClock(f.opts(f.saved()))
  assert.equal(morning.now(), evening, 'время продолжается с последнего увиденного момента: ни назад, ни «полсуток наугад»')
  assert.equal(morning.doubtful(), true, 'человек должен узнать, что времени верить нельзя')
  assert.equal(morning.unverified(), true)
  f.pass(HOUR_MS)
  morning.persist()
  assert.equal(morning.now(), evening + HOUR_MS)
  assert.equal(f.saved().unsure, true)

  // Программу закрыли и открыли снова (компьютер не выключали) — время идёт дальше:
  // сбитые часы всё это время шли, и их ходу можно верить. Сомнение остаётся
  f.pass(10 * 60_000)
  const again = createClock(f.opts(f.saved()))
  assert.equal(again.now(), evening + HOUR_MS + 10 * 60_000)
  assert.equal(again.doubtful(), true)
  again.persist()

  // Свет мигнул, компьютер перезагрузился: часы снова на 2015 году. Лишнего не добавляется
  f.t.wall = BIOS + 60_000
  const reboot = createClock(f.opts(f.saved()))
  assert.equal(reboot.now(), evening + HOUR_MS + 10 * 60_000)
  assert.equal(reboot.doubtful(), true)

  // Появилась связь — сервер называет настоящее время, и сомнения больше нет
  const truth = OCT4 + 2 * DAY_MS
  reboot.serverTime(new Date(truth).toUTCString())
  assert.ok(Math.abs(reboot.now() - truth) < 1000)
  assert.equal(reboot.doubtful(), false)
  assert.equal(reboot.unverified(), false)
  assert.equal(f.saved().unsure, false)
  assert.ok(Math.abs(reboot.lic() - truth) < 1000, 'и срок работы без связи считается от времени сервера')
})

test('часы: времени не верили, человек поправил часы компьютера — программа берёт их сразу; ошибся и поправил ещё раз — тоже', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(10 * HOUR_MS)
  clock.persist()
  const evening = f.saved().seen

  f.t.wall = BIOS
  const morning = createClock(f.opts(f.saved()))
  assert.equal(morning.doubtful(), true)
  f.pass(5 * 60_000)
  assert.equal(morning.now(), evening + 5 * 60_000)
  const licBefore = morning.lic()

  // Кассир увидел подсказку и выставил на компьютере настоящее время: прошла ночь
  f.t.wall = evening + 14 * HOUR_MS
  assert.equal(morning.now(), evening + 14 * HOUR_MS, 'ждать перезапуска или связи не нужно')
  assert.equal(morning.doubtful(), false)
  assert.equal(morning.unverified(), true, 'но время взято с часов компьютера — сервером оно не сверено')
  f.pass(60_000)
  assert.equal(morning.now(), evening + 14 * HOUR_MS + 60_000)

  // Ошибся месяцем: на часах компьютера на 31 день больше
  f.t.wall += 31 * DAY_MS
  assert.equal(morning.now(), evening + 14 * HOUR_MS + 60_000 + 31 * DAY_MS)
  assert.equal(morning.lic(), licBefore + 60_000, 'срок работы без связи за часами компьютера не идёт: опечатка не запрёт кассу')
  morning.persist()
  assert.equal(f.saved().seen, evening + 6 * 60_000, 'и отметкой «раньше этого время не вернётся» опечатка не становится')

  // Заметил и поправил — время возвращается, не дожидаясь сервера
  f.t.wall -= 31 * DAY_MS
  assert.equal(morning.now(), evening + 14 * HOUR_MS + 60_000)

  // Часы сбились снова (на три дня назад) — время не раньше того, что программа насчитала сама
  f.t.wall -= 3 * DAY_MS
  f.pass(60_000)
  assert.equal(morning.now(), evening + 7 * 60_000)
  assert.equal(morning.doubtful(), true)
})

test('часы: времени не верили, а на часах компьютера выставили немыслимо далёкий год — программа за ними не идёт', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  clock.persist()
  f.t.wall = BIOS
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.doubtful(), true)
  // Опечатка в годе: 2062 вместо 2026
  f.t.wall = Date.parse('2062-10-05T10:00:00.000Z')
  assert.equal(next.now(), OCT4 + HOUR_MS)
  assert.equal(next.doubtful(), true, 'подсказка остаётся: такие часы тоже неверные')
})

test('часы: немыслимо далёкий год на часах компьютера при запуске — время не убегает, человеку говорят про часы', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  clock.persist()
  const seen = f.saved().seen
  f.t.wall = Date.parse('2062-10-05T10:00:00.000Z')
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), seen, 'раньше программа приняла бы 2062 год и закрылась: «слишком долго без связи»')
  assert.equal(next.doubtful(), true)
})

test('часы: дату по ошибке перевели на день назад, потом — программа закрыта — вернули: время верное, подсказки нет', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  clock.persist()
  const seen = f.saved().seen

  // Программу закрыли; через десять минут дату на компьютере по ошибке перевели на день назад
  f.t.wall += 10 * 60_000 - DAY_MS
  const wrong = createClock(f.opts(f.saved()))
  assert.equal(wrong.now(), seen)
  assert.equal(wrong.doubtful(), true)
  f.pass(5 * 60_000)
  wrong.persist()

  // Кассир увидел подсказку, закрыл программу, вернул дату и открыл программу снова
  f.t.wall += DAY_MS + 2 * 60_000
  const real = f.t.wall
  const fixed = createClock(f.opts(f.saved()))
  assert.equal(fixed.now(), real, 'с прежней поправкой время убежало бы почти на сутки вперёд — и так до появления связи')
  assert.equal(fixed.doubtful(), false, 'часы компьютера верные — просить поправить их больше незачем')
  fixed.persist()

  // И ещё один перезапуск ничего не портит
  f.pass(3 * 60_000)
  const once = createClock(f.opts(f.saved()))
  assert.equal(once.now(), real + 3 * 60_000)
  assert.equal(once.doubtful(), false)
  // Срок работы без связи: час работы до первого запуска со сбитыми часами и пять минут
  // до второго — столько же он уменьшился за два неизвестных простоя (ритм этого
  // компьютера ещё не известен, считается «час на час»); остальное — по секундомеру
  assert.equal(once.lic(), seen + HOUR_MS + 13 * 60_000)
})

test('часы: дату перевели назад, пока программа работала, и вернули, пока она была закрыта, — время вперёд не убегает', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  f.t.wall -= DAY_MS
  f.pass(HOUR_MS)
  clock.persist() // поправка стала «плюс сутки»
  f.t.wall += DAY_MS + 10 * 60_000
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), OCT4 + 2 * HOUR_MS + 10 * 60_000, 'с поправкой «плюс сутки» программа потеряла бы день работы без связи')
  assert.equal(next.doubtful(), false)
})

test('часы: часы компьютера спешили на час, их поправили, пока программа была закрыта, — запуск через десять минут начинается с верного времени', () => {
  const f = fakeTime(OCT4 + HOUR_MS)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  f.pass(30 * 60_000)
  clock.persist()
  const seen = f.saved().seen
  // Программу закрыли; Windows сверила часы (минус час); через десять минут открыли без связи
  f.t.wall += 10 * 60_000 - HOUR_MS
  const again = createClock(f.opts(f.saved()))
  // С прежней поправкой вышло бы «пятьдесят минут назад»; часы компьютера сами показывают верно
  assert.ok(Math.abs(again.now() - (seen + 10 * 60_000)) < 1000, `время ушло на ${Math.round((again.now() - seen - 10 * 60_000) / 60_000)} мин`)
  assert.equal(again.doubtful(), false)
  // И поправка больше не тянется за программой
  again.persist()
  assert.ok(Math.abs(f.saved().offset) < 2000)
})

test('часы: поправка «плюс одиннадцать лет» осталась от загрузки с неверным годом — после починки часов программа в будущее не уходит', () => {
  // Села батарейка: на часах компьютера 2015 год. Сервер назвал настоящее время
  const f = fakeTime(BIOS)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  f.pass(60_000)
  clock.persist()
  const seen = f.saved().seen
  // Программу закрыли, часы компьютера починили, назавтра открыли без связи
  f.t.wall = seen + 14 * HOUR_MS
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), seen + 14 * HOUR_MS, 'с прежней поправкой программа начала бы день в 2038 году и закрылась бы: «слишком долго без связи»')
  assert.equal(next.doubtful(), false)
})

test('часы: часы компьютера идут, но показывают 2015 год; касса простояла полтора месяца — поправке верим', () => {
  // Батарейка цела, просто дату никто не выставил. Поправку подсказал сервер
  const f = fakeTime(BIOS)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  clock.persist()
  const seen = f.saved().seen
  f.t.wall += 46 * DAY_MS
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), seen + 46 * DAY_MS)
  assert.equal(next.doubtful(), false)
})

test('часы: время перевели назад, пока программа работала, и свет погас раньше, чем она это запомнила, — лишнего времени не добавляется', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  clock.persist()
  const seen = f.saved().seen
  // Часы компьютера перевели на сутки назад; до следующей записи программа не дожила
  f.t.wall -= DAY_MS
  f.pass(10_000)
  // Включили через пять минут
  f.pass(5 * 60_000)
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), seen, 'не раньше увиденного — и не «полсуток вперёд»')
  assert.equal(next.doubtful(), true, 'часы компьютера отстают на сутки — об этом надо сказать')
})

test('часы: касса простояла выключенной два месяца — время верное, вместе с поправкой', () => {
  // Часы компьютера отстают на три минуты; сервер это поправил
  const f = fakeTime(OCT4 - 3 * 60_000)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  clock.persist()
  const seen = f.saved().seen
  f.t.wall += 60 * DAY_MS
  const next = createClock(f.opts(f.saved()))
  assert.equal(next.now(), seen + 60 * DAY_MS)
  assert.equal(next.doubtful(), false)
})

test('часы: исправные часы компьютера — ничего не добавляется, время настоящее', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(10 * HOUR_MS)
  clock.persist()
  // Ночь прошла по-настоящему: компьютер был выключен четырнадцать часов
  f.t.wall += 14 * HOUR_MS
  const morning = createClock(f.opts(f.saved()))
  assert.equal(morning.now(), OCT4 + 24 * HOUR_MS)
  assert.equal(morning.lic(), OCT4 + 24 * HOUR_MS, 'и срок работы без связи идёт по тому же времени')
})

test('часы: ответы сервера не дёргают время туда-сюда — чек не окажется раньше предыдущего', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4 + 5000).toUTCString())
  const base = clock.now()
  // Сервер называет время с точностью до секунды. Каждый его ответ — в пределах этой
  // неточности; раньше каждый такой ответ отбрасывал часы на доли секунды назад
  let last = base
  for (let i = 1; i <= 20; i++) {
    f.pass(950)
    const header = new Date(Math.floor((OCT4 + 5000 + i * 950) / 1000) * 1000).toUTCString()
    clock.serverTime(header)
    assert.ok(clock.now() >= last, `время пошло назад на шаге ${i}`)
    last = clock.now()
  }
  assert.equal(last, base + 20 * 950, 'часы шли ровно, без подёргиваний')

  // Настоящее расхождение (часы убежали на минуту) сервер поправляет, как и раньше
  clock.serverTime(new Date(clock.now() - 60_000).toUTCString())
  assert.ok(Math.abs(clock.now() - (last - 60_000)) < 1500)
})

test('часы: большой ответ дочитывался сорок секунд — время сервера берётся с поправкой на это', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  // Сервер начал отвечать «в 10:05:00»; пока ответ дочитали, прошло сорок секунд
  const header = new Date(OCT4 + 5 * 60_000).toUTCString()
  clock.serverTime(header, 40_000)
  assert.ok(Math.abs(clock.now() - (OCT4 + 5 * 60_000 + 40_000)) <= 1000, 'иначе часы отстали бы на сорок секунд, и чек, пробитый за это время, стал бы «позже» следующего')
})

test('часы: компьютеру поправили время, пока программа работала, — следующий запуск начинается с верного времени', () => {
  // Часы компьютера спешили на час; сервер сказал настоящее время — поправка «минус час»
  const f = fakeTime(OCT4 + HOUR_MS)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  f.pass(10 * 60_000)
  // Windows сверила время: часы компьютера теперь верные. Время программы от этого не меняется
  f.t.wall -= HOUR_MS
  const before = clock.now()
  f.pass(5 * 60_000)
  // Очередной ответ сервера: время совпадает, двигать нечего — но поправка уже другая
  clock.serverTime(new Date(clock.now()).toUTCString())
  assert.ok(Math.abs(clock.now() - (before + 5 * 60_000)) < 1500)
  clock.persist()

  // Программу закрыли и через полчаса открыли без интернета
  f.t.wall += 30 * 60_000
  const again = createClock(f.opts(f.saved()))
  const truth = OCT4 + 45 * 60_000 + 500
  assert.ok(Math.abs(again.now() - truth) < 2000, `после запуска время ушло на ${Math.round((again.now() - truth) / 60_000)} мин: поправка осталась прежней, хотя часы компьютера уже верные`)
})

test('часы: компьютер загрузился не с тем годом, потом время исправили — будущее в программу не попадает', () => {
  // Села батарейка: часы показывают 2015 год. Сервер сказал настоящее время
  const f = fakeTime(BIOS)
  const clock = createClock(f.opts())
  clock.serverTime(new Date(OCT4).toUTCString())
  f.pass(60_000)
  // Windows исправила часы компьютера на настоящие
  f.t.wall = clock.now()
  f.pass(60_000)
  clock.persist()
  const seen = f.saved().seen

  // Назавтра — запуск без интернета, часы компьютера верные
  f.t.wall += 14 * HOUR_MS
  const next = createClock(f.opts(f.saved()))
  assert.ok(Math.abs(next.now() - (seen + 14 * HOUR_MS)) < 2000, 'с прежней поправкой (плюс одиннадцать лет) программа начала бы день в 2038 году')
})

test('часы: время перевели, пока программа работала без связи, — и это не сбивает следующий запуск', () => {
  const f = fakeTime(OCT4)
  const clock = createClock(f.opts())
  f.pass(HOUR_MS)
  // Кассир перевёл часы компьютера на сутки назад; сервера нет
  f.t.wall -= 24 * HOUR_MS
  f.pass(HOUR_MS)
  clock.persist()
  assert.equal(clock.now(), OCT4 + 2 * HOUR_MS, 'время программы за часами компьютера не ходит')
  // Перезапуск через десять минут: продолжаем оттуда же, и сомневаться не в чем
  f.t.wall += 10 * 60_000
  const again = createClock(f.opts(f.saved()))
  assert.equal(again.now(), OCT4 + 2 * HOUR_MS + 10 * 60_000)
  assert.equal(again.doubtful(), false)
})

// ── Время для срока работы без связи ──

// Обычные дни на исправном компьютере: столько-то часов работы, потом его выключают
// до утра (часы компьютера идут). Возвращает часы утром следующего дня
function usualDays(f, hours, days = 7) {
  let clock = createClock(f.opts())
  for (let day = 0; day < days; day++) {
    f.pass(hours * HOUR_MS)
    clock.persist()
    f.t.wall += (24 - hours) * HOUR_MS
    clock = createClock(f.opts(f.saved()))
  }
  return clock
}
// Компьютер выключили и включили, а батарейка на плате села: на часах снова 2015 год
function deadBoot(f, clock) {
  clock.persist()
  f.t.wall = BIOS + 60_000
  return createClock(f.opts(f.saved()))
}

test('срок без связи: батарейка села — за ночь срок уменьшается на ночь, как заведено у этого компьютера', () => {
  const f = fakeTime(OCT4)
  // Неделю магазин работал как обычно: десять часов в день, на ночь компьютер выключали
  let clock = usualDays(f, 10)
  assert.ok(Math.abs(clock.rhythm() - 1.4) < 0.01, 'на час работы — 1,4 часа простоя: программа это запомнила')
  const from = clock.lic()
  const shown = clock.now()
  // Батарейка села, связи нет. Ещё неделя таких же дней
  for (let day = 0; day < 7; day++) {
    f.pass(10 * HOUR_MS)
    clock = deadBoot(f, clock)
  }
  // Время чеков не выдумано: ровно то, что программа насчитала сама
  assert.equal(clock.now(), shown + 70 * HOUR_MS)
  // А срок идёт как настоящее время: неделя — это неделя, а не «70 рабочих часов»
  const used = (clock.lic() - from) / DAY_MS
  assert.ok(Math.abs(used - 7) < 0.05, `за неделю срок уменьшился на ${used.toFixed(2)} сут.`)
})

test('срок без связи: круглосуточный магазин, где свет мигает трижды в день, срок не теряет', () => {
  const f = fakeTime(OCT4)
  // Компьютер не выключают; раз в сутки его перезагружают — простой пять минут
  let clock = createClock(f.opts())
  for (let day = 0; day < 7; day++) {
    f.pass(24 * HOUR_MS - 5 * 60_000)
    clock.persist()
    f.t.wall += 5 * 60_000
    clock = createClock(f.opts(f.saved()))
  }
  assert.ok(clock.rhythm() < 0.01, 'простоев у этого компьютера почти нет')
  const from = clock.lic()
  // Батарейка села, связи нет, свет отключают каждые восемь часов на пять минут
  for (let cut = 0; cut < 21; cut++) {
    f.pass(8 * HOUR_MS - 5 * 60_000)
    clock = deadBoot(f, clock)
  }
  const used = (clock.lic() - from) / DAY_MS
  assert.ok(used > 6.85 && used < 7.05, `за неделю срок уменьшился на ${used.toFixed(2)} сут.: «полсуток за каждое включение» сожгли бы его за три дня`)
})

test('срок без связи: магазин с рабочим днём, где днём ещё и свет мигает, — срок идёт как настоящее время, сколько бы раз ни включали', () => {
  const f = fakeTime(OCT4)
  let clock = usualDays(f, 12)
  const from = clock.lic()
  // Двенадцать часов работы в три приёма (свет мигнул дважды), потом ночь
  for (let day = 0; day < 7; day++) {
    for (const hours of [3, 5, 4]) {
      f.pass(hours * HOUR_MS)
      clock = deadBoot(f, clock)
    }
  }
  const used = (clock.lic() - from) / DAY_MS
  assert.ok(Math.abs(used - 7) < 0.05, `за неделю срок уменьшился на ${used.toFixed(2)} сут.`)
})

test('срок без связи: ритм компьютера ещё не известен — за час работы считается час простоя', () => {
  const f = fakeTime(OCT4)
  let clock = createClock(f.opts())
  assert.equal(clock.rhythm(), RHYTHM_DEFAULT)
  f.pass(10 * HOUR_MS)
  clock = deadBoot(f, clock)
  assert.equal(clock.lic(), OCT4 + 20 * HOUR_MS, 'десять часов работы — и десять за ночь')
  // Свет мигнул через час: за этот час — час, а не ещё одна ночь
  f.pass(HOUR_MS)
  clock = deadBoot(f, clock)
  assert.equal(clock.lic(), OCT4 + 22 * HOUR_MS)
  // Работа и простой после неё вместе — не больше суток: после шестнадцати часов работы
  // простой считается восемью часами, а не шестнадцатью
  f.pass(16 * HOUR_MS)
  clock = deadBoot(f, clock)
  assert.equal(clock.lic(), OCT4 + 22 * HOUR_MS + 24 * HOUR_MS)
  // Программа проработала пять суток подряд — компьютер на ночь не выключают: простоя не было
  f.pass(5 * DAY_MS)
  clock = deadBoot(f, clock)
  assert.equal(clock.lic(), OCT4 + 46 * HOUR_MS + 5 * DAY_MS)
})

test('срок без связи: компьютер, где часы сбиваются при каждом включении, узнаёт свой ритм по ответам сервера', () => {
  // Батарейка села давно, но интернет есть: каждое утро время называет сервер
  const f = fakeTime(BIOS)
  let truth = OCT4
  let clock = createClock(f.opts())
  clock.serverTime(new Date(truth).toUTCString())
  for (let day = 0; day < 6; day++) {
    f.pass(10 * HOUR_MS)
    truth += 10 * HOUR_MS
    clock = deadBoot(f, clock)
    truth += 14 * HOUR_MS
    assert.equal(clock.unverified(), true)
    // Через пять секунд после запуска отвечает сервер — и становится известно, сколько длилась ночь
    f.pass(5000)
    truth += 5000
    clock.serverTime(new Date(truth).toUTCString())
    assert.ok(Math.abs(clock.lic() - truth) < 1500)
  }
  assert.ok(Math.abs(clock.rhythm() - 1.4) < 0.02, `ритм: ${clock.rhythm().toFixed(3)}`)
  // Интернет пропал — срок за ночь уменьшается на ночь
  const from = clock.lic()
  f.pass(10 * HOUR_MS)
  clock = deadBoot(f, clock)
  assert.ok(Math.abs(clock.lic() - from - 24 * HOUR_MS) < 0.5 * HOUR_MS)
})

test('срок без связи: отпуск на две недели ритм не ломает', () => {
  const f = fakeTime(OCT4)
  let clock = usualDays(f, 10)
  // Ещё один рабочий день — и магазин закрыт на две недели
  f.pass(10 * HOUR_MS)
  clock.persist()
  f.t.wall += 14 * DAY_MS
  clock = createClock(f.opts(f.saved()))
  assert.ok(clock.rhythm() < 1.45, `долгий простой учится как одна ночь: ${clock.rhythm().toFixed(2)}`)
  // А программу, которую открыли на минуту и закрыли на месяц, ритм не замечает вовсе
  const was = clock.rhythm()
  f.pass(60_000)
  clock.persist()
  f.t.wall += 30 * DAY_MS
  clock = createClock(f.opts(f.saved()))
  assert.ok(Math.abs(clock.rhythm() - was) < 0.01)
})

test('срок без связи: память часов стёрли и перевели дату — время срока продолжается с зашифрованной отметки', () => {
  // Строки часов в базе нет, а запись о проверке подписки (её не стереть) помнит,
  // до какого момента дожил срок
  const clock = createClock({ wall: () => OCT4, mono: () => 0, load: () => ({ licSeen: OCT4 + 5 * DAY_MS }) })
  assert.equal(clock.lic(), OCT4 + 5 * DAY_MS)
})

// ── Случайные дни ──
// Часы компьютера переводят, батарейка садится, свет гаснет, сервер то отвечает, то нет —
// в любом порядке. Что бы ни происходило, несколько вещей обязаны оставаться верными.

// Свой генератор случайных чисел: провал должен повторяться
function dice(seed) {
  let x = seed >>> 0
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 4294967296
  }
  return { next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: (list) => list[Math.floor(next() * list.length)] }
}

test('часы: тысячи случайных дней — «верное» время и срок назад не идут, сервер всегда прав, а на исправном компьютере время просто верное', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = dice(seed)
    // Три вида компьютеров: исправный; с севшей батарейкой; тот, где часы переводят руками
    const kind = rnd.pick(['honest', 'battery', 'hands'])
    const f = fakeTime(OCT4)
    let truth = OCT4
    let clock = createClock(f.opts())
    let saved = null
    const where = (step, what) => `зерно ${seed}, шаг ${step} (${kind}): ${what}`
    const run = (ms) => {
      f.pass(ms)
      truth += ms
    }
    for (let step = 0; step < 60; step++) {
      const floorWas = clock.floor()
      const licWas = clock.lic()
      const event = rnd.pick(['run', 'run', 'persist', 'restart', 'boot', 'server', ...(kind === 'hands' ? ['hands', 'hands'] : [])])
      let answered = false
      if (event === 'run') run(rnd.int(60_000, 12 * HOUR_MS))
      else if (event === 'persist') clock.persist()
      else if (event === 'hands') {
        // Дату и время на компьютере поменяли руками: на минуты, часы, дни или годы
        f.t.wall += rnd.pick([-1, 1]) * rnd.pick([10 * 60_000, 3 * HOUR_MS, DAY_MS, 31 * DAY_MS, 600 * DAY_MS])
      } else if (event === 'server') {
        clock.serverTime(new Date(truth).toUTCString())
        answered = true
        assert.ok(Math.abs(clock.now() - truth) < 1500, where(step, `после ответа сервера время разошлось с настоящим на ${clock.now() - truth} мс`))
        assert.ok(Math.abs(clock.lic() - truth) < 1500, where(step, 'срок считается не от времени сервера'))
        assert.equal(clock.doubtful(), false, where(step, 'сервер ответил, а подсказка про часы осталась'))
        assert.equal(clock.unverified(), false, where(step, 'сервер ответил, а время считается несверенным'))
      } else {
        // Программу закрыли (или погас свет — тогда последняя запись могла не успеть)
        if (event === 'restart' || rnd.next() < 0.7) clock.persist()
        saved = f.saved()
        const off = event === 'restart' ? rnd.int(10_000, 2 * HOUR_MS) : rnd.int(60_000, 3 * DAY_MS)
        truth += off
        if (event === 'boot' && kind === 'battery') f.t.wall = BIOS + rnd.int(30_000, 300_000)
        else f.t.wall += off
        if (event === 'boot' && kind === 'hands' && rnd.next() < 0.5) f.t.wall += rnd.pick([-1, 1]) * rnd.pick([HOUR_MS, DAY_MS, 40 * DAY_MS])
        clock = createClock(f.opts(saved))
        // После запуска — не раньше того, что было записано на диск
        if (saved) {
          assert.ok(clock.floor() >= saved.seen, where(step, '«верное» время после запуска раньше записанного'))
          assert.ok(clock.lic() >= saved.lic, where(step, 'срок работы без связи после запуска вернулся назад'))
        }
        assert.ok(clock.now() >= clock.floor(), where(step, 'показанное время раньше «верного»'))
        continue
      }
      if (!answered) {
        assert.ok(clock.floor() >= floorWas, where(step, `«верное» время пошло назад после «${event}»`))
        assert.ok(clock.lic() >= licWas, where(step, `срок работы без связи вернулся назад после «${event}»`))
      }
      assert.ok(clock.now() >= clock.floor(), where(step, 'показанное время раньше «верного»'))
      // Исправный компьютер: время программы — настоящее, и срок идёт по нему же
      if (kind === 'honest') {
        assert.ok(Math.abs(clock.now() - truth) < 1500, where(step, `время на исправном компьютере разошлось с настоящим на ${clock.now() - truth} мс`))
        assert.ok(Math.abs(clock.lic() - truth) < 1500, where(step, 'срок на исправном компьютере идёт не по настоящему времени'))
        assert.equal(clock.doubtful(), false, where(step, 'подсказка про часы на исправном компьютере'))
      }
    }
  }
})

test('срок без связи: севшая батарейка и ни одного ответа сервера — срок кончается тогда же, когда кончился бы по настоящему времени', () => {
  // Каким бы ни был рабочий день (в том числе круглосуточным) и как бы часто ни
  // отключали свет: срок не должен ни растягиваться, ни сгорать раньше времени
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = dice(seed)
    const hours = rnd.pick([8, 10, 12, 14, 16, 24]) // рабочий день этого магазина
    const f = fakeTime(OCT4)
    let clock = usualDays(f, hours, rnd.int(5, 12))
    const from = clock.lic()
    let real = 0
    for (let day = 0; day < 10; day++) {
      // День идёт в несколько приёмов: свет мигает от нуля до трёх раз, каждый раз на минуты
      let left = hours * HOUR_MS
      for (let cut = rnd.int(0, 3); cut > 0 && left > 2 * HOUR_MS; cut--) {
        const part = rnd.int(HOUR_MS, left - HOUR_MS)
        f.pass(part)
        left -= part
        clock = deadBoot(f, clock)
        real += part + rnd.int(60_000, 10 * 60_000)
      }
      f.pass(left)
      clock = deadBoot(f, clock)
      real += left + (24 - hours) * HOUR_MS
    }
    const used = (clock.lic() - from) / DAY_MS
    const days = real / DAY_MS
    assert.ok(used >= days * 0.93 && used <= days * 1.07, `зерно ${seed}, день по ${hours} ч: за ${days.toFixed(2)} настоящих суток срок уменьшился на ${used.toFixed(2)}`)
  }
})
