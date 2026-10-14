// ── Фильтр ошибок: честные коды и никаких внутренностей наружу ──
//
// Отказ разбора тела (слишком большой запрос, битый JSON) — ошибка присланного
// запроса. Он обязан уходить как 4xx с понятным текстом, а не маскироваться
// под 500. И ни при какой ошибке наружу не идёт стек или сообщение изнутри.
//
// Запуск: npm test (в папке server)
const test = require('node:test')
const assert = require('node:assert/strict')
const { AllExceptionsFilter } = require('../dist/common/all-exceptions.filter')

function run(exception) {
  let code = 0
  let body = null
  const res = { status(s) { code = s; return this }, json(b) { body = b; return this } }
  const host = { switchToHttp: () => ({ getResponse: () => res }) }
  const filter = new AllExceptionsFilter()
  // тихий журнал: фильтр пишет туда стек внутренних ошибок
  filter.logger = { error() {}, warn() {}, log() {} }
  filter.catch(exception, host)
  return { code, body }
}

test('слишком большое тело → 413, а не 500', () => {
  const e = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' })
  const r = run(e)
  assert.equal(r.code, 413)
  assert.equal(r.body.message, 'Запрос слишком большой')
})

test('битый JSON → 400 с понятным текстом', () => {
  const e = Object.assign(new SyntaxError('Unexpected token'), { status: 400, type: 'entity.parse.failed' })
  const r = run(e)
  assert.equal(r.code, 400)
  assert.equal(r.body.message, 'Некорректные данные запроса')
})

test('внутренняя ошибка → 500 без стека и без сообщения изнутри', () => {
  const r = run(new Error('секретная деталь: пароль базы abc123 в строке подключения'))
  assert.equal(r.code, 500)
  assert.equal(r.body.message, 'Внутренняя ошибка сервера')
  assert.ok(!JSON.stringify(r.body).includes('abc123'), 'внутреннее сообщение утекло в ответ')
  assert.ok(!('stack' in r.body), 'стек утёк в ответ')
})

test('обычный Error с полем status, но без типа entity.* — не принимается за ошибку запроса', () => {
  // иначе любой внутренний объект со status:400 обходил бы маскировку
  const r = run(Object.assign(new Error('внутреннее'), { status: 400 }))
  assert.equal(r.code, 500)
})
