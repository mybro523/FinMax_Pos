// ── Подписка: когда аптека работает, а когда останавливается ──
//
// Состояние считается из даты оплаты, а не хранится: хранимое пришлось бы обновлять
// по расписанию, и в первый же день, когда задача не отработала, оно разошлось бы
// с датой. Значит вся тяжесть на этой функции — её и проверяем.
//
// ── Что изменилось и почему ──
// Сначала отключение было мягким: пять дней отсрочки, потом режим только чтения.
// Владелец сервиса решил иначе. Он назначает точный момент, вплоть до часа,
// и в этот момент работа прекращается: ни продать, ни посмотреть, ни войти.
// Отсрочка сверху сделала бы назначенное время пустым обещанием.
//
// Отсюда главное, что здесь проверяется: граница проходит по МОМЕНТУ, а не по
// концу суток. Ошибка в одну сторону — аптека отключена раньше срока и владелец
// принимает звонок разъярённого клиента. В другую — неплательщик работает лишние
// полдня, и назначенное время ничего не значит.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')

const { subscriptionOf, subscriptionMessage, addMonths, extendFrom, tjMoment } = require('../dist/admin/subscription')

const NOW = new Date('2026-09-15T07:00:00.000Z') // 12:00 в Душанбе
const paidIn = (ms) => new Date(NOW.getTime() + ms)
const DAY = 86400000
const MIN = 60000

test('оплаченная аптека работает и не тревожит зря', () => {
  const v = subscriptionOf({ paidUntil: paidIn(30 * DAY), trial: false }, NOW)
  assert.equal(v.status, 'active')
  assert.equal(v.canWrite, true)
  assert.equal(v.warn, false, 'за месяц до конца предупреждать не о чем')
  assert.equal(v.daysLeft, 30)
})

test('за несколько дней до конца появляется предупреждение, но работа не меняется', () => {
  const v = subscriptionOf({ paidUntil: paidIn(3 * DAY), trial: false }, NOW)
  assert.equal(v.status, 'active')
  assert.equal(v.canWrite, true, 'предупреждение — не запрет')
  assert.equal(v.warn, true)
})

// ── Граница ──
test('за минуту до срока аптека ещё работает', () => {
  const v = subscriptionOf({ paidUntil: paidIn(MIN), trial: false }, NOW)
  assert.equal(v.status, 'active')
  assert.equal(v.canWrite, true, 'отключить раньше назначенного — потерять клиента')
})

test('в назначенную секунду работа прекращается', () => {
  const v = subscriptionOf({ paidUntil: NOW, trial: false }, NOW)
  assert.equal(v.status, 'expired')
  assert.equal(v.canWrite, false)
})

test('через минуту после срока — то же самое, никакой отсрочки', () => {
  // Пять дней отсрочки убраны намеренно: они делали назначенное время
  // бессмысленным. Нужна отсрочка — срок ставится дальше, это одно движение.
  const v = subscriptionOf({ paidUntil: paidIn(-MIN), trial: false }, NOW)
  assert.equal(v.status, 'expired')
  assert.equal(v.canWrite, false)
})

test('через неделю после срока состояние не меняется — оно и так крайнее', () => {
  const v = subscriptionOf({ paidUntil: paidIn(-7 * DAY), trial: false }, NOW)
  assert.equal(v.status, 'expired')
  assert.equal(v.canWrite, false)
})

test('время внутри дня теперь ЗНАЧИТ — в этом вся затея', () => {
  // Раньше срок считался по календарным суткам, и «до 17:00» означало «до 23:59».
  // Теперь пять вечера — это пять вечера.
  const pyat = new Date('2026-09-15T12:00:00.000Z') // 17:00 в Душанбе
  const bez10 = new Date('2026-09-15T11:50:00.000Z') // 16:50
  const cherez10 = new Date('2026-09-15T12:10:00.000Z') // 17:10

  assert.equal(subscriptionOf({ paidUntil: pyat, trial: false }, bez10).status, 'active', 'без десяти пять — работает')
  assert.equal(subscriptionOf({ paidUntil: pyat, trial: false }, cherez10).status, 'expired', 'десять минут шестого — стоп')
})

test('приостановка вручную сильнее любого срока', () => {
  const v = subscriptionOf({ paidUntil: paidIn(300 * DAY), trial: false, blocked: true }, NOW)
  assert.equal(v.status, 'suspended')
  assert.equal(v.canWrite, false, 'оплаченная, но приостановленная работать не должна')
})

// ── Пробный период ──
test('пробный период предупреждает всегда — он на то и пробный', () => {
  const v = subscriptionOf({ paidUntil: paidIn(10 * DAY), trial: true }, NOW)
  assert.equal(v.status, 'trial')
  assert.equal(v.canWrite, true)
  assert.equal(v.warn, true)
})

test('кончившийся пробный останавливает работу так же, как неоплата', () => {
  const v = subscriptionOf({ paidUntil: paidIn(-MIN), trial: true }, NOW)
  assert.equal(v.status, 'expired')
  assert.equal(v.canWrite, false)
})

// ── Сколько осталось ──
test('дни округляются вверх — пока идёт последний день, он ещё есть', () => {
  // «Осталось 0 дней» у работающей аптеки выглядит как ошибка счёта
  assert.equal(subscriptionOf({ paidUntil: paidIn(1), trial: false }, NOW).daysLeft, 1, 'миллисекунда — уже день')
  assert.equal(subscriptionOf({ paidUntil: paidIn(DAY), trial: false }, NOW).daysLeft, 1)
  assert.equal(subscriptionOf({ paidUntil: paidIn(DAY + 1), trial: false }, NOW).daysLeft, 2)
})

test('до момента отключения известно с точностью до миллисекунды', () => {
  // По этому числу ставится будильник. Ошибка здесь — отключение не вовремя.
  const v = subscriptionOf({ paidUntil: paidIn(37 * MIN), trial: false }, NOW)
  assert.equal(v.leftMs, 37 * MIN)
})

// ── Сообщения человеку ──
test('сообщение объясняет причину и не выглядит поломкой', () => {
  const expired = subscriptionMessage(subscriptionOf({ paidUntil: paidIn(-DAY), trial: false }, NOW), 'Шифо')
  assert.match(expired, /Подписка закончилась/)
  assert.match(expired, /данные аптеки сохранены/i, 'человек должен знать, что не потерял свою аптеку')
  assert.match(expired, /поставщику программы/, 'и что делать дальше')

  const stopped = subscriptionMessage(subscriptionOf({ paidUntil: paidIn(DAY), trial: false, blocked: true }, NOW))
  assert.match(stopped, /приостановлена/)

  const fine = subscriptionMessage(subscriptionOf({ paidUntil: paidIn(90 * DAY), trial: false }, NOW))
  assert.equal(fine, '', 'когда всё в порядке, человека не трогаем')
})

test('в сообщении назван час по Душанбе, а не по серверу', () => {
  // Сервер живёт по всемирному времени. Назвать клиенту не тот час — значит
  // поссориться на пустом месте: спорить он будет именно про час.
  const v = subscriptionOf({ paidUntil: new Date('2026-08-23T12:00:00.000Z'), trial: false }, NOW)
  const msg = subscriptionMessage(v)
  assert.match(msg, /23\.08\.2026 в 17:00/, `в сообщении не тот момент: ${msg}`)
})

test('момент по-душанбински читается как человек его назначал', () => {
  assert.equal(tjMoment('2026-08-23T12:00:00.000Z'), '23.08.2026 в 17:00')
  assert.equal(tjMoment('2026-01-01T19:00:00.000Z'), '02.01.2026 в 00:00', 'полночь следующих суток')
})

// ── Продление ──
test('продление считает календарные месяцы, а не тридцать дней', () => {
  // «Плюс тридцать дней» за год набирает почти неделю в пользу клиента
  assert.equal(addMonths(new Date('2026-01-15T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-15')
  assert.equal(addMonths(new Date('2026-01-15T00:00:00Z'), 12).toISOString().slice(0, 10), '2027-01-15')
})

test('продление сохраняет назначенный час', () => {
  // Иначе указанное владельцем «до 17:00» превращалось бы при первом же продлении
  // в полночь, и вся затея с точным временем рассыпалась
  const at17 = new Date('2026-01-15T12:00:00.000Z')
  assert.equal(addMonths(at17, 1).toISOString(), '2026-02-15T12:00:00.000Z')
})

test('тридцать первое плюс месяц не перескакивает через месяц', () => {
  assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28')
})

test('продлевают от конца оплаты, а просроченным — от сегодня', () => {
  const future = new Date(NOW.getTime() + 10 * DAY)
  assert.equal(extendFrom(future, NOW).getTime(), future.getTime(), 'оплаченное не сгорает')

  const past = new Date(NOW.getTime() - 40 * DAY)
  assert.equal(extendFrom(past, NOW).getTime(), NOW.getTime(), 'платить за месяцы простоя клиент не должен')
})

// ── Сколько дней касса работает без связи ──

test('срок работы кассы без связи: неделя по умолчанию, границы — от дня до месяца', () => {
  const { offlineDaysOf } = require('../dist/admin/subscription')
  assert.equal(offlineDaysOf({ offlineDays: 7 }), 7)
  assert.equal(offlineDaysOf({ offlineDays: 14 }), 14)
  // Аптека, заведённая до появления настройки, и прочее «не задано» — неделя
  assert.equal(offlineDaysOf({}), 7)
  assert.equal(offlineDaysOf({ offlineDays: null }), 7)
  assert.equal(offlineDaysOf(null), 7)
  // Ноль запретил бы работу без интернета вовсе; год сделал бы проверку формальностью
  assert.equal(offlineDaysOf({ offlineDays: 0 }), 7)
  assert.equal(offlineDaysOf({ offlineDays: -3 }), 7)
  assert.equal(offlineDaysOf({ offlineDays: 365 }), 30)
  assert.equal(offlineDaysOf({ offlineDays: 2.9 }), 2)
})
