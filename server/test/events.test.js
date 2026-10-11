// Какие разделы устаревают после запроса. Ошибка здесь тихая: устройство просто
// не узнает об изменении и покажет старые данные до фонового опроса.
const test = require('node:test')
const assert = require('node:assert/strict')
const { collectionsFor } = require('../dist/events/change-events.interceptor')

test('чтение никого не трогает', () => {
  assert.deepEqual(collectionsFor('GET', '/api/products'), [])
  assert.deepEqual(collectionsFor('GET', '/api/sales?days=60'), [])
})

test('продажа задевает чеки, склад и долги', () => {
  assert.deepEqual(collectionsFor('POST', '/api/sales'), ['sales', 'products', 'customers'])
})

test('приход задевает поставки, склад и долг поставщика', () => {
  assert.deepEqual(collectionsFor('POST', '/api/arrivals'), ['arrivals', 'products', 'suppliers'])
})

test('деньги в смене: оплата поставщику, внесение и изъятие задевают и саму смену', () => {
  assert.deepEqual(collectionsFor('POST', '/api/suppliers/abc/pay'), ['suppliers', 'supplierPayments', 'shifts'])
  assert.deepEqual(collectionsFor('DELETE', '/api/supplier-payments/abc'), ['supplierPayments', 'suppliers', 'shifts'])
  assert.deepEqual(collectionsFor('POST', '/api/shifts/cash'), ['cashMoves', 'shifts'])
  assert.deepEqual(collectionsFor('DELETE', '/api/cash-moves/abc'), ['cashMoves', 'shifts'])
  // Открытие и закрытие смены — как раньше
  assert.deepEqual(collectionsFor('POST', '/api/shifts/open'), ['shifts', 'sales'])
  assert.deepEqual(collectionsFor('POST', '/api/pay-services'), ['payServices'])
})

test('возврат задевает возвраты, склад, чеки и долги', () => {
  assert.deepEqual(collectionsFor('POST', '/api/returns'), ['returns', 'products', 'sales', 'customers'])
})

test('пересчёт остатков задевает склад и списания', () => {
  assert.deepEqual(collectionsFor('POST', '/api/inventory/abc/apply'), ['products', 'writeoffs'])
})

test('товар: создание, правка и удаление', () => {
  assert.deepEqual(collectionsFor('POST', '/api/products'), ['products'])
  assert.deepEqual(collectionsFor('PATCH', '/api/products/abc'), ['products'])
  assert.deepEqual(collectionsFor('DELETE', '/api/products/abc'), ['products'])
})

test('погашение долга задевает клиентов и журнал платежей', () => {
  assert.deepEqual(collectionsFor('POST', '/api/customers/abc/pay'), ['customers', 'payments'])
})

test('смена задевает смены и чеки', () => {
  assert.deepEqual(collectionsFor('POST', '/api/shifts/close'), ['shifts', 'sales'])
})

test('восстановление из копии задевает всё', () => {
  const keys = collectionsFor('POST', '/api/backup/restore')
  assert.ok(keys.includes('products') && keys.includes('sales') && keys.includes('shifts'))
})

test('вход ничего не задевает', () => {
  assert.deepEqual(collectionsFor('POST', '/api/auth/login'), [])
})

test('сотрудники задевают список сотрудников', () => {
  // Раньше не задевали ничего: список сотрудников жил у своей страницы, мимо
  // общего кэша. Из-за этого заведённый на кассе сотрудник не появлялся
  // у владельца, пока тот не перезагрузит страницу.
  assert.deepEqual(collectionsFor('POST', '/api/users'), ['users'])
  assert.deepEqual(collectionsFor('DELETE', '/api/users/abc'), ['users'])
  assert.deepEqual(collectionsFor('PATCH', '/api/users/abc/password'), ['users'])
})

test('адрес с параметрами разбирается верно', () => {
  assert.deepEqual(collectionsFor('POST', '/api/sales?x=1'), ['sales', 'products', 'customers'])
})
