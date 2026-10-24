// ── Справочники без интернета: товары, категории, типы, сервисы, статьи, поставщики ──
//
// С версии 1.4.14 касса заводит и правит справочники сама, без связи. Сделанное лежит
// поправкой поверх данных сервера и уходит на сервер, когда появится связь. Самое
// тонкое здесь — три состояния, в каждом из которых правка не должна ни потеряться,
// ни задвоиться:
//   • пока операция ждёт отправки, а с сервера пришли свежие данные (без неё);
//   • сервер принял — следующие данные придут уже с ней;
//   • сервер отверг — строка возвращается к прежнему виду.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { categoriesList, productsList, productTypesList } from '../src/local/catalog.mjs'
import { expenseCategoriesList } from '../src/local/ops/expense.mjs'
import { incomeCategoriesList } from '../src/local/ops/income.mjs'
import { openShift, shiftView } from '../src/local/ops/shift.mjs'
import { listShifts, listDocs } from '../src/local/docs.mjs'
import { BARCODE_TAKEN, createProduct, deleteProduct, updateProduct } from '../src/local/ops/products.mjs'
import {
  CATEGORY_EXISTS,
  categoryInUse,
  createArticle,
  createCategory,
  createPayService,
  createProductType,
  deleteArticle,
  deleteCategory,
  deletePayService,
  deleteProductType,
  typeInUse,
  updateCategory,
  updateProductType,
} from '../src/local/ops/refs.mjs'
import {
  createSupplier,
  deleteSupplier,
  paySupplier,
  PAYMENT_SHIFT_CLOSED,
  removeSupplierPayment,
  SUPPLIER_EXISTS,
  SUPPLIER_HAS_DEBT,
  updateSupplier,
} from '../src/local/ops/supplierops.mjs'
import { ackOp, describeOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { payServicesList, suppliersDebts, suppliersList } from '../src/local/suppliers.mjs'
import { closeShift } from '../src/local/ops/shift.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { rebuildStock } from '../src/local/stock.mjs'
import { ctx, day, NOW, pharmacy, product, refused, row, SUPPLIERS } from '../test-support/pharmacy.mjs'

const shop = (snap = {}) =>
  pharmacy({
    products: [
      product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10, category: 'Таблетки' }),
      product({ id: 'bint', name: 'Бинт', barcode: '4600000000024', cost: 50, price: 80, stock: 4, unitsPerPack: 10, looseUnits: 5, category: 'Перевязка', expiryDate: null }),
    ],
    productTypes: [{ id: 'type-1', name: 'Лекарство', analogs: true, createdAt: '2026-09-01T08:00:00.000Z' }],
    ...snap,
  })
const ops = (db) => pendingOps(db, 100)
const lastOp = (db) => ops(db).at(-1)
const up = (...list) => ({ upsert: list, remove: [] })
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
const full = (db, data) => applyPull(db, { full: true, cursor: '200', data: { products: up(), sales: up(), ...data } }, { now: NOW })
const prod = (db, id) => productsList(db, NOW).find((p) => p.id === id)
const ok = (db, op, docId) => ackOp(db, op, { status: 'ok', docId: docId === undefined ? op.payload?.id ?? op.payload?.product?.id ?? null : docId })

// ════════════════════════ Товары ════════════════════════

test('товар заводится без связи: карточка, остаток партией, операция — как у сервера', () => {
  const db = shop()
  const p = createProduct(ctx(db), { name: 'Анальгин', barcode: '4600000000031', category: 'Таблетки', cost: 20, price: 30, stock: 3, unit: 'уп', unitsPerPack: 10, looseUnits: 4, expiryDate: '2027-05-31', minStock: 2 })
  assert.deepEqual(
    [p.name, p.barcode, p.category, p.cost, p.price, p.stock, p.looseUnits, p.unitsPerPack, p.minStock, String(p.expiryDate).slice(0, 10)],
    ['Анальгин', '4600000000031', 'Таблетки', 20, 30, 3, 4, 10, 2, '2027-05-31'],
  )
  // По алфавиту — как у сервера
  assert.deepEqual(productsList(db, NOW).map((x) => x.name), ['Анальгин', 'Бинт', 'Нурофен'])
  const op = lastOp(db)
  assert.equal(op.type, 'product.create')
  assert.deepEqual(op.payload.product, {
    id: p.id, name: 'Анальгин', barcode: '4600000000031', category: 'Таблетки', type: '', cost: 20, price: 30, minStock: 2, unit: 'уп', unitsPerPack: 10,
    dosage: '', analogIds: [], image: '', stock: 3, looseUnits: 4, expiryDate: day('2027-05-31'), createdAt: new Date(NOW).toISOString(),
  })
  // Штрихкод занят — отказ тем же текстом, что у сервера
  refused(() => createProduct(ctx(db), { name: 'Дубль', barcode: '4600000000017' }), 409, BARCODE_TAKEN)
  refused(() => createProduct(ctx(db), { name: '  ', barcode: '1' }), 400, 'Укажите название товара')
})

test('заведённый без связи товар переживает свежие данные сервера, а после приёма — не задваивается', () => {
  const db = shop()
  const p = createProduct(ctx(db), { name: 'Анальгин', barcode: '4600000000031', cost: 20, price: 30, stock: 5 })
  // Сервер прислал весь магазин заново — нового товара у него ещё нет
  full(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', stock: 9 })) })
  assert.deepEqual(productsList(db, NOW).map((x) => [x.name, x.stock]), [['Анальгин', 5], ['Нурофен', 9]])
  // И им можно продать: товар и его остаток на месте
  const op = ops(db).find((o) => o.type === 'product.create')
  ok(db, op, p.id)
  // Сервер принял и прислал товар своей копией
  delta(db, { products: up(product({ id: p.id, name: 'Анальгин', barcode: '4600000000031', cost: 20, price: 30, stock: 5 })), batches: up({ id: 'b1', productId: p.id, units: 5, cost: 20, expiryDate: null, arrivalId: null, createdAt: '2026-10-04T10:00:00.000Z' }) })
  assert.deepEqual(productsList(db, NOW).filter((x) => x.name === 'Анальгин').map((x) => x.stock), [5])
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM row_edits WHERE synced = 0').n, 0)
})

test('сервер отверг заведение товара — его нет и на кассе', () => {
  const db = shop()
  const p = createProduct(ctx(db), { name: 'Анальгин', barcode: '4600000000031', stock: 2 })
  rejectOp(db, lastOp(db), 'Недостаточно прав')
  assert.equal(prod(db, p.id), undefined)
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM row_edits WHERE synced = 0').n, 0)
})

test('правка карточки: на сервер уходит только поменянное и то, что было у кассы; правка переживает свежие данные', () => {
  const db = shop()
  const before = prod(db, 'nur')
  // Окно присылает форму целиком
  updateProduct(ctx(db), 'nur', { ...before, price: 170, name: 'Нурофен форте', expiryDate: String(before.expiryDate).slice(0, 10) })
  const op = lastOp(db)
  assert.equal(op.type, 'product.update')
  assert.deepEqual(op.payload.set, { name: 'Нурофен форте', price: 170 })
  assert.deepEqual(op.payload.base, { name: 'Нурофен', price: 150 })
  assert.equal(op.payload.stock, null)
  assert.equal('expiryDate' in op.payload, false, 'срок не меняли — его в операции нет')
  assert.deepEqual([prod(db, 'nur').name, prod(db, 'nur').price], ['Нурофен форте', 170])
  // С сервера пришла старая карточка (он о правке ещё не знает) — правка остаётся
  delta(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10, category: 'Таблетки' })) })
  assert.deepEqual([prod(db, 'nur').name, prod(db, 'nur').price], ['Нурофен форте', 170])
  // Ничего не поменяли — операции нет
  const n = ops(db).length
  updateProduct(ctx(db), 'nur', { ...prod(db, 'nur'), expiryDate: String(before.expiryDate).slice(0, 10) })
  assert.equal(ops(db).length, n)
  // Сервер отверг — карточка прежняя
  rejectOp(db, op, 'Недостаточно прав')
  assert.deepEqual([prod(db, 'nur').name, prod(db, 'nur').price], ['Нурофен', 150])
})

test('закупочная цена из карточки — основа средней цены: приход без связи считает от неё', () => {
  const db = shop()
  updateProduct(ctx(db), 'nur', { cost: 120 })
  assert.equal(prod(db, 'nur').cost, 120)
  assert.deepEqual(lastOp(db).payload.set, { cost: 120 })
  // После свежих данных сервера (со старой ценой) правка остаётся
  delta(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10 })) })
  assert.equal(prod(db, 'nur').cost, 120)
})

test('остаток, вписанный в карточку, — пересчёт: на кассе сразу, серверу — число и «вписали руками»', () => {
  const db = shop()
  updateProduct(ctx(db), 'nur', { stock: 7 })
  assert.equal(prod(db, 'nur').stock, 7)
  const op = lastOp(db)
  assert.deepEqual(op.payload.stock, { units: 7, explicit: true })
  // Свежий остаток сервера (он о правке не знает) — правка ложится поверх разницей
  delta(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10 })) })
  assert.equal(prod(db, 'nur').stock, 7)
  // Больше прежнего — излишек в партию с самым дальним сроком
  updateProduct(ctx(db), 'nur', { stock: 12 })
  assert.equal(prod(db, 'nur').stock, 12)
  // Штук в упаковке стало больше, упаковок столько же — остаток в штуках другой (как у сервера)
  updateProduct(ctx(db), 'bint', { unitsPerPack: 20 })
  const b = prod(db, 'bint')
  assert.deepEqual([b.stock, b.looseUnits, b.unitsPerPack], [4, 5, 20])
  assert.deepEqual(lastOp(db).payload.stock, { units: 85, explicit: false })
})

test('срок годности из карточки — у единственной партии', () => {
  const db = shop()
  updateProduct(ctx(db), 'nur', { expiryDate: '2028-03-31' })
  assert.equal(String(prod(db, 'nur').expiryDate).slice(0, 10), '2028-03-31')
  assert.equal(lastOp(db).payload.expiryDate, day('2028-03-31'))
})

test('удаление товара: сразу на кассе, свежие данные сервера его не возвращают, отказ — возвращает', () => {
  const db = shop()
  assert.deepEqual(deleteProduct(ctx(db), 'bint'), { ok: true })
  assert.equal(prod(db, 'bint'), undefined)
  assert.equal(lastOp(db).type, 'product.delete')
  full(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017' }), product({ id: 'bint', name: 'Бинт', barcode: '4600000000024', stock: 4 })) })
  assert.equal(prod(db, 'bint'), undefined, 'данные сервера вернули удалённый товар')
  rejectOp(db, lastOp(db), 'Недостаточно прав')
  assert.equal(prod(db, 'bint')?.name, 'Бинт')
})

// ════════════════════════ Категории и типы ════════════════════════

test('категория: завести, переименовать — товары переезжают, удалить занятую нельзя', () => {
  const db = shop()
  const c = createCategory(ctx(db), { name: 'Витамины', noExpiry: false })
  assert.deepEqual(categoriesList(db).map((x) => x.name), ['Витамины', 'Перевязка', 'Таблетки'])
  refused(() => createCategory(ctx(db), { name: 'Витамины' }), 400, CATEGORY_EXISTS)
  assert.equal(lastOp(db).type, 'category.create')

  updateCategory(ctx(db), 'cat1', { name: 'Лекарства' })
  assert.equal(prod(db, 'nur').category, 'Лекарства')
  assert.deepEqual(lastOp(db).payload.set, { name: 'Лекарства' })
  // Свежие данные сервера со старым названием — товары остаются в новой категории
  delta(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', category: 'Таблетки' })), categories: up({ id: 'cat1', name: 'Таблетки', noExpiry: false }) })
  assert.equal(prod(db, 'nur').category, 'Лекарства')
  assert.ok(categoriesList(db).some((x) => x.name === 'Лекарства'))

  refused(() => deleteCategory(ctx(db), 'cat1'), 400, categoryInUse('Лекарства', 1))
  deleteCategory(ctx(db), c.id)
  assert.ok(!categoriesList(db).some((x) => x.id === c.id))
})

test('категория: отказ сервера возвращает и название, и товары', () => {
  const db = shop()
  updateCategory(ctx(db), 'cat1', { name: 'Лекарства' })
  rejectOp(db, lastOp(db), 'Категория с таким названием уже есть')
  assert.equal(prod(db, 'nur').category, 'Таблетки')
  assert.ok(categoriesList(db).some((x) => x.name === 'Таблетки'))
})

test('тип товара: завести, переименовать вместе с товарами, удалить занятый нельзя', () => {
  const db = shop()
  updateProduct(ctx(db), 'nur', { type: 'Лекарство' })
  const t = createProductType(ctx(db), { name: 'Продукты', analogs: false })
  assert.deepEqual(productTypesList(db).map((x) => x.name), ['Лекарство', 'Продукты'])
  updateProductType(ctx(db), 'type-1', { name: 'Медицинский', analogs: true })
  assert.equal(prod(db, 'nur').type, 'Медицинский')
  refused(() => deleteProductType(ctx(db), 'type-1'), 400, typeInUse('Медицинский', 1))
  deleteProductType(ctx(db), t.id)
  assert.deepEqual(productTypesList(db).map((x) => x.name), ['Медицинский'])
})

// ════════════════════════ Сервисы перевода и статьи ════════════════════════

test('сервисы перевода и статьи: завести и убрать без связи; приём сервером «уже есть» — забрать всё заново', () => {
  const db = shop()
  const humo = createPayService(ctx(db), { name: 'Humo' })
  assert.deepEqual(payServicesList(db).map((x) => x.name), ['Alif', 'DC', 'Эсхата', 'Humo'])
  deletePayService(ctx(db), 'paysvc-1')
  assert.deepEqual(payServicesList(db).map((x) => x.name), ['DC', 'Эсхата', 'Humo'])
  const ex = createArticle(ctx(db), 'expense', { name: 'Охрана' })
  assert.ok(expenseCategoriesList(db).some((x) => x.name === 'Охрана'))
  deleteArticle(ctx(db), 'expense', 'expcat-1')
  assert.ok(!expenseCategoriesList(db).some((x) => x.name === 'Аренда'))
  createArticle(ctx(db), 'income', { name: 'Реклама' })
  assert.ok(incomeCategoriesList(db).some((x) => x.name === 'Реклама'))
  // Сервер принял заведение как уже существующее (такую же статью завели на сайте) —
  // касса просит всё заново: её строка лишняя
  const op = ops(db).find((o) => o.type === 'expenseCategory.create')
  ackOp(db, op, { status: 'ok', docId: 'srv-ohrana' })
  assert.equal(row(db, "SELECT value FROM meta WHERE key = 'needFull'").value, '1')
  // Свои неотправленные сервисы переживают свежие данные сервера
  delta(db, { payServices: up({ id: 'paysvc-1', name: 'Alif', ord: 1 }) })
  assert.deepEqual(payServicesList(db).map((x) => x.name), ['DC', 'Эсхата', 'Humo'])
  assert.ok(humo.id && ex.id)
})

// ════════════════════════ Поставщики ════════════════════════

const debtOf = (db, id) => suppliersList(db, true).find((s) => s.id === id)?.debt

test('поставщик: завести, поправить, удалить с долгом нельзя; кассиру — без денег', () => {
  const db = shop()
  const s = createSupplier(ctx(db), { name: 'Хлебозавод', phone: '+992 900 00 00 00', openingDebt: 300 })
  assert.deepEqual([s.name, s.debt, s.openingDebt], ['Хлебозавод', 300, 300])
  refused(() => createSupplier(ctx(db), { name: 'Хлебозавод' }), 400, SUPPLIER_EXISTS)
  assert.deepEqual(lastOp(db).payload.supplier.openingDebt, 300)
  updateSupplier(ctx(db), s.id, { name: 'Хлебозавод №1', note: 'по средам' })
  assert.deepEqual(lastOp(db).payload.set, { name: 'Хлебозавод №1', note: 'по средам' })
  refused(() => deleteSupplier(ctx(db), s.id), 400, SUPPLIER_HAS_DEBT)
  // Кассир заводит поставщика ради прихода — долг на начало не записывается
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassa', role: 'cashier', permissions: ['suppliers.edit'] }
  const c = createSupplier(ctx(db, { user: cashier }), { name: 'Молокозавод', openingDebt: 999 })
  assert.equal('debt' in c, false)
  assert.equal(lastOp(db).payload.supplier.openingDebt, 0)
  deleteSupplier(ctx(db), c.id)
  assert.equal(suppliersList(db, true).some((x) => x.id === c.id), false)
})

test('оплата поставщику без связи: долг и наличные смены сразу; после приёма — не задваиваются; отмена', () => {
  const db = shop()
  const shift = openShift(ctx(db), { openingCash: 1000 })
  ackOp(db, ops(db).find((o) => o.type === 'shift.open'), { status: 'ok', docId: shift.id })
  refused(() => paySupplier(ctx(db), 'sup-1', { amount: 600 }), 400, 'Сумма больше долга поставщика (500.00)')
  const pay = paySupplier(ctx(db), 'sup-1', { amount: 200, fromCash: true, note: 'из ящика' })
  assert.deepEqual([pay.amount, pay.fromCash, pay.shiftId, pay.supplier.name], [200, true, shift.id, 'Опт-Маркет'])
  assert.equal(debtOf(db, 'sup-1'), 300)
  assert.equal(suppliersDebts(db).suppliers.find((x) => x.id === 'sup-1').debt, 300)
  const view = () => shiftView(db, listShifts(db, 'kassa-1').find((x) => x.id === shift.id))
  assert.equal(view().supplierCash, 200)
  assert.deepEqual(listDocs(db, 'supplierpayment').map((x) => x.amount), [200])
  const op = lastOp(db)
  assert.deepEqual(op.payload.payment, { id: pay.id, supplierId: 'sup-1', amount: 200, note: 'из ящика', fromCash: true, shiftId: shift.id, date: pay.date })

  // Сервер принял: долг и смена держатся, пока свежие данные не пришли, и не задваиваются после
  ackOp(db, op, { status: 'ok', docId: pay.id })
  assert.equal(debtOf(db, 'sup-1'), 300)
  assert.equal(view().supplierCash, 200)
  delta(db, { suppliers: up({ ...SUPPLIERS[0], debt: 300 }), supplierPayments: up({ ...pay, user: { id: 'u', name: 'kassir' } }) })
  assert.equal(debtOf(db, 'sup-1'), 300)

  // Отмена: долг назад, наличные назад
  removeSupplierPayment(ctx(db), pay.id)
  assert.equal(debtOf(db, 'sup-1'), 500)
  assert.equal(view().supplierCash, 0)
  assert.deepEqual(listDocs(db, 'supplierpayment'), [])
  // Закрыли смену — отменять оплату из её ящика нельзя
  const pay2 = paySupplier(ctx(db), 'sup-1', { amount: 50, fromCash: true })
  closeShift(ctx(db), { countedCash: 950 })
  refused(() => removeSupplierPayment(ctx(db), pay2.id), 400, PAYMENT_SHIFT_CLOSED)
})

test('оплата поставщику: отказ сервера снимает её — долг прежний, документ помечен', () => {
  const db = shop()
  const pay = paySupplier(ctx(db), 'sup-1', { amount: 100 })
  const op = lastOp(db)
  rejectOp(db, op, 'Поставщик не найден')
  assert.equal(debtOf(db, 'sup-1'), 500)
  assert.deepEqual(listDocs(db, 'supplierpayment'), [])
  assert.equal(describeOp(op, (kind, id) => (kind === 'supplier' && id === 'sup-1' ? { name: 'Опт-Маркет' } : null)).title, 'Опт-Маркет')
  assert.ok(pay.id)
})

test('закупочная цена, вписанная после неотправленного прихода: пересчёт полки её не перекрывает', () => {
  const db = shop()
  // Приход по 90 сдвигает среднюю цену, а потом владелец вписывает цену руками — 120
  createArrival(ctx(db), { supplier: 'Склад', items: [{ productId: 'nur', qty: 10, cost: 90 }] })
  assert.equal(prod(db, 'nur').cost, 95)
  updateProduct(ctx(db), 'nur', { cost: 120 })
  assert.equal(prod(db, 'nur').cost, 120)
  // Полку пересчитали (пришли данные сервера) — правка позже прихода, она и остаётся
  rebuildStock(db)
  assert.equal(prod(db, 'nur').cost, 120)
  delta(db, { products: up(product({ id: 'nur', name: 'Нурофен', barcode: '4600000000017', cost: 100, price: 150, stock: 10, category: 'Таблетки' })) })
  assert.equal(prod(db, 'nur').cost, 120)
})

test('правка категории: в поправку — только то, что поменяли; нетронутое поле не перекрывает сайт', () => {
  const db = shop()
  updateCategory(ctx(db), 'cat1', { name: 'Лекарства', noExpiry: false })
  const e = row(db, "SELECT data FROM row_edits WHERE tbl = 'categories' ORDER BY seq DESC LIMIT 1")
  assert.deepEqual(Object.keys(JSON.parse(e.data).set), ['name'])
  // Пока правка ждёт, на сайте поменяли «без срока» — оно доходит до кассы
  const cat = categoriesList(db).find((c) => c.id === 'cat1')
  delta(db, { categories: up({ id: 'cat1', name: 'Таблетки', noExpiry: true, createdAt: cat.createdAt }) })
  const after = categoriesList(db).find((c) => c.id === 'cat1')
  assert.deepEqual([after.name, after.noExpiry], ['Лекарства', true])
})
