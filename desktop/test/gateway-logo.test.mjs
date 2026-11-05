// ── Логотип магазина у кассы (gateway.mjs, 1.6.4) ──
//
// Логотип ставит владелец сервиса. Касса печатает его на чеках и ленте и показывает на экране
// покупателя — и без интернета, поэтому последняя полученная картинка лежит в базе магазина.
// Окно спрашивает GET /shop/logo: есть связь — ответ сервера (он же в базу), нет связи или
// сервер прежней версии — то, что лежит. «Кто я» с сервера говорит «логотипа нет» — убирается
// и у кассы.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.mjs'
import { getMeta, openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { CATEGORIES, NOW, product } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'

const PASS = 'sekret-1'
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LOGO2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q=='

function setup() {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('kassir', PASS, 'founder')
  srv.state.data.categories = CATEGORIES
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  const core = openDb(':memory:', CORE_SCHEMA)
  const changes = []
  const events = []
  const session = memorySession()
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: srv.fetchImpl,
    session,
    emit: (type, payload) => events.push({ type, payload }),
    core,
    cipher: fakeSeal,
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now, floor: () => time.now },
    dataDir: fs.mkdtempSync(join(os.tmpdir(), 'apteka-logo-')),
    timers: manualTimers(),
    log: { info() {}, warn() {}, error() {} },
    onLogo: () => changes.push(gw.shopLogo()),
  })
  const req = (method, path) => gw.request({ method, path })
  return { gw, srv, req, changes, events, session }
}

async function loggedIn(t = setup()) {
  assert.equal((await t.gw.request({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: PASS } })).status, 201)
  await t.gw.syncNow()
  return t
}
const logoCalls = (t) => t.srv.state.calls.filter((c) => c.route === '/shop/logo').map((c) => c.path)
// Сверка в фоне (после «кто я» или входа) — дать ей закончиться
const settle = () => new Promise((r) => setTimeout(r, 30))
const stored = (t) => getMeta(t.gw.pharmacyFile().db, 'shopLogo')

test('логотип с сервера — окну и в базу кассы; основная часть программы видит его же', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  assert.equal(t.gw.shopLogo(), '', 'до первого ответа логотипа нет')
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  const r = await t.req('GET', '/shop/logo')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { logo: LOGO, at: '2026-11-01T15:00:00.000Z' })
  assert.equal(stored(t), LOGO)
  assert.equal(t.gw.shopLogo(), LOGO)
  assert.deepEqual(t.changes, [LOGO], 'экран покупателя узнал о новом логотипе один раз')
  // Тот же ответ ещё раз — ничего не меняется и никого не будит
  await t.req('GET', '/shop/logo')
  assert.equal(t.changes.length, 1)
})

test('без интернета — тот логотип, что лежит у кассы', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  t.srv.state.online = false
  const r = await t.req('GET', '/shop/logo')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { logo: LOGO, at: '2026-11-01T15:00:00.000Z' })
  assert.equal(t.gw.shopLogo(), LOGO)
})

test('логотип заменили и убрали: касса берёт новый, «кто я» без логотипа убирает его и у кассы', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  Object.assign(t.srv.state.pharmacy, { logo: LOGO2, logoAt: '2026-11-02T09:00:00.000Z' })
  assert.equal((await t.req('GET', '/shop/logo')).data.logo, LOGO2)
  assert.equal(t.gw.shopLogo(), LOGO2)
  // Владелец сервиса убрал логотип: «кто я» несёт logoAt: null
  Object.assign(t.srv.state.pharmacy, { logo: '', logoAt: null })
  assert.equal((await t.req('GET', '/auth/me')).status, 200)
  // «Логотипа нет» в «кто я» — повод свериться с сервером (он подтверждает), а не стереть вслепую
  await settle()
  assert.equal(t.gw.shopLogo(), '')
  assert.equal(stored(t), '')
  assert.deepEqual(t.changes, [LOGO, LOGO2, ''])
  // А без интернета логотипа нет и подавно
  t.srv.state.online = false
  assert.deepEqual((await t.req('GET', '/shop/logo')).data, { logo: '', at: null })
})

test('сервер прежней версии (адреса нет) и мусор вместо картинки — касса без логотипа и без ошибок', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.srv.state.pharmacy.logoRoute = false
  const old = await t.req('GET', '/shop/logo')
  assert.equal(old.status, 200)
  assert.deepEqual(old.data, { logo: '', at: null })
  // «Кто я» без отметки о логотипе (сервер прежней версии) ничего не стирает
  delete t.srv.state.pharmacy.logoRoute
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  delete t.srv.state.pharmacy.logoAt
  await t.req('GET', '/auth/me')
  assert.equal(t.gw.shopLogo(), LOGO)
  // Вместо картинки — ссылка или текст: как «логотипа нет»
  Object.assign(t.srv.state.pharmacy, { logo: 'javascript:alert(1)', logoAt: '2026-11-03T09:00:00.000Z' })
  assert.deepEqual((await t.req('GET', '/shop/logo')).data, { logo: '', at: null })
  assert.equal(t.gw.shopLogo(), '')
})

test('без входа логотипа нет', async (tt) => {
  const t = setup()
  tt.after(() => t.gw.close())
  assert.equal(t.gw.shopLogo(), '')
  assert.equal((await t.req('GET', '/shop/logo')).status, 401)
})

test('сверка по отметке: у сервера спрашиваем со своей отметкой — та же картинка не едет по сети, окно получает её целиком', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  assert.equal((await t.req('GET', '/shop/logo')).data.logo, LOGO)
  // Окно спрашивает ещё раз (и даже называет свою отметку) — касса спрашивает сервер со своей
  const again = await t.req('GET', '/shop/logo?at=' + encodeURIComponent('2026-11-01T15:00:00.000Z'))
  assert.deepEqual(again.data, { logo: LOGO, at: '2026-11-01T15:00:00.000Z' }, 'окну — картинка целиком (это не сеть)')
  assert.deepEqual(logoCalls(t), ['/shop/logo', '/shop/logo?at=2026-11-01T15%3A00%3A00.000Z'])
  assert.equal(t.changes.length, 1, 'та же картинка — экран покупателя не будили')
})

test('вход с интернетом, а логотип тем временем убрали: копия кассы стирается сразу, без похода окна за картинкой', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  assert.equal(t.gw.shopLogo(), LOGO)
  t.gw.logout()
  // Пока программа закрыта, владелец сервиса убрал логотип
  Object.assign(t.srv.state.pharmacy, { logo: '', logoAt: null })
  await loggedIn(t)
  await settle()
  assert.equal(t.gw.shopLogo(), '', 'лента и экран покупателя прежний логотип больше не печатают')
  assert.equal(t.changes.at(-1), '')
})

test('вместо сервера ответила страница входа в чужой Wi-Fi: логотип — из кассы, вход не сбрасывается', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  t.srv.state.override = (method, route) => (route === '/shop/logo' ? { status: 401, html: '<html><body>Войдите в Wi-Fi гостиницы</body></html>' } : null)
  const r = await t.req('GET', '/shop/logo')
  assert.equal(r.status, 200)
  assert.equal(r.data.logo, LOGO)
  assert.equal(t.gw.activeRole(), 'founder', 'вход на месте')
  assert.match(t.session.tokenOf('acc-kassir'), /^ключ-kassir-/, 'ключ входа не стёрт')
})

test('связь вернулась: логотип сменили, пока её не было, — касса забирает новый и говорит окну «магазин изменился»', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  t.gw.listen(true)
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  // Связь вернулась, логотип тот же — окно не трогаем
  t.events.length = 0
  t.gw.serverEvent('connect')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(t.events.some((e) => e.type === 'changed' && e.payload.includes?.('shop')), false)
  // А теперь логотип заменили, пока связи не было
  Object.assign(t.srv.state.pharmacy, { logo: LOGO2, logoAt: '2026-11-02T09:00:00.000Z' })
  t.gw.serverEvent('connect')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(t.gw.shopLogo(), LOGO2)
  assert.ok(t.events.some((e) => e.type === 'changed' && e.payload.includes?.('shop')), 'окну — «магазин изменился»')
})

test('ответы сервера пришли не по порядку: запоздавший прежний логотип не затирает новый', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  // Первый вопрос отвечает медленно и старой картинкой, второй — сразу и новой
  let first = true
  t.srv.state.override = async (method, route) => {
    if (route !== '/shop/logo') return null
    if (first) {
      first = false
      await new Promise((r) => setTimeout(r, 60))
      return { status: 200, body: { logo: LOGO, at: '2026-11-01T15:00:00.000Z' } }
    }
    return { status: 200, body: { logo: LOGO2, at: '2026-11-02T09:00:00.000Z' } }
  }
  const slow = t.req('GET', '/shop/logo')
  await new Promise((r) => setTimeout(r, 10))
  const fast = await t.req('GET', '/shop/logo')
  assert.equal(fast.data.logo, LOGO2)
  await slow
  assert.equal(t.gw.shopLogo(), LOGO2, 'старый ответ пришёл позже — не записан')
})

test('«кто я» отстал и говорит «логотипа нет», а сервер логотип держит — касса его не стирает', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  // «Кто я» — из памяти сервера до смены (logoAt: null), а сам логотип на сервере есть
  t.srv.state.pharmacy.logoAt = null
  t.srv.state.override = (method, route) => (route === '/shop/logo' ? { status: 200, body: { at: '2026-11-01T15:00:00.000Z', same: true } } : null)
  await t.req('GET', '/auth/me')
  await settle()
  assert.equal(t.gw.shopLogo(), LOGO, 'сверились с сервером — логотип на месте')
})

test('связь пропала (касса это уже знает): окно получает логотип из кассы сразу, сверка — в фоне', async (tt) => {
  const t = await loggedIn()
  tt.after(() => t.gw.close())
  Object.assign(t.srv.state.pharmacy, { logo: LOGO, logoAt: '2026-11-01T15:00:00.000Z' })
  await t.req('GET', '/shop/logo')
  t.srv.state.online = false
  await t.gw.syncNow().catch(() => {})
  // Сервер «висит»: ответ на сверку не придёт никогда — окно всё равно не ждёт
  t.srv.state.online = true
  t.srv.state.override = (method, route) => (route === '/shop/logo' ? new Promise(() => {}) : null)
  const r = await Promise.race([t.req('GET', '/shop/logo'), new Promise((res) => setTimeout(() => res('ждёт'), 500))])
  assert.notEqual(r, 'ждёт', 'окно ждало ответа сервера')
  assert.equal(r.data.logo, LOGO)
})
