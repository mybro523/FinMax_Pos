// Тесты защиты входа от подбора пароля. Запуск: npm test (в папке server).
// Проверяем собранный код из dist — ровно то, что уходит на сервер.
const test = require('node:test')
const assert = require('node:assert/strict')
const { LoginThrottle } = require('../dist/auth/throttle')

const T0 = 1_700_000_000_000
const MIN = 60_000

// Три неудачи допустимо, блокировка на 10 минут, окно 5 минут
const make = () => new LoginThrottle({ limit: 3, windowMs: 5 * MIN, blockMs: 10 * MIN })

test('пока попыток мало, вход открыт', () => {
  const t = make()
  t.fail('имя:kassir', T0)
  t.fail('имя:kassir', T0 + 1000)
  assert.equal(t.retryAfterMs('имя:kassir', T0 + 2000), 0)
})

test('после лимита вход закрывается', () => {
  const t = make()
  for (let i = 0; i < 3; i++) t.fail('имя:kassir', T0 + i * 1000)
  const wait = t.retryAfterMs('имя:kassir', T0 + 3000)
  assert.ok(wait > 0, 'вход должен быть закрыт')
  assert.ok(wait <= 10 * MIN, 'ждать не дольше срока блокировки')
})

test('блокировка отпускает по истечении срока', () => {
  const t = make()
  for (let i = 0; i < 3; i++) t.fail('имя:kassir', T0)
  assert.ok(t.retryAfterMs('имя:kassir', T0 + 9 * MIN) > 0, 'через 9 минут ещё закрыто')
  assert.equal(t.retryAfterMs('имя:kassir', T0 + 11 * MIN), 0, 'через 11 минут открыто')
})

test('редкие опечатки не копятся — окно истекает', () => {
  const t = make()
  // Кассир ошибается раз в час: блокировки быть не должно никогда
  for (let h = 0; h < 10; h++) t.fail('имя:kassir', T0 + h * 60 * MIN)
  assert.equal(t.retryAfterMs('имя:kassir', T0 + 10 * 60 * MIN + 1000), 0)
})

test('успешный вход обнуляет счётчик', () => {
  const t = make()
  t.fail('имя:kassir', T0)
  t.fail('имя:kassir', T0 + 1000)
  t.success(['имя:kassir'])
  t.fail('имя:kassir', T0 + 2000)
  t.fail('имя:kassir', T0 + 3000)
  assert.equal(t.retryAfterMs('имя:kassir', T0 + 4000), 0, 'счёт пошёл заново')
})

test('имя и адрес считаются раздельно', () => {
  const t = make()
  for (let i = 0; i < 3; i++) t.fail('имя:kassir', T0)
  assert.ok(t.retryAfterMs('имя:kassir', T0) > 0, 'имя заблокировано')
  assert.equal(t.retryAfterMs('адрес:1.2.3.4', T0), 0, 'чужой адрес ни при чём')
})

test('перебор имён с одного адреса тоже упирается в блокировку', () => {
  const t = make()
  const ip = 'адрес:5.6.7.8'
  // Подбираем разные имена — счётчик по имени не срабатывает, а по адресу да
  t.failMany(['имя:a', ip], T0)
  t.failMany(['имя:b', ip], T0 + 100)
  t.failMany(['имя:c', ip], T0 + 200)
  assert.equal(t.retryAfterMs('имя:a', T0 + 300), 0, 'по каждому имени всего одна неудача')
  assert.ok(t.retryAfterMs(ip, T0 + 300) > 0, 'адрес заблокирован')
})

test('проверка по нескольким ключам берёт наибольшее ожидание', () => {
  const t = make()
  for (let i = 0; i < 3; i++) t.fail('адрес:9.9.9.9', T0)
  const wait = t.retryAfterAny(['имя:novyi', 'адрес:9.9.9.9'], T0)
  assert.ok(wait > 0, 'закрыто хотя бы по одному ключу — значит закрыто')
})

test('без адреса (локальный запуск) работает по имени', () => {
  const t = make()
  for (let i = 0; i < 3; i++) t.failMany(['имя:kassir'], T0)
  assert.ok(t.retryAfterAny(['имя:kassir'], T0) > 0)
})

test('срок ожидания понятен человеку', () => {
  assert.equal(LoginThrottle.humanWait(30_000), '30 сек.')
  assert.equal(LoginThrottle.humanWait(90_000), '2 мин.')
  assert.equal(LoginThrottle.humanWait(10 * MIN), '10 мин.')
})

test('массовый перебор не съедает память', () => {
  const t = new LoginThrottle({ limit: 3, windowMs: MIN, blockMs: MIN, maxKeys: 200 })
  for (let i = 0; i < 5000; i++) t.fail('адрес:10.0.' + (i >> 8) + '.' + (i & 255), T0 + i)
  // Внутренняя карта чистится сама; проверяем, что вход при этом не сломался
  assert.equal(typeof t.retryAfterMs('адрес:10.0.0.1', T0), 'number')
})

// ── Дыра, которую нашёл живой человек ──
// Пять раз промахнулся под «admin» — вход под этим именем закрыт. А под соседним
// именем пробуй сколько хочешь: строгий счёт был только по имени, а по устройству
// стоял мягкий порог в тридцать попыток. Имена здесь угадываются легко — логин
// обычно совпадает с кодом аптеки, — так что защита обходилась сменой одной буквы.
//
// Так система и работала на живом сервере, и ни одна проверка этого не видела:
// каждая смотрела на свой счётчик по отдельности.

// Как в бою: пять промахов, ступени минута → пять → пятнадцать
const boyevoy = () => new LoginThrottle({ limit: 5 })

test('перебор разными именами с одного устройства упирается в блокировку', () => {
  const t = boyevoy()
  const ip = 'адрес:5.5.5.5'
  // Пять попыток пятью РАЗНЫМИ именами — как если бы подбирали вслепую
  for (const name of ['admin', 'aptek1', 'shifo', 'kassir', 'salik']) {
    t.failMany([`имя:${name}`, ip], T0)
  }
  // Ни одно имя лимита не набрало — но устройство набрало
  assert.equal(t.retryAfterMs('имя:admin', T0), 0, 'по одному имени блокировать нечего')
  assert.ok(t.retryAfterMs(ip, T0) > 0, 'смена имени по-прежнему обходит защиту')

  // И шестое имя тоже не пустят
  assert.ok(t.retryAfterAny(['имя:sovsem-drugoy', ip], T0) > 0, 'новое имя всё ещё пускают')
})

// ── Ступени ──
test('первая блокировка короткая, каждая следующая дороже', () => {
  const t = boyevoy()
  const ip = 'адрес:7.7.7.7'
  const seriya = (at) => {
    for (let i = 0; i < 5; i++) t.fail(ip, at + i)
    return t.retryAfterMs(ip, at + 5)
  }

  const first = seriya(T0)
  assert.ok(first > 0 && first <= MIN, `первая блокировка ${first} мс — должна быть около минуты`)

  // Дождались, промахнулись ещё пять раз
  const second = seriya(T0 + 2 * MIN)
  assert.ok(second > MIN && second <= 5 * MIN, `вторая блокировка ${second} мс — должна быть около пяти минут`)

  const third = seriya(T0 + 10 * MIN)
  assert.ok(third > 5 * MIN && third <= 15 * MIN, `третья блокировка ${third} мс — должна быть около пятнадцати минут`)

  // Дальше не растёт бесконечно — пятнадцать минут и хватит
  const fourth = seriya(T0 + 30 * MIN)
  assert.ok(fourth > 5 * MIN && fourth <= 15 * MIN, `четвёртая блокировка ${fourth} мс — потолок пятнадцать минут`)
})

test('забывчивый кассир не наказан на четверть часа', () => {
  // Он ошибся пять раз, подождал минуту и вспомнил пароль. Ступенька вырасти
  // не должна: иначе за смену он дошёл бы до пятнадцати минут на ровном месте.
  const t = boyevoy()
  const ip = 'адрес:8.8.8.8'
  for (let i = 0; i < 5; i++) t.fail(ip, T0 + i)
  assert.ok(t.retryAfterMs(ip, T0 + 10) > 0)

  // Минуту спустя вход открыт
  assert.equal(t.retryAfterMs(ip, T0 + MIN + 1000), 0, 'ждать пришлось дольше минуты')

  // Вошёл — и всё забыто, включая ступеньку
  t.success([ip])
  for (let i = 0; i < 5; i++) t.fail(ip, T0 + 10 * MIN + i)
  const again = t.retryAfterMs(ip, T0 + 10 * MIN + 10)
  assert.ok(again <= MIN, `после успешного входа ступенька осталась: ${again} мс`)
})

test('промахи забываются, если человек долго ничего не путал', () => {
  // Иначе одна опечатка утром и одна вечером за месяц довели бы кассира
  // до постоянной блокировки
  const t = boyevoy()
  const ip = 'адрес:1.2.3.4'
  for (let i = 0; i < 4; i++) t.fail(ip, T0 + i * 20 * MIN) // раз в двадцать минут
  assert.equal(t.retryAfterMs(ip, T0 + 80 * MIN), 0, 'редкие опечатки накопились в блокировку')
})

test('ступенька переживает снятие блокировки', () => {
  // Если после первой блокировки счётчик обнуляется полностью, то перебор идёт
  // вечно по пять попыток в минуту — и защита превращается в лёгкую задержку
  const t = boyevoy()
  const ip = 'адрес:6.6.6.6'
  for (let i = 0; i < 5; i++) t.fail(ip, T0 + i)
  // Блокировка отпустила, счётчик спрашивали много раз — запись не должна пропасть
  for (let i = 0; i < 10; i++) t.retryAfterMs(ip, T0 + 2 * MIN + i)
  for (let i = 0; i < 5; i++) t.fail(ip, T0 + 3 * MIN + i)
  assert.ok(t.retryAfterMs(ip, T0 + 3 * MIN + 10) > MIN, 'вторая блокировка не стала длиннее первой')
})
