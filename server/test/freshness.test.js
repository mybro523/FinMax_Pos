// ── «У меня уже есть, что-нибудь изменилось?» ──
//
// Список товаров у настоящего магазина — тысячи наименований, меняется он раз в день,
// а забирался заново при каждом обновлении экрана. Теперь браузер присылает отметку
// прошлого ответа, и при совпадении получает пустой ответ «то же самое».
//
// Ошибка здесь тихая и обидная: браузер получит «то же самое» на изменившийся список
// и будет показывать вчерашние остатки, ничем этого не выдавая. Поэтому проверяется
// прежде всего обратное — что после любого изменения отметка перестаёт совпадать.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ChangeStamp } = require('../dist/events/change-stamp.service')
const { watchedCollection } = require('../dist/events/freshness.interceptor')

test('отметка не меняется, пока не менялись данные', () => {
  const s = new ChangeStamp()
  const a = s.tag('tenant_shifo', 'products', '/products')
  const b = s.tag('tenant_shifo', 'products', '/products')
  assert.equal(a, b)
})

test('любое изменение раздела сбивает отметку', () => {
  const s = new ChangeStamp()
  const before = s.tag('tenant_shifo', 'products', '/products')
  s.bump('tenant_shifo', ['products'])
  assert.notEqual(s.tag('tenant_shifo', 'products', '/products'), before, 'браузер покажет вчерашние остатки')
})

test('изменение в одном магазине не сбивает отметку другого', () => {
  // Иначе продажа в одном магазине заставляла бы все остальные забирать свои списки
  const s = new ChangeStamp()
  const chuzhaya = s.tag('tenant_salom', 'products', '/products')
  s.bump('tenant_shifo', ['products'])
  assert.equal(s.tag('tenant_salom', 'products', '/products'), chuzhaya)
})

test('изменение одного раздела не сбивает отметку другого', () => {
  const s = new ChangeStamp()
  const clients = s.tag('tenant_shifo', 'customers', '/customers')
  s.bump('tenant_shifo', ['products'])
  assert.equal(s.tag('tenant_shifo', 'customers', '/customers'), clients)
})

test('у разных выборок одного раздела отметки разные', () => {
  // Иначе ответ на один запрос выдавался бы за ответ на другой
  const s = new ChangeStamp()
  assert.notEqual(
    s.tag('tenant_shifo', 'products', '/products'),
    s.tag('tenant_shifo', 'products', '/products?category=Таблетки'),
  )
})

test('после перезапуска сервера старая отметка не подходит', () => {
  // Счётчик живёт в памяти и начинается заново. Без имени запуска старая отметка
  // случайно совпала бы с новой — и браузер получил бы «то же самое» после того,
  // как в базе успело измениться что угодно.
  const first = new ChangeStamp()
  const second = new ChangeStamp()
  assert.notEqual(
    first.tag('tenant_shifo', 'products', '/products'),
    second.tag('tenant_shifo', 'products', '/products'),
  )
})

// ── Какие разделы вообще так отвечают ──
test('списки, зависящие только от записи в базу, участвуют', () => {
  assert.equal(watchedCollection('GET', '/api/products'), 'products')
  assert.equal(watchedCollection('GET', '/api/products?q=пар'), 'products')
  assert.equal(watchedCollection('GET', '/api/customers'), 'customers')
  assert.equal(watchedCollection('GET', '/api/categories'), 'categories')
  assert.equal(watchedCollection('GET', '/api/users'), 'users')
})

test('журналы не участвуют — их ответ едет сам по себе', () => {
  // «Продажи за 60 дней» завтра означают уже другой отрезок, даже если в базе
  // ничего не менялось. Отметка «то же самое» была бы для них враньём.
  assert.equal(watchedCollection('GET', '/api/sales?days=60'), null)
  assert.equal(watchedCollection('GET', '/api/arrivals'), null)
  assert.equal(watchedCollection('GET', '/api/returns'), null)
  assert.equal(watchedCollection('GET', '/api/writeoffs'), null)
  assert.equal(watchedCollection('GET', '/api/shifts'), null)
})

test('запись никогда не отвечает «то же самое»', () => {
  for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    assert.equal(watchedCollection(m, '/api/products'), null, `${m} попал под отметку`)
  }
})

test('похожие адреса не путаются', () => {
  // /productsomething — не /products
  assert.equal(watchedCollection('GET', '/api/products-report'), null)
  assert.equal(watchedCollection('GET', '/api/productsomething'), null)
  assert.equal(watchedCollection('GET', '/api/products/abc'), 'products')
})
