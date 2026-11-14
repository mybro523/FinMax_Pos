// ── Модули магазина (1.8.1) ──
//
// Владелец сервиса выбирает, какие разделы есть у клиента. Выключенный модуль закрыт целиком —
// и без интернета, и у владельца магазина: программа проверяет права сама (local/accounts.mjs,
// hasPerm). Магазин с сервером узнаёт модули из «кто я» сервера, магазин без интернета — из
// кода активации (у кассы — из кода главного).
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { MODULES as SITE_MODULES } from '../../client/src/lib/moduli.js'
import { cleanModulesOff, MODULES, modulesFromMask, modulesMask, offPerms } from '../src/local/moduli.mjs'
import { computerRawOf, readCode } from '../src/local/licence-code.mjs'
import { hasPerm, permissionsOf, saveAccount, userView } from '../src/local/accounts.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { createGateway } from '../src/gateway.mjs'
import { NOW, product } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'
import { dayOf, issueCode, todayDay } from '../test-support/licence-sign.mjs'
import { joinRegister, KASSIR, KASSIR_PASS, KEYS, mainShop, swap } from '../test-support/solo-shop.mjs'

const V = JSON.parse(fs.readFileSync(new URL('./licence-vectors.json', import.meta.url), 'utf8'))
const MACHINE = 'C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F'

test('список модулей программы — тот же, что у сайта (порядок — номера битов в коде)', () => {
  assert.deepEqual(MODULES, SITE_MODULES)
  assert.deepEqual(cleanModulesOff(['expiry', 'мусор', 'debts', 'expiry', 5]), ['debts', 'expiry'])
  assert.deepEqual(modulesFromMask(modulesMask(['obuchenie', 'dashboard'])), ['dashboard', 'obuchenie'])
  assert.equal(modulesMask([]), 0)
  // Право общее у двух модулей пропадает, только когда выключены оба
  assert.equal(offPerms(['salesReport']).has('reports.view'), false)
  assert.equal(offPerms(['salesReport', 'opu']).has('reports.view'), true)
  assert.deepEqual([...offPerms(['expiry'])], ['expiry.view'])
})

test('код активации: обычный (50 знаков) — все модули, с модулями (55 знаков) — выключенные из кода', () => {
  const pc = computerRawOf(MACHINE)
  const v1 = readCode(V.publicKey, pc, V.code)
  assert.equal(v1.ok, true)
  assert.deepEqual(v1.fields.modulesOff, [])
  // Образец сервера (server/test/licence-code.test.js — тот же файл образцов): выключены «Долги
  // клиентов», «Срок годности» и «Обучение»
  const v2 = readCode(V.publicKey, pc, V.codeModules)
  assert.equal(v2.ok, true, JSON.stringify(v2))
  assert.deepEqual(v2.fields, { kind: 'activate', until: dayOf('2027-11-01'), registers: 3, serial: 9, modulesOff: V.codeModulesOff })
  // Тот же расчёт, что у выпуска в проверках
  assert.equal(issueCode('2f6d0b9a8c7e5d4f3a2b1c0d9e8f7a6b', pc, { until: dayOf('2027-11-01'), registers: 3, serial: 9, modulesOff: V.codeModulesOff }), V.codeModules)
  // Без модулей — прежний короткий код (его читают и программы до 1.8.1)
  assert.equal(issueCode('2f6d0b9a8c7e5d4f3a2b1c0d9e8f7a6b', pc, { until: dayOf('2027-11-01'), registers: 2, serial: 7, modulesOff: [] }), V.code)
  // Порча и опечатка в длинном коде не проходят, чужой компьютер — тоже
  const plain = V.codeModules.replace(/-/g, '')
  for (const i of [0, 10, 30, 52, 54]) {
    const ch = plain[i] === 'A' ? 'B' : 'A'
    assert.equal(readCode(V.publicKey, pc, plain.slice(0, i) + ch + plain.slice(i + 1)).ok, false, 'знак ' + i)
  }
  assert.deepEqual(readCode(V.publicKey, pc, plain.slice(0, 54)), { ok: false, why: 'typo' })
  assert.deepEqual(readCode(V.publicKey, computerRawOf('другой'), V.codeModules), { ok: false, why: 'bad' })
})

test('права: выключенный модуль закрыт и у владельца; «кто я» называет выключенные модули', () => {
  const owner = { id: 'a', login: 'o', role: 'founder', pharmacyCode: 'x', permissions: '[]', modulesOff: '["expiry","debts"]' }
  assert.equal(hasPerm(owner, 'expiry.view'), false)
  assert.equal(hasPerm(owner, 'pos.debt'), false)
  assert.equal(hasPerm(owner, 'debts.pay', 'products.view'), true, 'любое из прав — второе живо')
  assert.equal(hasPerm(owner, 'writeoffs.create'), true)
  assert.deepEqual(userView(owner, NOW).modulesOff, ['debts', 'expiry'])
  const kassir = { ...owner, role: 'cashier', permissions: JSON.stringify(['pos.sell', 'pos.debt', 'returns.create']), modulesOff: ['debts'] }
  assert.deepEqual(permissionsOf(kassir), ['pos.sell', 'returns.create'])
  assert.equal(hasPerm(kassir, 'pos.debt'), false)
  assert.equal(hasPerm(kassir, 'returns.create'), true)
  // Запись без модулей (прежняя версия) и испорченная — всё включено
  assert.equal(hasPerm({ ...owner, modulesOff: '' }, 'expiry.view'), true)
  assert.equal(hasPerm({ ...owner, modulesOff: '{не json' }, 'expiry.view'), true)
  assert.deepEqual(userView({ ...owner, modulesOff: '' }, NOW).modulesOff, [])
})

test('модули — про весь магазин: слово сервера о них ложится всем его сотрудникам на этом компьютере', () => {
  const core = openDb(':memory:', CORE_SCHEMA)
  const sub = { status: 'active', paidUntil: '2027-01-01T00:00:00.000Z' }
  const u = (id, name, extra = {}) => ({ id, name, role: 'cashier', permissions: ['pos.sell'], pharmacy: { code: 'shop-1', name: 'Магазин' }, subscription: sub, ...extra })
  saveAccount(core, u('a1', 'one'), { now: NOW })
  saveAccount(core, u('a2', 'two', { modulesOff: ['expiry'] }), { now: NOW })
  const rows = () => core.prepare('SELECT login, modulesOff FROM accounts ORDER BY login').all()
  assert.deepEqual(rows(), [{ login: 'one', modulesOff: '["expiry"]' }, { login: 'two', modulesOff: '["expiry"]' }])
  // Сотрудник с соседней кассы (без слова сервера) — модули магазина; прежние у других не стёрты
  saveAccount(core, u('a3', 'three'), { now: NOW })
  saveAccount(core, u('a1', 'one'), { now: NOW })
  assert.deepEqual(rows().map((r) => r.modulesOff), ['["expiry"]', '["expiry"]', '["expiry"]'])
  // Сервер включил всё
  saveAccount(core, u('a2', 'two', { modulesOff: [] }), { now: NOW })
  assert.deepEqual(rows().map((r) => r.modulesOff), ['[]', '[]', '[]'])
  // Другой магазин на том же компьютере не задет
  saveAccount(core, { ...u('b1', 'other', { modulesOff: ['sklad'] }), pharmacy: { code: 'shop-2', name: 'Другой' } }, { now: NOW })
  assert.deepEqual(rows().find((r) => r.login === 'one').modulesOff, '[]')
})

// ── Магазин с сервером ──
function serverShop(modulesOff) {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('kassir', 'Parol-123', 'founder')
  srv.state.pharmacy.modulesOff = modulesOff
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  const core = openDb(':memory:', CORE_SCHEMA)
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-moduli-'))
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: srv.fetchImpl,
    session: memorySession(),
    core,
    cipher: fakeSeal,
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now, floor: () => time.now },
    dataDir,
    timers: manualTimers(),
    emit: () => {},
    log: { info() {}, warn() {}, error() {} },
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  return { gw, srv, core, req, login: () => req('POST', '/auth/login', { name: 'kassir', password: 'Parol-123' }) }
}

test('магазин с сервером: модули из «кто я» сервера; действие выключенного модуля закрыто и без интернета', async (tt) => {
  const t = serverShop(['writeoffs'])
  tt.after(() => t.gw.close())
  const r = await t.login()
  assert.equal(r.status, 201)
  assert.deepEqual(r.data.user.modulesOff, ['writeoffs'])
  await t.gw.syncNow()
  const no = await t.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(no.status, 403, 'владелец, модуль выключен')
  // Сервер включил модуль — «кто я» приносит новое, списание снова можно
  t.srv.state.pharmacy.modulesOff = []
  const me = await t.req('GET', '/auth/me')
  assert.deepEqual(me.data.modulesOff, [])
  assert.equal((await t.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })).status, 201)
  // Снова выключил — без интернета «кто я» отвечает по сохранённому
  t.srv.state.pharmacy.modulesOff = ['writeoffs', 'expiry']
  await t.req('GET', '/auth/me')
  t.srv.state.online = false
  const off = await t.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(off.status, 403)
  const row = t.core.prepare("SELECT modulesOff FROM accounts WHERE login = 'kassir'").get()
  assert.equal(row.modulesOff, '["writeoffs","expiry"]')
})

test('сервер прежней версии (модулей не называет) — всё включено', async (tt) => {
  const t = serverShop(undefined)
  tt.after(() => t.gw.close())
  const r = await t.login()
  assert.equal(r.status, 201)
  await t.gw.syncNow()
  assert.equal((await t.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: 'nur', units: 1 }] })).status, 201)
  // Без интернета «кто я» отвечает программа — всё включено
  t.srv.state.online = false
  assert.deepEqual((await t.req('GET', '/auth/me')).data.modulesOff, [])
})

// ── Магазин без интернета ──
test('магазин без интернета: модули из кода активации — на главном и на кассе; новый код меняет их сразу', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  // Пробный срок — всё включено
  assert.deepEqual((await m.req('GET', '/auth/me')).data.modulesOff, [])
  const { r } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r.close())
  const code = (modulesOff, serial) => issueCode(KEYS.privateKey, m.pc, { until: todayDay(time.now) + 365, registers: 3, serial, modulesOff })
  const ok = m.gw.standalone.activate(code(['writeoffs', 'debts'], 2))
  assert.equal(ok.ok, true, JSON.stringify(ok))
  const me = (await m.req('GET', '/auth/me')).data
  assert.deepEqual(me.modulesOff, ['debts', 'writeoffs'])
  assert.equal(me.subscription.canWrite, true)
  // Владелец: списание закрыто, продажа в долг — тоже; обычная продажа идёт
  assert.equal((await m.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: p.id, units: 1 }] })).status, 403)
  assert.equal((await m.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  // Касса получает код главного — и его модули
  await swap(r)
  assert.equal((await r.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.deepEqual((await r.req('GET', '/auth/me')).data.modulesOff, ['debts', 'writeoffs'])
  assert.equal(r.gw.status().activation.trial, false, 'касса — по коду главного')
  assert.equal(r.events.some((e) => e.type === 'changed' && e.payload.includes('roles')), true, 'окно кассы перечитает «кто я»')
  // Новый код — всё включено: сразу, без перезапуска
  assert.equal(m.gw.standalone.activate(code([], 3)).ok, true)
  assert.deepEqual((await m.req('GET', '/auth/me')).data.modulesOff, [])
  assert.equal((await m.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: p.id, units: 1 }] })).status, 201)
  await swap(r)
  assert.deepEqual((await r.req('GET', '/auth/me')).data.modulesOff, [])
})
