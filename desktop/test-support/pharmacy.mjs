// ── Магазин для проверок ──
//
// Настоящая локальная база (SQLite в памяти), наполненная так же, как её наполняет
// сервер: тем же применением «свежих данных». Проверки работают с теми же модулями,
// что и программа, — подменяются только часы.
import { openDb } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applySnapshot } from '../src/local/snapshot.mjs'

// 4 октября 2026, 15:00 по Душанбе. Сутки в Душанбе начались в 19:00 (UTC) 3 октября
export const NOW = Date.parse('2026-10-04T10:00:00.000Z')
export const DAY = 86400000
// Срок годности приходит датой без времени — как из поля ввода и с сервера
export const day = (iso) => iso + 'T00:00:00.000Z'

let n = 0
const next = (prefix) => `${prefix}${++n}`

// Карточка товара в том виде, в каком её отдаёт сервер
export function product(over = {}) {
  const id = over.id || next('p')
  return {
    id,
    name: 'Товар ' + id,
    barcode: '460' + String(n).padStart(10, '0'),
    category: 'Таблетки',
    cost: 100,
    price: 150,
    stock: 10,
    minStock: 0,
    unit: 'уп',
    unitsPerPack: 1,
    looseUnits: 0,
    dosage: '',
    expiryDate: day('2027-06-30'),
    expiredUnits: 0,
    analogIds: [],
    createdAt: '2026-09-01T08:00:00.000Z',
    ...over,
  }
}

export const customer = (over = {}) => ({
  id: over.id || next('c'),
  name: 'Клиент',
  phone: '',
  debt: 0,
  createdAt: '2026-09-01T08:00:00.000Z',
  ...over,
})

export const CATEGORIES = [
  { id: 'cat1', name: 'Таблетки', noExpiry: false, createdAt: '2026-09-01T08:00:00.000Z' },
  { id: 'cat2', name: 'Перевязка', noExpiry: true, createdAt: '2026-09-01T08:00:00.000Z' },
]

// Статьи расходов — готовый список, который сервер заводит каждом магазине
export const EXPENSE_CATEGORIES = ['Аренда', 'Зарплата', 'Налоги', 'Транспорт', 'Другое'].map((name, n) => ({
  id: 'expcat-' + (n + 1),
  name,
  createdAt: '2026-09-01T08:00:00.000Z',
}))

// Поставщики и сервисы перевода — как их отдаёт сервер владельцу
export const SUPPLIERS = [
  { id: 'sup-1', name: 'Опт-Маркет', phone: '+992 900 11 22 33', note: '', openingDebt: 500, debt: 500, createdAt: '2026-09-01T08:00:00.000Z' },
  { id: 'sup-2', name: 'Авиценна-трейд', phone: '', note: 'по вторникам', openingDebt: 0, debt: 0, createdAt: '2026-09-01T08:00:00.000Z' },
]
export const PAY_SERVICES = ['Alif', 'DC', 'Эсхата'].map((name, n) => ({ id: 'paysvc-' + (n + 1), name, ord: n + 1, createdAt: '2026-09-01T08:00:00.000Z' }))

// База, в которую «сервер прислал» указанное. Чего не прислали — того нет
export function pharmacy(snap = {}, now = NOW) {
  const db = openDb(':memory:', PHARMACY_SCHEMA)
  applySnapshot(
    db,
    { categories: CATEGORIES, expenseCategories: EXPENSE_CATEGORIES, suppliers: SUPPLIERS, payServices: PAY_SERVICES, products: [], customers: [], deferred: [], ...snap },
    { now },
  )
  return db
}

// От чьего имени и на какой кассе выполняется операция
export const ctx = (db, over = {}) => ({
  db,
  now: NOW,
  deviceId: 'kassa-1',
  user: { accountId: 'acc-1', id: 'user-1', name: 'kassir', role: 'founder' },
  ...over,
})

// Отказ с ожидаемым текстом. Текст — часть договора: кассир читает его с экрана,
// и он обязан совпадать с серверным слово в слово
export function refused(fn, status, message) {
  let err = null
  try {
    fn()
  } catch (e) {
    err = e
  }
  if (!err) throw new Error(`ожидался отказ «${message}», а операция прошла`)
  if (err.status !== status || err.message !== message) {
    throw new Error(`ожидался отказ ${status} «${message}», получен ${err.status} «${err.message}»`)
  }
}

export const rows = (db, sql, ...args) => db.prepare(sql).all(...args)
export const row = (db, sql, ...args) => db.prepare(sql).get(...args)
