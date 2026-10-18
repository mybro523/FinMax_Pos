// ── Возврат товара поставщику ──
//
// Правила, которые нельзя нарушить молча:
//   • возврат, оформленный в программе без связи, разбирается поле за полем: без
//     поставщика, с непонятным способом возврата денег или с пустой строкой — отказ;
//   • право на него своё — «Приход товара: возврат поставщику», и на сайте, и в программе;
//   • после возврата устаревают журнал возвратов, склад, долги поставщиков и смена;
//   • в строке возврата остаются партии, из которых ушёл товар: удалили возврат —
//     товар вернётся в такие же партии, со своими сроками и ценами.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')

const { parseSupplierReturn, Reject, FOUNDER_ONLY } = require('../dist/sync/payload')
const { OP_PERMISSIONS, ALL_PERMISSIONS, CASHIER_DEFAULT, ROLE_PRESETS } = require('../dist/auth/permissions')
const { collectionsFor } = require('../dist/events/change-events.interceptor')
const { batchesOf } = require('../dist/supplier-returns/supplier-returns.service')
const { REFUNDS } = require('../dist/supplier-returns/dto')

const NOW = Date.parse('2026-10-18T09:00:00Z')
const AT = '2026-10-18T08:00:00.000Z'
const op = (over = {}, item = {}) => ({
  ret: {
    id: 'ret-1',
    date: AT,
    supplierId: 'cmsupplier1',
    supplier: 'ООО Фарм',
    refund: 'debt',
    shiftId: null,
    note: 'просрочка',
    total: 120,
    items: [{ id: 'ret-1-a', productId: 'cmproduct1', name: 'Нурофен', qty: 1, pieces: 2, price: 100, ...item }],
    ...over,
  },
})
const rejected = (fn, re) => assert.throws(fn, (e) => e instanceof Reject && (!re || re.test(e.message)), 'ожидался отказ по существу')

test('возврат из программы разбирается поле за полем', () => {
  const r = parseSupplierReturn(op(), NOW)
  assert.equal(r.id, 'ret-1')
  assert.equal(r.date.toISOString(), AT)
  assert.equal(r.supplierId, 'cmsupplier1')
  assert.equal(r.supplier, 'ООО Фарм')
  assert.equal(r.refund, 'debt')
  assert.equal(r.shiftId, null)
  assert.equal(r.note, 'просрочка')
  assert.equal(r.total, 120)
  assert.deepEqual(r.items, [{ id: 'ret-1-a', productId: 'cmproduct1', name: 'Нурофен', qty: 1, pieces: 2, price: 100 }])
})

test('возврат из программы: необязательное — по умолчанию', () => {
  const r = parseSupplierReturn(op({ supplier: undefined, note: undefined, shiftId: undefined }, { pieces: undefined }), NOW)
  assert.equal(r.supplier, '—')
  assert.equal(r.note, '')
  assert.equal(r.shiftId, null)
  assert.equal(r.items[0].pieces, 0)
  // Только штуки, без целой упаковки, — тоже возврат: «2 таблетки из пачки»
  assert.equal(parseSupplierReturn(op({}, { qty: 0, pieces: 2 }), NOW).items[0].qty, 0)
})

test('возврат из программы: каждый из четырёх способов вернуть деньги', () => {
  for (const refund of ['debt', 'cash', 'own', 'card']) assert.equal(parseSupplierReturn(op({ refund, shiftId: refund === 'cash' ? 'cmshift1' : null }), NOW).refund, refund)
  assert.deepEqual([...REFUNDS], ['debt', 'cash', 'own', 'card'])
})

test('возврат из программы: мусор отвергается, а не записывается', () => {
  rejected(() => parseSupplierReturn(op({ supplierId: null }), NOW), /без поставщика/)
  rejected(() => parseSupplierReturn(op({ supplierId: '' }), NOW), /без поставщика/)
  rejected(() => parseSupplierReturn(op({ refund: 'barter' }), NOW), /как вернули деньги/)
  rejected(() => parseSupplierReturn(op({ refund: undefined }), NOW), /как вернули деньги/)
  rejected(() => parseSupplierReturn(op({}, { qty: 0, pieces: 0 }), NOW), /Пустая позиция/)
  rejected(() => parseSupplierReturn(op({}, { qty: -1 }), NOW), /упаковки/)
  rejected(() => parseSupplierReturn(op({}, { qty: 1.5 }), NOW), /упаковки/)
  rejected(() => parseSupplierReturn(op({}, { price: -5 }), NOW), /цена возврата/)
  rejected(() => parseSupplierReturn(op({ total: 'много' }), NOW), /сумма возврата/)
  rejected(() => parseSupplierReturn(op({ items: [] }), NOW), /позиции возврата/)
  rejected(() => parseSupplierReturn(op({ date: 'вчера' }), NOW), /дата/i)
  // Часы кассы убежали вперёд — возврат записывается нынешним моментом, как любая операция кассы
  assert.equal(parseSupplierReturn(op({ date: '2026-10-25T08:00:00.000Z' }), NOW).date.getTime(), NOW)
  rejected(() => parseSupplierReturn(op({ id: 'не номер' }), NOW))
  rejected(() => parseSupplierReturn({}, NOW))
})

test('право на возврат поставщику — своё, и в программе то же, что на сайте', () => {
  assert.ok(ALL_PERMISSIONS.includes('arrivals.return'))
  assert.deepEqual(OP_PERMISSIONS['supplier.return'], ['arrivals.return'])
  // Не только владельцу: возврат оформляет и сотрудник с этим правом
  assert.equal(FOUNDER_ONLY.has('supplier.return'), false)
  // Кассиру по умолчанию не дано: товар со склада и деньги поставщика — решение владельца
  assert.equal(CASHIER_DEFAULT.includes('arrivals.return'), false)
  // Заготовка «Заведующий» получает его вместе с остальным складом, «Наблюдатель» — нет
  const preset = (name) => ROLE_PRESETS.find((r) => r.name === name).permissions
  assert.ok(preset('Заведующий').includes('arrivals.return'))
  assert.equal(preset('Наблюдатель').includes('arrivals.return'), false)
})

test('после возврата устаревают журнал, склад, долги поставщиков и смена', () => {
  const keys = ['supplierReturns', 'products', 'suppliers', 'shifts']
  assert.deepEqual(collectionsFor('POST', '/api/supplier-returns'), keys)
  assert.deepEqual(collectionsFor('DELETE', '/api/supplier-returns/abc'), keys)
  assert.deepEqual(collectionsFor('GET', '/api/supplier-returns?days=30'), [])
})

test('партии, из которых ушёл товар, остаются в строке возврата', () => {
  const taken = [
    { units: 3, cost: new Prisma.Decimal('12.5'), expiryDate: new Date('2026-11-01T00:00:00.000Z') },
    { units: 2, cost: new Prisma.Decimal('13'), expiryDate: null },
  ]
  assert.deepEqual(batchesOf(taken), [
    { units: 3, cost: '12.5', expiryDate: '2026-11-01T00:00:00.000Z' },
    { units: 2, cost: '13', expiryDate: null },
  ])
  assert.deepEqual(batchesOf([]), [])
})
