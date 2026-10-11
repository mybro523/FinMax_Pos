// ── Какие ошибки базы повтором не лечатся ──
//
// Касса присылает операции по порядку. Если сервер на какую-то отвечает «не смог,
// пришлите ещё раз», касса так и делает — и вся её очередь стоит за этой операцией.
// Для обрыва связи с базой это правильно: через минуту получится. Но если причина
// в самих данных (число не помещается в поле), не получится никогда, и очередь
// встала бы навечно, молча. Такая операция должна получить отказ — тогда владелец
// увидит её в списке «не принято сервером», а остальные пройдут.
//
// Обратная ошибка хуже: отвергнуть настоящий чек из-за минутного сбоя базы. Поэтому
// здесь стережётся граница — что считается «данные не годятся», а что нет.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')
const { isDataError } = require('../dist/sync/sync.service')

const known = (code, meta) => new Prisma.PrismaClientKnownRequestError('ошибка', { code, clientVersion: 'проверка', meta })

test('данные не помещаются в базу — повторять бессмысленно', () => {
  for (const code of ['P2000', 'P2005', 'P2006', 'P2011', 'P2019', 'P2020']) {
    assert.equal(isDataError(known(code)), true, code)
  }
  // Ошибка самого запроса к базе: число не поместилось в поле, пусто там, где нельзя
  assert.equal(isDataError(known('P2010', { code: '22003', message: 'numeric field overflow' })), true)
  assert.equal(isDataError(known('P2010', { code: '22001', message: 'value too long' })), true)
  assert.equal(isDataError(known('P2010', { code: '23502', message: 'null value in column' })), true)
  assert.equal(isDataError(new Prisma.PrismaClientValidationError('не тот вид данных', { clientVersion: 'проверка' })), true)
})

test('значение, которое не удалось даже передать базе, — тоже негодные данные', () => {
  // Дата с годом из пяти цифр: кода у такой ошибки нет, только слова
  const unknown = (text) => new Prisma.PrismaClientUnknownRequestError(text, { clientVersion: 'проверка' })
  assert.equal(isDataError(unknown('Invalid `tx.batch.create()` invocation\nCould not convert argument value Object {"$type": String("DateTime"), "value": String("+020265-12-31T19:00:00.000Z")} to ArgumentValue.')), true)
  // Прочие ошибки без кода — не про данные: повтор может пройти
  assert.equal(isDataError(unknown('Server has closed the connection.')), false)
  assert.equal(isDataError(unknown('')), false)
})

test('следы гонки — не «негодные данные»: повтор даст осмысленный ответ, а отказ потерял бы настоящий чек', () => {
  // Клиента (или сотрудника) удалили между проверкой и записью; тот же документ в ту
  // же секунду записал соседний запрос; запись, которую собирались поправить, исчезла
  for (const code of ['P2002', 'P2003', 'P2004', 'P2014', 'P2025']) {
    assert.equal(isDataError(known(code)), false, code)
  }
  for (const sqlstate of ['23503', '23505', '23P01']) {
    assert.equal(isDataError(known('P2010', { code: sqlstate })), false, sqlstate)
  }
})

test('сбой базы или связи с ней — операцию надо прислать ещё раз, а не отвергать', () => {
  // Нет свободного подключения, транзакция не успела, две операции заперли друг друга
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) {
    assert.equal(isDataError(known(code)), false, code)
  }
  // Ошибки базы не про данные: запертые операции, отмена запроса, нехватка места
  for (const sqlstate of ['40001', '40P01', '57014', '53100', '08006']) {
    assert.equal(isDataError(known('P2010', { code: sqlstate })), false, sqlstate)
  }
  assert.equal(isDataError(known('P2010')), false, 'причина неизвестна — не отвергаем')
  assert.equal(isDataError(new Error('что-то сломалось')), false)
  assert.equal(isDataError(new Prisma.PrismaClientUnknownRequestError('неизвестно что', { clientVersion: 'проверка' })), false)
  assert.equal(isDataError(null), false)
  assert.equal(isDataError(undefined), false)
})
