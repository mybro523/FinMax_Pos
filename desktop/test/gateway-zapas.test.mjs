// ── Вход и запуск кассы при сбое адреса сервера (1.6.5) ──
//
// 04.11.2026 у регистратора домена отказали DNS: api.finmaxpos.tj перестал находиться. Касса
// 1.6.4 знала только этот адрес — каждый вход и запуск ждали 10–15 секунд, пока Windows
// перестанет его искать, а продажи на сервер не уходили. Здесь — целиком, от просьбы окна до
// ответа: вход идёт через запасной адрес, а если сервер молчит по обоим, касса пускает по
// сохранённому паролю сразу.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createBaseChooser } from '../src/apibase.mjs'
import { createGateway } from '../src/gateway.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { healthProbe } from '../src/net.mjs'
import { CATEGORIES, NOW, product } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'

const PASS = 'sekret-1'
// Запасной адрес — тот же сервер под другим именем
const SPARE = 'https://spare.example/api'

// Провода к серверу: у каждого адреса — «висит» (сбой DNS: имя ищется долго и не находится —
// здесь 3 секунды вместо настоящих десяти) или «отказ сразу»
function wires(srv) {
  const w = { main: '', spare: '', calls: [] }
  const hang = (init) =>
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new TypeError('net::ERR_NAME_NOT_RESOLVED')), 3000)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  w.fetchImpl = (url, init = {}) => {
    const spare = url.startsWith(SPARE)
    const path = url.slice((spare ? SPARE : API).length)
    w.calls.push((spare ? 'spare' : 'main') + path.split('?')[0])
    const state = spare ? w.spare : w.main
    if (state === 'hang') return hang(init)
    if (state === 'down') return Promise.reject(new TypeError('net::ERR_NAME_NOT_RESOLVED'))
    return srv.fetchImpl(API + path, init)
  }
  return w
}

function server() {
  const srv = fakeServer({ now: () => NOW })
  srv.addUser('kassir', PASS, 'founder')
  srv.state.data.categories = CATEGORIES
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  return srv
}

// Программа: свой выбор адреса на каждый запуск, база и ключи — общие между запусками
function start({ srv, wire, core, session, dataDir, probeMs = 300, pickWaitMs = 1000 }) {
  const chooser = createBaseChooser({ primary: API, fallback: SPARE, probe: healthProbe(wire.fetchImpl, probeMs) })
  const gw = createGateway({
    apiUrl: API,
    chooser,
    pickWaitMs,
    fetchImpl: wire.fetchImpl,
    session,
    core,
    cipher: fakeSeal,
    clock: { now: () => NOW, serverTime: () => {} },
    dataDir,
    timers: manualTimers(),
    log: { info() {}, warn() {}, error() {} },
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = () => req('POST', '/auth/login', { name: 'kassir', password: PASS })
  const stop = () => {
    chooser.stop()
    gw.close()
  }
  return { gw, chooser, req, login, stop, srv }
}

function machine() {
  const srv = server()
  return { srv, wire: wires(srv), core: openDb(':memory:', CORE_SCHEMA), session: memorySession(), dataDir: fs.mkdtempSync(join(os.tmpdir(), 'apteka-zapas-')) }
}

test('основной адрес «висит» (как 04.11) — вход идёт через запасной: быстро и с интернетом', async (tt) => {
  const m = machine()
  m.wire.main = 'hang'
  const p = start(m)
  tt.after(p.stop)
  const t0 = Date.now()
  const r = await p.login()
  const took = Date.now() - t0
  assert.equal(r.status, 201)
  assert.ok(took < 1500, 'вход ждал ' + took + ' мс')
  assert.match(m.session.get(), /^ключ-kassir-/, 'вход прошёл через сервер, а не по сохранённому паролю')
  assert.ok(m.wire.calls.includes('spare/auth/login'))
  assert.ok(!m.wire.calls.includes('main/auth/login'), 'на «висящий» адрес сам вход не ходил')

  // Обмен тоже идёт через запасной: товар с сервера лёг в кассу, продажа ушла на сервер
  await p.gw.syncNow()
  assert.ok(m.wire.calls.includes('spare/sync/pull'))
  const products = await p.req('GET', '/products')
  assert.deepEqual(products.data.map((x) => x.name), ['Нурофен'])
})

test('сервер молчит по обоим адресам — вход по сохранённому паролю сразу, без 10–15 секунд ожидания', async (tt) => {
  const m = machine()
  // Вчера касса работала с интернетом
  const first = start(m)
  assert.equal((await first.login()).status, 201)
  await first.gw.syncNow()
  first.gw.logout()
  first.stop()

  // Сегодня запуск — а сервер не находится ни по одному адресу (DNS «висит»)
  m.wire.main = 'hang'
  m.wire.spare = 'hang'
  const p = start({ ...m, probeMs: 2000, pickWaitMs: 150 })
  tt.after(p.stop)
  const t0 = Date.now()
  const r = await p.login()
  const took = Date.now() - t0
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.ok(took < 1000, 'вход ждал ' + took + ' мс — ожидание выбора адреса ограничено')

  // Выбор закончился: оба молчат. За ответом окну касса на сервер не ходит вовсе (обмен в фоне
  // пробует сам — вдруг связь просто медленная)
  await p.chooser.ready()
  assert.equal(p.chooser.reachable(), false)
  m.wire.calls.length = 0
  const t1 = Date.now()
  assert.equal((await p.req('GET', '/auth/me')).status, 200)
  assert.equal((await p.req('GET', '/products')).status, 200)
  assert.ok(Date.now() - t1 < 300)
  assert.deepEqual(m.wire.calls.filter((c) => !/\/sync\/|\/health/.test(c)), [], 'за ответом окну — ни одного запроса в сеть')
})

test('интернета нет вовсе (отказ сразу) — вход без связи тоже мгновенный', async (tt) => {
  const m = machine()
  const first = start(m)
  assert.equal((await first.login()).status, 201)
  await first.gw.syncNow()
  first.gw.logout()
  first.stop()

  m.wire.main = 'down'
  m.wire.spare = 'down'
  const p = start(m)
  tt.after(p.stop)
  const t0 = Date.now()
  assert.equal((await p.login()).status, 201)
  assert.ok(Date.now() - t0 < 500)
})

test('сервер молчит, а на этом компьютере под этим именем ещё не входили — честное «первый вход — с интернетом»', async (tt) => {
  const m = machine()
  m.wire.main = 'down'
  m.wire.spare = 'down'
  const p = start(m)
  tt.after(p.stop)
  const r = await p.login()
  assert.equal(r.status, 0)
  assert.match(r.data.message, /первый вход возможен только с интернетом/)
})
