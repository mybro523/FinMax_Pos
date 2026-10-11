// ── Сверка с настоящим сервером ──
//
// Локальная база считает продажи, возвраты, приходы, расходы и смены сама — теми же формулами,
// что сервер. Обычные проверки (test/) подтверждают, что код делает то, что задумано.
// Эта проверка отвечает на другой вопрос: совпадает ли задуманное с тем, что на самом
// деле делает сервер. Один и тот же день работы проводится дважды — на сервере и в
// локальной базе — и после каждого шага сравнивается всё: суммы документов, остатки,
// закупочные цены, сроки, долг клиента, итоги смены и тексты отказов.
//
// Проверка пишет в настоящую аптеку, поэтому запускается только руками и только
// на своей проверочной аптеке (не на рабочей!):
//   APP_USER=<логин владельца> APP_PASS=<пароль> npm run test:parity
//
// Товары и клиента она заводит сама и убирает за собой.
import test from 'node:test'
import assert from 'node:assert/strict'
import { customersList, productsList } from '../src/local/catalog.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { createCashMove } from '../src/local/ops/cash.mjs'
import { createCustomer, payDebt } from '../src/local/ops/customer.mjs'
import { createExpense } from '../src/local/ops/expense.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift } from '../src/local/ops/shift.mjs'
import { createWriteOff } from '../src/local/ops/writeoff.mjs'
import { openDb } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applySnapshot } from '../src/local/snapshot.mjs'
import { suppliersList } from '../src/local/suppliers.mjs'
import { loadEnv } from '../scripts/env.mjs'

const env = loadEnv()
const API = (env.API_URL || env.APTEKA_API_URL || '').replace(/\/$/, '')
const USER = env.APP_USER || ''
const PASS = env.APP_PASS || ''
const ready = !!(API && USER && PASS)

const TAG = 'PAR-' + Date.now().toString(36)

async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  return { status: res.status, data }
}

// Ответ сервера на удачный запрос; отказ — исключение
async function ok(token, method, path, body) {
  const r = await call(token, method, path, body)
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

// ── Что сравниваем ──
// Номера записей и точное время у сервера и кассы свои — их не сравниваем.
// Всё, что видит человек и что попадает в отчёты, обязано совпасть.
const saleView = (s) => ({
  total: s.total,
  cost: s.cost,
  profit: s.profit,
  payment: s.payment,
  payVia: s.payVia ?? null,
  debtAfter: s.customer ? s.customer.debt : null,
  items: s.items.map((i) => [i.name, i.qty, i.pieces, i.unitsPerPack, i.price, i.cost, i.discount]),
})
const returnView = (r) => ({
  total: r.total,
  refund: r.refund,
  refundVia: r.refundVia ?? null,
  note: r.note,
  items: r.items.map((i) => [i.name, i.units, i.unitsPerPack, i.price, i.cost, i.amount, i.restock]),
})
const arrivalView = (a) => ({
  supplier: a.supplier,
  supplierId: a.supplierId ?? null,
  debt: a.debt ?? 0,
  total: a.total,
  items: a.items.map((i) => [i.name, i.qty, i.cost]),
})
// Внесение и изъятие: вид, сумма, примечание и то, что запись легла в смену
const cashView = (m) => ({ kind: m.kind, amount: m.amount, note: m.note, inShift: !!m.shiftId })
const writeOffView = (w) => ({
  reason: w.reason,
  note: w.note,
  source: w.source,
  totalCost: w.totalCost,
  items: w.items.map((i) => [i.name, i.units, i.cost, i.expiryDate]),
})
const SHIFT_FIELDS = [
  'openingCash', 'countedCash', 'totalSales', 'salesCash', 'salesCard', 'salesDebt', 'debtPaid',
  'refundCash', 'refundTotal', 'refundCost', 'expenseCash', 'cashIn', 'cashOut', 'supplierCash', 'salesTransfer', 'transferBy',
  'profit', 'discount', 'count', 'expectedCash', 'difference',
]
// Расход: что записано и попал ли он в смену. Время расхода «сейчас» у сторон своё,
// поэтому сравнивается день по Душанбе и то, поставлен ли расход на полдень своего дня
// (так ложится день, выбранный владельцем задним числом)
const tjDay = (iso) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 10)
const expenseView = (e) => ({
  category: e.category,
  amount: e.amount,
  note: e.note,
  fromCash: e.fromCash,
  inShift: !!e.shiftId,
  day: tjDay(e.date),
  noon: String(e.date).endsWith('T07:00:00.000Z'),
})
const shiftView = (s) => Object.fromEntries(SHIFT_FIELDS.map((k) => [k, s[k]]))
const cardView = (p) => ({
  name: p.name,
  stock: p.stock,
  looseUnits: p.looseUnits,
  cost: p.cost,
  price: p.price,
  expiryDate: p.expiryDate,
  expiredUnits: p.expiredUnits,
})

test('касса без интернета считает так же, как сервер', { skip: !ready && 'нужны APP_USER и APP_PASS проверочной аптеки', timeout: 300_000 }, async (t) => {
  const login = await ok(null, 'POST', '/auth/login', { name: USER, password: PASS })
  const token = login.token
  assert.equal(login.user.role, 'founder', 'сверка идёт от имени владельца: списание доступно только ему')

  // ── Подготовка: свои товары и клиент на сервере ──
  const mk = (name, extra) =>
    ok(token, 'POST', '/products', {
      name: `${TAG} ${name}`,
      barcode: `${TAG}-${name}`,
      category: 'Таблетки',
      minStock: 0,
      ...extra,
    })
  // Набор подобран под трудные места счёта: дробные цены, неполные упаковки,
  // деление, которое не делится нацело
  const A = await mk('A-melok', { unitsPerPack: 12, price: 2.5, cost: 1, stock: 2, expiryDate: '2027-03-31' })
  const B = await mk('B-paracetamol', { unitsPerPack: 20, price: 200, cost: 120, stock: 9, expiryDate: '2027-06-30' })
  const C = await mk('C-nurofen', { unitsPerPack: 1, price: 150, cost: 100, stock: 5, expiryDate: '2027-01-31' })
  const Dp = await mk('D-bint', { category: 'Перевязка', unitsPerPack: 1, price: 10, cost: 6.33, stock: 20 })
  const E = await mk('E-drob', { unitsPerPack: 10, price: 33.33, cost: 17.77, stock: 3, looseUnits: 4, expiryDate: '2026-12-15' })
  const mine = [A, B, C, Dp, E]
  const ids = new Set(mine.map((p) => p.id))
  const K = await ok(token, 'POST', '/customers', { name: `${TAG} Клиент`, phone: '', debt: 10 })
  const S = await ok(token, 'POST', '/suppliers', { name: `${TAG} Поставщик`, phone: '', openingDebt: 0 })
  // Приходы в долг, заведённые сверкой: перед удалением поставщика их убирают — долг уходит с ними
  const credit = []
  // Расходы, заведённые сверкой на сервере. Расход из кассы закрытой смены удалить
  // нельзя — он остаётся в её отчёте, как и чеки
  const spent = []

  t.after(async () => {
    // Убираем за собой: проверочная аптека не должна обрастать товарами и поставщиками
    for (const id of credit) await call(token, 'DELETE', `/arrivals/${id}`)
    await call(token, 'DELETE', `/suppliers/${S.id}`)
    for (const p of mine) await call(token, 'DELETE', `/products/${p.id}`)
    await call(token, 'DELETE', `/customers/${K.id}`)
    for (const id of spent) await call(token, 'DELETE', `/expenses/${id}`)
    const open = (await ok(token, 'GET', '/shifts')).find((s) => !s.closedAt)
    if (open) await call(token, 'POST', '/shifts/close', { countedCash: 0 })
  })

  // Открытая смена на сервере одна — если осталась от прошлых проверок, закрываем
  const stale = (await ok(token, 'GET', '/shifts')).find((s) => !s.closedAt)
  if (stale) await ok(token, 'POST', '/shifts/close', { countedCash: 0 })

  // ── Локальная база: то, что сервер знает прямо сейчас ──
  const db = openDb(':memory:', PHARMACY_SCHEMA)
  const [products, categories, customers, expenseCategories, suppliers, payServices] = await Promise.all([
    ok(token, 'GET', '/products'),
    ok(token, 'GET', '/categories'),
    ok(token, 'GET', '/customers'),
    ok(token, 'GET', '/expense-categories'),
    ok(token, 'GET', '/suppliers'),
    ok(token, 'GET', '/pay-services'),
  ])
  applySnapshot(
    db,
    {
      products: products.filter((p) => ids.has(p.id)),
      categories,
      customers: customers.filter((c) => c.id === K.id),
      expenseCategories,
      suppliers: suppliers.filter((s) => s.id === S.id),
      payServices,
    },
    { now: Date.now() },
  )
  const ctx = () => ({ db, now: Date.now(), deviceId: 'parity', user: { accountId: login.user.id, id: 'u', name: USER, role: 'founder' } })

  // Сверить карточки товаров и долг клиента
  async function sameState(step) {
    const srv = (await ok(token, 'GET', '/products')).filter((p) => ids.has(p.id)).map(cardView)
    const loc = productsList(db, Date.now()).map(cardView)
    const byName = (a, b) => (a.name < b.name ? -1 : 1)
    assert.deepEqual(loc.sort(byName), srv.sort(byName), `${step}: карточки товаров разошлись`)
    const debtSrv = (await ok(token, 'GET', '/customers')).find((c) => c.id === K.id).debt
    const debtLoc = customersList(db).find((c) => c.id === K.id).debt
    assert.equal(debtLoc, debtSrv, `${step}: долг клиента разошёлся`)
    const supSrv = (await ok(token, 'GET', '/suppliers')).find((s) => s.id === S.id).debt
    const supLoc = suppliersList(db, true).find((s) => s.id === S.id).debt
    assert.equal(supLoc, supSrv, `${step}: долг поставщика разошёлся`)
  }

  // Один шаг на обеих сторонах: одинаковый запрос, сравнение ответов и состояния
  async function both(step, path, body, local, view) {
    const srv = await call(token, 'POST', path, body)
    let loc
    try {
      loc = { status: 201, data: local(ctx(), body) }
    } catch (e) {
      loc = { status: e.status, data: { message: e.messages || e.message } }
    }
    if (srv.status >= 300) {
      const msg = (m) => (Array.isArray(m) ? m.join(', ') : m)
      assert.equal(loc.status, srv.status, `${step}: сервер отказал (${msg(srv.data?.message)}), касса — нет`)
      assert.equal(msg(loc.data.message), msg(srv.data.message), `${step}: текст отказа разошёлся`)
    } else {
      assert.equal(loc.status, 201, `${step}: касса отказала (${loc.data?.message}), сервер — нет`)
      assert.deepEqual(view(loc.data), view(srv.data), `${step}: документ разошёлся`)
    }
    await sameState(step)
    return { srv: srv.data, loc: loc.data }
  }

  await sameState('начало')

  // ── Смена ──
  const shift = await both('открытие смены', '/shifts/open', { openingCash: 100.5 }, openShift, (s) => ({ openingCash: s.openingCash, closedAt: s.closedAt }))
  await both('вторая смена', '/shifts/open', { openingCash: 1 }, openShift, () => null)

  // ── Продажи ──
  const sale1 = await both(
    'продажа 1',
    '/sales',
    {
      payment: 'cash',
      items: [
        { productId: A.id, qty: 0, pieces: 3 },
        { productId: B.id, qty: 1, pieces: 5, discount: 10 },
        { productId: C.id, qty: 2 },
        { productId: E.id, qty: 1, pieces: 3, discount: 0.5 },
      ],
    },
    checkout,
    saleView,
  )
  const sale2 = await both(
    'продажа 2 (в долг, скидка больше суммы)',
    '/sales',
    {
      payment: 'debt',
      customerId: K.id,
      items: [
        { productId: Dp.id, qty: 3 },
        { productId: E.id, qty: 0, pieces: 7, discount: 100 },
      ],
    },
    checkout,
    saleView,
  )
  await both('продажа сверх остатка', '/sales', { payment: 'cash', items: [{ productId: C.id, qty: 4 }] }, checkout, saleView)
  await both('продажа без количества', '/sales', { payment: 'cash', items: [{ productId: C.id, qty: 0, pieces: 0 }] }, checkout, saleView)
  await both('продажа в долг без клиента', '/sales', { payment: 'debt', items: [{ productId: C.id, qty: 1 }] }, checkout, saleView)
  await both('продажа: дробные упаковки', '/sales', { payment: 'cash', items: [{ productId: C.id, qty: 1.5 }] }, checkout, saleView)
  await both('продажа: пустой чек', '/sales', { payment: 'cash', items: [] }, checkout, saleView)

  // ── Приход ──
  await both(
    'приход',
    '/arrivals',
    {
      supplier: 'Сверка',
      items: [
        { productId: B.id, qty: 3, cost: 130, expiryDate: '2028-01-31' },
        { productId: B.id, qty: 1, cost: 150.555, expiryDate: '2028-06-30' },
        { productId: Dp.id, qty: 10, cost: 5 },
        // Срок раньше, чем у лежащего на полке: ближайший срок товара должен смениться
        { productId: E.id, qty: 2, cost: 19.999, expiryDate: '2026-11-01' },
      ],
    },
    createArrival,
    arrivalView,
  )
  await both('приход без срока у лекарства', '/arrivals', { items: [{ productId: C.id, qty: 1, cost: 90 }] }, createArrival, arrivalView)
  await both('приход: ноль упаковок', '/arrivals', { items: [{ productId: C.id, qty: 0, cost: 90, expiryDate: '2028-01-01' }] }, createArrival, arrivalView)

  await both(
    'продажа 3 (через несколько партий)',
    '/sales',
    {
      payment: 'card',
      items: [
        { productId: E.id, qty: 1 },
        { productId: B.id, qty: 10 },
      ],
    },
    checkout,
    saleView,
  )

  // ── Переводы ──
  const saleT = await both('продажа переводом', '/sales', { payment: 'transfer', payVia: 'DC', items: [{ productId: Dp.id, qty: 2 }] }, checkout, saleView)
  await both('продажа переводом без сервиса', '/sales', { payment: 'transfer', items: [{ productId: Dp.id, qty: 1 }] }, checkout, saleView)

  // ── Возвраты ──
  // Чек на сервере и чек в кассе — разные записи с разными номерами: каждой стороне
  // возврат оформляется по её собственному чеку
  async function bothReturn(step, sale, body) {
    const srv = await call(token, 'POST', '/returns', { ...body, saleId: sale?.srv.id })
    let loc
    try {
      loc = { status: 201, data: createReturn(ctx(), { ...body, saleId: sale?.loc.id }) }
    } catch (e) {
      loc = { status: e.status, data: { message: e.messages || e.message } }
    }
    if (srv.status >= 300) {
      assert.equal(loc.status, srv.status, `${step}: сервер отказал (${srv.data?.message}), касса — нет`)
      assert.equal(loc.data.message, srv.data.message, `${step}: текст отказа разошёлся`)
    } else {
      assert.equal(loc.status, 201, `${step}: касса отказала (${loc.data?.message}), сервер — нет`)
      assert.deepEqual(returnView(loc.data), returnView(srv.data), `${step}: возврат разошёлся`)
    }
    await sameState(step)
  }

  await bothReturn('возврат 1', sale1, {
    items: [
      { productId: B.id, units: 5 },
      { productId: C.id, units: 1, restock: false },
      { productId: A.id, units: 2 },
      { productId: E.id, units: 4 },
    ],
  })
  await bothReturn('возврат больше купленного', sale1, { items: [{ productId: B.id, units: 21 }] })
  await bothReturn('возврат чужого товара', sale1, { items: [{ productId: Dp.id, units: 1 }] })
  await bothReturn('возврат в долг по наличному чеку', sale1, { refund: 'debt', items: [{ productId: C.id, units: 1 }] })
  await bothReturn('возврат 2 (уменьшает долг)', sale2, { items: [{ productId: Dp.id, units: 1 }] })
  await bothReturn('возврат 3 (скидка съела всю сумму)', sale2, { items: [{ productId: E.id, units: 3 }] })
  await bothReturn('возврат без чека', null, { note: 'без чека', items: [{ productId: C.id, units: 1 }] })
  await bothReturn('возврат переводом (сервис — из чека)', saleT, { items: [{ productId: Dp.id, units: 1 }] })
  await bothReturn('возврат переводом другим сервисом', saleT, { refund: 'transfer', refundVia: 'Alif', items: [{ productId: Dp.id, units: 1 }] })

  // ── Долг ──
  await both('погашение долга (сумма с тремя знаками)', `/customers/${K.id}/pay`, { amount: 7.777 }, (c, b) => payDebt(c, K.id, b), (c) => ({ debt: c.debt }))
  // Долг стал меньше суммы возврата — списать с него нельзя
  await both('погашение почти всего долга', `/customers/${K.id}/pay`, { amount: 20 }, (c, b) => payDebt(c, K.id, b), (c) => ({ debt: c.debt }))
  await bothReturn('возврат в долг сверх долга', sale2, { items: [{ productId: Dp.id, units: 2 }] })
  await both('погашение сверх долга', `/customers/${K.id}/pay`, { amount: 1000 }, (c, b) => payDebt(c, K.id, b), (c) => ({ debt: c.debt }))
  await both('погашение при нулевом долге', `/customers/${K.id}/pay`, { amount: 5 }, (c, b) => payDebt(c, K.id, b), (c) => ({ debt: c.debt }))
  await both('новый клиент', '/customers', { name: `${TAG} Второй`, phone: '901', debt: 12.345 }, createCustomer, (c) => ({ name: c.name, phone: c.phone, debt: c.debt }))
    .then(async ({ srv }) => {
      await call(token, 'DELETE', `/customers/${srv.id}`)
    })

  // ── Списание ──
  await both(
    'списание (через партии с разными сроками)',
    '/writeoffs',
    {
      reason: 'damaged',
      note: 'сверка',
      items: [
        { productId: E.id, units: 25 },
        { productId: C.id, units: 1 },
      ],
    },
    createWriteOff,
    writeOffView,
  )
  await both('списание сверх остатка', '/writeoffs', { items: [{ productId: C.id, units: 999 }] }, createWriteOff, writeOffView)

  // ── Расходы ──
  // День по Душанбе три дня назад — так его отдаёт поле даты в окне
  const dayAgo = (n) => new Date(Date.now() + 5 * 3600_000 - n * 86400_000).toISOString().slice(0, 10)
  const expense = async (step, body) => {
    const r = await both(step, '/expenses', body, createExpense, expenseView)
    if (r.srv?.id) spent.push(r.srv.id)
    return r
  }
  await expense('расход задним числом (сумма с тремя знаками)', { category: 'Аренда', amount: 1500.456, note: '  сверка  ', date: dayAgo(3) })
  await expense('расход сегодняшним числом', { category: 'Зарплата', amount: 0.01, date: dayAgo(0) })
  await expense('расход из кассы', { category: 'Транспорт', amount: 40.5, note: 'такси', fromCash: true })
  await expense('расход из кассы: дату ему не выбирают', { category: 'Другое', amount: 3.33, fromCash: true, date: dayAgo(5) })
  await expense('расход по статье не из списка', { category: `${TAG} нет такой`, amount: 10 })
  await expense('расход с нулевой суммой', { category: 'Аренда', amount: 0 })
  await expense('расход с отрицательной суммой', { category: 'Аренда', amount: -5 })
  await expense('расход будущим числом', { category: 'Аренда', amount: 10, date: dayAgo(-2) })
  await expense('расход с негодной датой', { category: 'Аренда', amount: 10, date: 'вчера' })
  await expense('расход: статья из одних пробелов', { category: '   ', amount: 10 })

  // ── Наличные в смене ──
  await both('внесение (сумма с тремя знаками)', '/shifts/cash', { kind: 'in', amount: 33.333, note: '  размен ' }, createCashMove, cashView)
  await both('изъятие', '/shifts/cash', { kind: 'out', amount: 10 }, createCashMove, cashView)
  await both('внесение нуля', '/shifts/cash', { kind: 'in', amount: 0 }, createCashMove, cashView)
  await both('изъятие: не тот вид', '/shifts/cash', { kind: 'take', amount: 1 }, createCashMove, cashView)

  // ── Приход в долг ──
  const credited = await both(
    'приход в долг (долг не больше суммы)',
    '/arrivals',
    { supplierId: S.id, debt: 100, items: [{ productId: Dp.id, qty: 10, cost: 5 }] },
    createArrival,
    arrivalView,
  )
  if (credited.srv?.id) credit.push(credited.srv.id)
  await both('приход в долг неизвестному поставщику', '/arrivals', { supplierId: 'net-takogo', debt: 1, items: [{ productId: Dp.id, qty: 1, cost: 5 }] }, createArrival, arrivalView)
  await both('приход: долг меньше нуля', '/arrivals', { supplierId: S.id, debt: -1, items: [{ productId: Dp.id, qty: 1, cost: 5 }] }, createArrival, arrivalView)

  // ── Закрытие смены ──
  // Расходы из кассы, внесённое и изъятое меняют «ожидается в кассе» — и на сервере,
  // и на кассе одинаково; переводы считаются отдельно и по сервисам
  assert.ok(shift.srv.id && shift.loc.id)
  await both('закрытие смены', '/shifts/close', { countedCash: 1234.567 }, closeShift, shiftView)
  await both('закрытие без смены', '/shifts/close', { countedCash: 1 }, closeShift, shiftView)
  await expense('расход из кассы без открытой смены', { category: 'Транспорт', amount: 5, fromCash: true })
  await both('внесение без открытой смены', '/shifts/cash', { kind: 'in', amount: 5 }, createCashMove, cashView)
})
