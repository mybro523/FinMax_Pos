// ── Обмен кассами по местной сети глазами основной части программы ──
//
// Ключ магазина приходит от сервера при обмене — с ним обмен по сети включается, если
// у магазина больше одной кассы. Каждая записанная операция тут же попадает в журнал
// для соседей; операция соседа ложится в базу и видна окну. Адрес вручную вписывает
// только тот, кому можно настраивать кассы.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, NOW, PAY_SERVICES, product, SUPPLIERS } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'

const PASS = 'sekret-1'
const KEY = 'k'.repeat(43)

async function shop({ role = 'founder', permissions, lan = { key: KEY, devices: 2 } } = {}) {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('kassir', PASS, role, undefined, permissions ? { permissions } : {})
  srv.state.data.categories = CATEGORIES
  srv.state.data.expenseCategories = EXPENSE_CATEGORIES
  srv.state.data.incomeCategories = INCOME_CATEGORIES
  srv.state.data.suppliers = SUPPLIERS.map((s) => ({ ...s }))
  srv.state.data.payServices = PAY_SERVICES
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  srv.state.lan = lan
  const core = openDb(':memory:', CORE_SCHEMA)
  const events = []
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: srv.fetchImpl,
    session: memorySession(),
    core,
    cipher: fakeSeal,
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now, floor: () => time.now },
    dataDir: fs.mkdtempSync(join(os.tmpdir(), 'apteka-lan-')),
    timers: manualTimers(),
    emit: (type, payload) => events.push({ type, payload }),
    log: { info() {}, warn() {}, error() {} },
  })
  const net = { kicks: 0, syncs: 0, kick() { this.kicks++ }, async sync() { this.syncs++ }, async now() { return [] }, status: () => ({ enabled: true, peers: [], manual: [] }) }
  gw.attachLan(net)
  const req = (method, path, body) => gw.request({ method, path, body })
  const r = await req('POST', '/auth/login', { name: 'kassir', password: PASS })
  assert.equal(r.status, 201)
  await gw.syncNow()
  // Без открытой смены касса не продаёт — открываем сразу, пока есть связь
  assert.equal((await req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  await gw.syncNow()
  // Журнал обмена к началу работы: смена и «сервер принял» уже в нём — соседям
  // проверки отдают то, что касса запишет дальше
  const lanFrom = gw.lanHub.entriesFor(0, true).upTo
  return { gw, srv, net, events, req, time, lanFrom }
}

test('ключ магазина приходит с сервера и включает обмен при двух кассах', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const st = t.gw.lanHub.state()
  assert.equal(st.enabled, true)
  assert.equal(st.key, KEY)
  assert.equal(st.name, 'Касса 1')
  // За кассой владелец — соседи отдают сюда и деньги магазина
  assert.equal(st.wide, true)
  assert.ok(t.net.syncs >= 1, 'сеть должна узнать, что пришёл ключ')
})

test('касса одна — сеть не открывается (и Windows ни о чём не спросит)', async (tt) => {
  const t = await shop({ lan: { key: KEY, devices: 1 } })
  tt.after(() => t.gw.close())
  assert.equal(t.gw.lanHub.state().enabled, false)
})

test('записанная продажа сразу уходит в журнал для соседей', async (tt) => {
  const t = await shop()
  tt.after(() => t.gw.close())
  const before = t.net.kicks
  const sale = await t.req('POST', '/sales', { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  assert.equal(sale.status, 201)
  assert.ok(t.net.kicks > before, 'соседям надо передать сразу')
  const out = t.gw.lanHub.entriesFor(t.lanFrom, true)
  assert.equal(out.entries.length, 1)
  assert.equal(out.entries[0].type, 'sale')
  assert.equal(out.entries[0].id.length > 10, true)
})

test('операция соседа ложится в базу, окно узнаёт об этом', async (tt) => {
  const a = await shop()
  const b = await shop()
  tt.after(() => {
    a.gw.close()
    b.gw.close()
  })
  await a.req('POST', '/sales', { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
  const out = a.gw.lanHub.entriesFor(a.lanFrom, true)
  // Окно программы слушает события (после входа так и есть)
  b.gw.listen(true)
  b.events.length = 0
  b.gw.lanHub.receive('kassa-A', out.entries)
  assert.ok(b.events.some((e) => e.type === 'changed' && e.payload.includes('sales')))
  const sales = await b.req('GET', '/sales')
  assert.equal(sales.data.length, 1)
  const products = await b.req('GET', '/products')
  assert.equal(products.data.find((p) => p.id === 'nur').stock, 3)
  // Чужая операция не встала в очередь этой кассы: отправит её своя касса
  assert.equal(b.gw.status().pending, 0)
  assert.equal(b.gw.lanStatus().fromPeers, 1)
})

test('адрес соседа вручную: только с правом на кассы и только похожий на адрес', async (tt) => {
  const owner = await shop()
  tt.after(() => owner.gw.close())
  assert.deepEqual(await owner.gw.lanAdd('это не адрес'), { ok: false, error: 'address' })
  assert.deepEqual(await owner.gw.lanAdd('192.168.1.10'), { ok: true })
  assert.equal(owner.gw.lanHub.manual()[0], '192.168.1.10')
  assert.equal(await owner.gw.lanRemove('192.168.1.10'), true)

  const kassir = await shop({ role: 'cashier', permissions: ['pos.sell', 'shift.open'] })
  tt.after(() => kassir.gw.close())
  assert.deepEqual(await kassir.gw.lanAdd('192.168.1.10'), { ok: false, error: 'rights' })
})
