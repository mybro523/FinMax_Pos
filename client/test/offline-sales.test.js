// Сайт продаёт без интернета (14.11.2026): очередь чеков, наложение на списки, отправка.
import test from 'node:test'
import assert from 'node:assert/strict'

// ── Заглушки браузера — до загрузки слоя данных ──
const ls = new Map()
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  key: (i) => [...ls.keys()][i] ?? null,
  get length() {
    return ls.size
  },
}
const ss = new Map()
globalThis.sessionStorage = {
  getItem: (k) => (ss.has(k) ? ss.get(k) : null),
  setItem: (k, v) => ss.set(k, String(v)),
  removeItem: (k) => ss.delete(k),
}
const KASSIR = { id: 'acc_k1', name: 'kassir1', role: 'cashier', tenantUserId: 'u_k1', pharmacy: { code: 'demo', name: 'Демо' } }
const OWNER = { id: 'acc_own', name: 'farhod', role: 'founder', pharmacy: { code: 'demo', name: 'Демо' } }
const login = (u) => {
  ss.set('apteka_user', JSON.stringify(u))
  ss.set('apteka_token', 'tok_' + u.id)
}
login(KASSIR)

let online = true
Object.defineProperty(globalThis, 'navigator', { value: { get onLine() { return online } }, configurable: true })

const jsonRes = (data, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'date' ? new Date().toUTCString() : k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => data,
  text: async () => JSON.stringify(data),
})
let server = { products: [], sales: [], customers: [], shifts: [] }
let salesPost = null // (body) => Response | throws
const posted = []
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  const path = String(url).replace(/^.*\/api/, '').split('?')[0]
  if (method === 'GET') {
    const key = path.slice(1)
    return jsonRes(server[key] ?? [])
  }
  if (method === 'POST' && path === '/sales') {
    posted.push(JSON.parse(opts.body))
    if (salesPost) return salesPost(JSON.parse(opts.body))
    return jsonRes({ id: 'srv_sale', ...JSON.parse(opts.body), date: new Date().toISOString(), items: [] })
  }
  return jsonRes(null)
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const store = await import('../src/db/store.js')
const off = await import('../src/lib/offlineSales.js')
const ops = await import('../src/db/ops.js')
const { db, setCollection, fetchKey } = store
const { buildOfflineSale, memoryStorage, setOfflineStorage, setOfflineTransport, flushOffline, cancelQueued, dismissRejected, offlineSnapshot, enqueueSale, saleView } = off

// Тот же расчёт, что у сервера (server/src/common/piece.ts grossOf + sync applySale),
// только в копейках — чтобы проверка не зависела от плавающей точки
function serverTotals(sale) {
  let total = 0
  let cost = 0
  for (const i of sale.items) {
    const drob = ['кг', 'л', 'м', 'м²'].includes(String(i.unit || '').toLowerCase())
    const pu = drob ? 1000 : 1
    const opens = Math.max(1, i.unitsPerPack) > pu
    const own = opens && i.piecePrice > 0 ? i.piecePrice : null
    const piece = own !== null ? own / pu : i.price / Math.max(1, i.unitsPerPack)
    const gross = i.price * i.qty + piece * i.pieces
    const disc = Math.min(Math.max(0, i.discount), gross)
    total += gross - disc
    cost += (i.cost / i.unitsPerPack) * (i.qty * i.unitsPerPack + i.pieces)
  }
  return { total: Math.round(total * 100) / 100, cost: Math.round(cost * 100) / 100 }
}
// Сервер отказывает, если итог чека расходится с позициями больше чем на дирам с позиции
const sumsOk = (sale) => {
  const s = serverTotals(sale)
  const slack = 0.01 * sale.items.length + 1e-9
  return Math.abs(s.total - sale.total) <= slack && Math.abs(s.cost - sale.cost) <= slack
}

const P1 = { id: 'p1', name: 'Анальгин', price: 12.5, cost: 8, stock: 10, looseUnits: 0, unitsPerPack: 10, unit: 'уп', piecePrice: 1.5 }
const P2 = { id: 'p2', name: 'Мука', price: 190, cost: 150, stock: 3, looseUnits: 0, unitsPerPack: 50000, unit: 'кг', piecePrice: 4 }
const P3 = { id: 'p3', name: 'Хлеб', price: 3, cost: 2, stock: 40, looseUnits: 0, unitsPerPack: 1, unit: 'шт' }

// Состав товара (1.8.5): торт собирается из муки (кг, 0.2 = 200 г), яиц (10 шт) и молока
// (л, 1 = 1000 мл). Своего остатка у торта нет — при продаже уходят ингредиенты.
// Остатки: мука 10 кг → собрать 50, яйца 100 → собрать 10, молоко 20 л → собрать 20 ⇒ 10.
const FLOUR = { id: 'ing_flour', name: 'Мука-сырьё', price: 15, cost: 10, stock: 10, looseUnits: 0, unitsPerPack: 1000, unit: 'кг' }
const EGGS = { id: 'ing_eggs', name: 'Яйца', price: 1.5, cost: 1.2, stock: 100, looseUnits: 0, unitsPerPack: 1, unit: 'шт' }
const MILK = { id: 'ing_milk', name: 'Молоко', price: 12, cost: 10, stock: 20, looseUnits: 0, unitsPerPack: 1000, unit: 'л' }
const CAKE = {
  id: 'cake', name: 'Торт', price: 200, cost: 0, stock: 0, looseUnits: 0, unitsPerPack: 1, unit: 'шт',
  recipe: [
    { ingredientId: 'ing_flour', units: 200 },
    { ingredientId: 'ing_eggs', units: 10 },
    { ingredientId: 'ing_milk', units: 1000 },
  ],
}

async function fresh({ user = KASSIR } = {}) {
  login(user)
  online = true
  salesPost = null
  posted.length = 0
  server = {
    products: [P1, P2, P3].map((p) => ({ ...p })),
    sales: [],
    customers: [{ id: 'c1', name: 'Иван', debt: 100 }],
    shifts: [{ id: 'sh1', closedAt: null }],
  }
  setOfflineTransport(async () => ({ status: 'retry' }))
  await setOfflineStorage(memoryStorage())
  for (const k of ['products', 'sales', 'customers', 'shifts']) await fetchKey(k)
}
const stockOf = (id) => {
  const p = db.get('products').find((x) => x.id === id)
  return p.stock * Math.max(1, p.unitsPerPack) + (p.looseUnits || 0)
}

// Магазин с составным товаром и его ингредиентами
async function freshComposite() {
  await fresh()
  server.products = [FLOUR, EGGS, MILK, CAKE].map((p) => ({ ...p }))
  await fetchKey('products')
}

test('чек без связи: суммы как у сервера (скидки, штуки, весовой в мешке, своя цена штуки)', () => {
  const sale = buildOfflineSale({
    lines: [
      { productId: 'p1', name: 'Анальгин', qty: 1, pieces: 3, unitsPerPack: 10, price: 12.5, piecePrice: 1.5, unit: 'уп', cost: 8, discount: 0.333 },
      { productId: 'p2', name: 'Мука', qty: 1, pieces: 2500, unitsPerPack: 50000, price: 190, piecePrice: 4, unit: 'кг', cost: 150, discount: 0 },
      { productId: 'p3', name: 'Хлеб', qty: 7, pieces: 0, unitsPerPack: 1, price: 3, piecePrice: null, unit: 'шт', cost: 2, discount: 1.2 },
      { productId: 'p1', name: 'Анальгин', qty: 0, pieces: 7, unitsPerPack: 10, price: 12.5, piecePrice: null, unit: 'уп', cost: 8, discount: 0 },
    ],
    payment: 'cash',
    shiftId: 'sh1',
    date: '2026-11-14T10:00:00.000Z',
    clientId: 'tmp_abc',
  })
  assert.ok(sumsOk(sale), JSON.stringify({ sale: [sale.total, sale.cost], server: serverTotals(sale) }))
  // 12.5 + 3×1.5 − 0.333 = 16.667; 190 + 2.5×4 = 200; 21 − 1.2 = 19.8; 7×1.25 = 8.75 → 245.22
  assert.equal(sale.total, 245.22)
  assert.equal(sale.profit, Math.round((sale.total - sale.cost) * 100) / 100)
  assert.equal(sale.items[0].discount, 0.33)
  assert.equal(sale.clientId, 'tmp_abc')
  assert.equal(sale.payVia, null)
  assert.equal(sale.customerId, null)
  for (const i of sale.items) assert.match(i.id, /^[A-Za-z0-9_:.-]{1,64}$/)
  assert.match(sale.id, /^ws/)
})

test('чек без связи: перевод — с сервисом, долг — с клиентом', () => {
  const line = { productId: 'p3', name: 'Хлеб', qty: 2, pieces: 0, unitsPerPack: 1, price: 3, cost: 2 }
  const tr = buildOfflineSale({ lines: [line], payment: 'transfer', payVia: ' Алиф ', shiftId: 'sh1', date: '2026-11-14T10:00:00.000Z' })
  assert.equal(tr.payVia, 'Алиф')
  const debt = buildOfflineSale({ lines: [line], payment: 'debt', customerId: 'c1', shiftId: 'sh1', date: '2026-11-14T10:00:00.000Z' })
  assert.equal(debt.customerId, 'c1')
  assert.equal(debt.payVia, null)
  // Наличными — клиента в чеке нет, даже если он выбран
  const cash = buildOfflineSale({ lines: [line], payment: 'cash', customerId: 'c1', shiftId: 'sh1', date: '2026-11-14T10:00:00.000Z' })
  assert.equal(cash.customerId, null)
})

test('касса без связи: чек сразу в очередь, остаток/продажа/долг на экране, POST /sales не ждём', async () => {
  await fresh()
  online = false
  const before = stockOf('p3')
  const { sale, synced } = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty: 4, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт', discount: 0 }],
    payment: 'debt',
    customer: { id: 'c1', name: 'Иван' },
  })
  const stored = await synced
  assert.equal(posted.length, 0, 'без связи запрос не уходит')
  assert.equal(stored._offline, true)
  assert.equal(stored.clientId, sale.id, 'clientId — номер временной записи кассы')
  assert.equal(stored.date, sale.date, 'время чека — время продажи')
  assert.equal(offlineSnapshot().pending, 1)
  assert.equal(stockOf('p3'), before - 4)
  assert.equal(db.get('customers').find((c) => c.id === 'c1').debt, 112)
  const sales = db.get('sales')
  assert.equal(sales.filter((s) => s.clientId === sale.id || s.id === sale.id).length, 1, 'временная запись заменена записью очереди — без дубля')
  // Опрос сервера (старые данные) не стирает наложение
  await fetchKey('products')
  await fetchKey('customers')
  assert.equal(stockOf('p3'), before - 4)
  assert.equal(db.get('customers').find((c) => c.id === 'c1').debt, 112)
  // В хранилище кэша — данные сервера, без чека очереди (иначе после перезагрузки остаток уменьшился бы дважды)
  const persisted = JSON.parse(ls.get('apteka_cache_v3_demo_products'))
  const p3 = persisted.find((p) => p.id === 'p3')
  assert.equal(p3.stock, 40)
})

test('связь пропала посреди продажи: после повторов чек в очереди, а не «Продажа не записана»', async () => {
  await fresh()
  salesPost = () => {
    throw new TypeError('Failed to fetch')
  }
  const { synced } = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty: 1, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт' }],
    payment: 'cash',
  })
  const stored = await synced
  assert.equal(stored._offline, true)
  assert.ok(posted.length >= 1)
  assert.equal(offlineSnapshot().pending, 1)
  assert.equal(stockOf('p3'), 39)
  // Связь известна как потерянная — следующий чек не ждёт повторов
  posted.length = 0
  const second = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty: 1, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт' }],
    payment: 'cash',
  })
  await second.synced
  assert.equal(posted.length, 0)
  assert.equal(offlineSnapshot().pending, 2)
})

test('отказ сервера по существу (400) — как раньше: продажа не записана, корзина вернётся', async () => {
  await fresh()
  salesPost = () => jsonRes({ message: 'Недостаточно «Хлеб» на складе' }, 400)
  const { synced } = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty: 1, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт' }],
    payment: 'cash',
  })
  await assert.rejects(synced)
  assert.equal(offlineSnapshot().pending, 0)
  assert.equal(stockOf('p3'), 40)
})

test('без открытой смены без связи не продаёт', async () => {
  await fresh()
  setCollection('shifts', [{ id: 'sh0', closedAt: '2026-11-13T10:00:00.000Z' }])
  online = false
  const { synced } = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty: 1, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт' }],
    payment: 'cash',
  })
  await assert.rejects(synced, /откройте смену/)
  assert.equal(offlineSnapshot().pending, 0)
  assert.equal(stockOf('p3'), 40)
})

async function sellOffline(qty = 1, extra = {}) {
  online = false
  const { synced } = ops.checkout({
    items: [{ productId: 'p3', name: 'Хлеб', qty, pieces: 0, price: 3, cost: 2, unitsPerPack: 1, unit: 'шт' }],
    payment: 'cash',
    ...extra,
  })
  const s = await synced
  online = true
  return s
}

test('связь вернулась: чеки уходят по порядку, следы остаются, очередь пустеет', async () => {
  await fresh()
  const a = await sellOffline(1)
  await settle(5)
  const b = await sellOffline(2)
  const sent = []
  setOfflineTransport(async (body) => {
    sent.push(body)
    // Сервер записал чек: в его данных остаток уже меньше
    server.products = server.products.map((p) => (p.id === 'p3' ? { ...p, stock: p.stock - body.payload.sale.items[0].qty } : p))
    server.sales = [{ ...body.payload.sale }, ...server.sales]
    return { id: body.id, status: 'ok', docId: body.payload.sale.id }
  })
  const r = await flushOffline()
  assert.equal(r.sent, 2)
  assert.deepEqual(
    sent.map((x) => x.payload.sale.id),
    [a.id, b.id],
  )
  assert.equal(sent[0].accountId, KASSIR.id)
  assert.equal(sent[0].createdAt, a.date)
  assert.equal(offlineSnapshot().pending, 0)
  // Пока не пришёл ответ опроса — остаток прежний (следы остались как данные сервера)
  assert.equal(stockOf('p3'), 37)
  await settle(20)
  await fetchKey('products')
  await fetchKey('sales')
  assert.equal(stockOf('p3'), 37, 'не задвоилось после опроса')
  assert.equal(db.get('sales').filter((s) => s.id === a.id).length, 1)
})

test('duplicate — тот же чек сервер уже принял: убрать из очереди, как ok', async () => {
  await fresh()
  await sellOffline(1)
  setOfflineTransport(async (body) => ({ id: body.id, status: 'duplicate', docId: 'srv_x' }))
  const r = await flushOffline()
  assert.equal(r.sent, 1)
  assert.equal(offlineSnapshot().pending, 0)
})

test('сервер не принял чек: следы сняты, чек показан с причиной, «Понятно» убирает', async () => {
  await fresh()
  const s = await sellOffline(5)
  assert.equal(stockOf('p3'), 35)
  setOfflineTransport(async (body) => ({ id: body.id, status: 'rejected', error: 'Недостаточно прав' }))
  const r = await flushOffline()
  assert.equal(r.rejected, 1)
  const snap = offlineSnapshot()
  assert.equal(snap.pending, 0)
  assert.equal(snap.rejected.length, 1)
  assert.equal(snap.rejected[0].error, 'Недостаточно прав')
  assert.equal(stockOf('p3'), 40, 'остаток — как у сервера')
  assert.equal(db.get('sales').some((x) => x.id === s.id), false)
  await dismissRejected(snap.rejected[0].opId)
  assert.equal(offlineSnapshot().rejected.length, 0)
})

test('retry и обрыв связи — чек остаётся, следующие не шлём; 401 — ждём нового входа', async () => {
  await fresh()
  await sellOffline(1)
  await settle(5)
  await sellOffline(1)
  let calls = 0
  setOfflineTransport(async (body) => {
    calls++
    return { id: body.id, status: 'retry' }
  })
  await flushOffline()
  assert.equal(calls, 1, 'после retry остальные не отправляются')
  assert.equal(offlineSnapshot().pending, 2)
  calls = 0
  setOfflineTransport(async () => {
    calls++
    throw Object.assign(new Error('Нет связи'), { status: 0 })
  })
  await flushOffline()
  assert.equal(calls, 1)
  assert.equal(offlineSnapshot().pending, 2)
  calls = 0
  setOfflineTransport(async () => {
    calls++
    throw Object.assign(new Error('Сессия недействительна'), { status: 401 })
  })
  await flushOffline()
  assert.equal(offlineSnapshot().pending, 2)
  assert.equal(stockOf('p3'), 38, 'следы на месте, пока чеки ждут')
})

test('чеки другого кассира ждут его входа; владелец отправляет все', async () => {
  await fresh()
  await sellOffline(1) // продал kassir1
  login({ ...KASSIR, id: 'acc_k2', name: 'kassir2', tenantUserId: 'u_k2' })
  const sent = []
  setOfflineTransport(async (body) => {
    sent.push(body)
    return { id: body.id, status: 'ok' }
  })
  await flushOffline()
  assert.equal(sent.length, 0)
  assert.equal(offlineSnapshot().others, 1)
  login(OWNER)
  await flushOffline()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].accountId, KASSIR.id, 'кассир чека — тот, кто продал')
  assert.equal(offlineSnapshot().pending, 0)
})

test('«Отмена» чека из очереди: снят без возврата, остаток и долг как были', async () => {
  await fresh()
  const s = await sellOffline(3, { payment: 'debt', customer: { id: 'c1', name: 'Иван' } })
  assert.equal(stockOf('p3'), 37)
  assert.equal(db.get('customers').find((c) => c.id === 'c1').debt, 109)
  assert.equal(await cancelQueued(s.id), true)
  assert.equal(stockOf('p3'), 40)
  assert.equal(db.get('customers').find((c) => c.id === 'c1').debt, 100)
  assert.equal(db.get('sales').some((x) => x.id === s.id), false)
  assert.equal(offlineSnapshot().pending, 0)
  // Уже отправленный — не в очереди: отменяется возвратом
  assert.equal(await cancelQueued('нет_такого'), false)
})

test('перезагрузка страницы: очередь из хранилища снова накладывается на данные сервера', async () => {
  await fresh()
  const mem = memoryStorage()
  await setOfflineStorage(mem)
  online = false
  const { synced } = ops.checkout({
    items: [{ productId: 'p1', name: 'Анальгин', qty: 1, pieces: 2, price: 12.5, piecePrice: 1.5, cost: 8, unitsPerPack: 10, unit: 'уп' }],
    payment: 'card',
  })
  const s = await synced
  online = true
  assert.equal(stockOf('p1'), 100 - 12)
  // «Перезагрузка»: очередь читается из хранилища заново, данные — с сервера
  await setOfflineStorage(mem)
  await fetchKey('products')
  await fetchKey('sales')
  assert.equal(stockOf('p1'), 88)
  assert.equal(db.get('sales').filter((x) => x.id === s.id).length, 1)
  // Сервер уже знает чек (ответ на отправку потерялся) — второй раз не накладывается
  server.sales = [{ id: 'srv_other', clientId: s.clientId, date: s.date, items: [] }]
  server.products = server.products.map((p) => (p.id === 'p1' ? { ...p, stock: 8, looseUnits: 8 } : p))
  await fetchKey('sales')
  await fetchKey('products')
  assert.equal(stockOf('p1'), 88, 'не вычтено второй раз')
  assert.equal(db.get('sales').filter((x) => x.id === s.id || x.clientId === s.clientId).length, 1)
})

test('составной товар без связи: списываются ингредиенты, а не сам торт', async () => {
  await freshComposite()
  online = false
  assert.equal(stockOf('ing_flour'), 10000)
  assert.equal(stockOf('ing_eggs'), 100)
  assert.equal(stockOf('ing_milk'), 20000)
  assert.equal(stockOf('cake'), 0)
  const { sale, synced } = ops.checkout({
    items: [{ productId: 'cake', name: 'Торт', qty: 2, pieces: 0, price: 200, cost: 0, unitsPerPack: 1, unit: 'шт', discount: 0 }],
    payment: 'cash',
  })
  const stored = await synced
  assert.equal(stored._offline, true)
  assert.equal(offlineSnapshot().pending, 1)
  // 2 торта: мука −400 г, яйца −20, молоко −2000 мл; остаток самого торта не трогаем
  assert.equal(stockOf('ing_flour'), 10000 - 400)
  assert.equal(stockOf('ing_eggs'), 100 - 20)
  assert.equal(stockOf('ing_milk'), 20000 - 2000)
  assert.equal(stockOf('cake'), 0, 'у составного своего остатка нет')
  // Опрос сервера (старые данные) не стирает наложение очереди
  await fetchKey('products')
  assert.equal(stockOf('ing_eggs'), 80)
  assert.equal(stockOf('cake'), 0)
  assert.equal(db.get('sales').filter((s) => s.id === sale.id || s.clientId === sale.id).length, 1)
})

test('составной товар: не хватает ингредиента — продажа не проходит, остатки целы', async () => {
  await freshComposite()
  // 11 тортов: муки и молока хватает, а яиц (100) только на 10 — упираемся в яйца
  assert.throws(
    () =>
      ops.checkout({
        items: [{ productId: 'cake', name: 'Торт', qty: 11, pieces: 0, price: 200, cost: 0, unitsPerPack: 1, unit: 'шт' }],
        payment: 'cash',
      }),
    /Яйца/,
  )
  assert.equal(stockOf('ing_eggs'), 100, 'ничего не списано')
  assert.equal(stockOf('ing_flour'), 10000)
  assert.equal(offlineSnapshot().pending, 0)
})

test('запись в очередь: вид продажи в списках', () => {
  const sale = buildOfflineSale({
    lines: [{ productId: 'p3', name: 'Хлеб', qty: 1, pieces: 0, unitsPerPack: 1, price: 3, cost: 2, unit: 'шт' }],
    payment: 'debt',
    customerId: 'c1',
    shiftId: 'sh1',
    date: '2026-11-14T10:00:00.000Z',
  })
  const v = saleView({ payload: { sale }, cashier: 'kassir1', tenantUserId: 'u_k1', customerName: 'Иван' })
  assert.equal(v._offline, true)
  assert.equal(v.shiftId, 'sh1')
  assert.deepEqual(v.customer, { id: 'c1', name: 'Иван' })
  assert.equal(v.user.name, 'kassir1')
  assert.equal(typeof enqueueSale, 'function')
})
