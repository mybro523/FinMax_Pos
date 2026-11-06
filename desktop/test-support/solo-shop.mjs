// ── Магазин без интернета: главный компьютер и кассы на этом компьютере (для проверок) ──
// Три настоящие программы (шлюз + обмен по сети) на 127.0.0.1; интернета нет — заглушка сети
// считает обращения. Общее для test/solo-lan*.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.mjs'
import { createLan } from '../src/lan.mjs'
import { openDb, q } from '../src/local/db.mjs'
import { computerCodeOf, computerRawOf } from '../src/local/licence-code.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { memorySession, manualTimers } from './server.mjs'
import { makeKeys } from './licence-sign.mjs'

export const KEYS = makeKeys()
export const OWNER = 'farrukh'
export const PASS = 'Parol-777'
export const KASSIR = 'kassir1'
export const KASSIR_PASS = 'Kassir-pass-1'
export const quiet = { info() {}, warn() {}, error() {} }
export const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc5ba0e0000000049454e44ae426082', 'hex').toString('base64')

// Шифрование Windows у каждого компьютера своё: отпечаток пароля, зашифрованный на одном, на
// другом не открыть — по сети он идёт ключом магазина
export const sealOf = (tag) => ({
  seal: (text) => tag + ':' + Buffer.from(text).toString('base64'),
  open: (stored) => {
    if (!String(stored).startsWith(tag + ':')) throw new Error('не расшифровалось')
    return Buffer.from(String(stored).slice(tag.length + 1), 'base64').toString()
  },
})

// Один компьютер магазина: шлюз программы и обмен по сети на свободных портах. Таймеры обмена
// пустые — обмениваться проверка велит сама (lan.now). Часы — общие для всех компьютеров
export function computer(tag, { time, udpFind = 0, core: coreDb, dataDir: dir, openFile = null, requireCode = false } = {}) {
  const core = coreDb || openDb(':memory:', CORE_SCHEMA)
  const events = []
  const errors = []
  const net = []
  const dataDir = dir || fs.mkdtempSync(join(os.tmpdir(), 'finmax-sololan-'))
  const machine = `${tag.toLowerCase().padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000001`
  const gw = createGateway({
    apiUrl: 'https://server.example/api',
    fetchImpl: async (url) => {
      net.push(String(url))
      throw new Error('сети нет')
    },
    session: memorySession(),
    core,
    cipher: sealOf(tag),
    clock: { now: () => time.now, serverTime: () => {}, lic: () => time.now, floor: () => time.now },
    dataDir,
    timers: manualTimers(),
    emit: (type, payload) => events.push({ type, payload }),
    log: { info() {}, warn() {}, error: (...a) => errors.push(a) },
    standalone: { publicKey: KEYS.publicKey, computerRaw: computerRawOf(machine), computerCode: computerCodeOf(machine), requireCode },
    offlineOnly: true,
    lanPorts: { udpPort: udpFind },
    // Открытие базы магазина — как у программы (починка из копии): проверки подменяют его
    ...(openFile ? { openFile } : {}),
  })
  const lan = createLan({
    hub: gw.lanHub,
    log: quiet,
    now: () => time.now,
    tcpPort: 0,
    udpPort: 0,
    bindAddress: '127.0.0.1',
    timers: { set: () => null, clear() {}, every: () => null, stop() {} },
  })
  gw.attachLan(lan)
  gw.listen(true)
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = (name = OWNER, password = PASS) => req('POST', '/auth/login', { name, password })
  const close = () => {
    lan.stop()
    gw.close()
  }
  return { gw, lan, core, events, errors, net, req, login, close, dataDir, db: () => gw.pharmacyDb(), tag, pc: computerRawOf(machine) }
}

// Сеть открыта: и порт обмена, и порт поиска (его открытие — после порта обмена)
export async function listening(c) {
  await c.lan.sync()
  for (let i = 0; i < 100 && !(c.lan.port() > 0 && c.lan.udpPort() > 0); i++) await new Promise((res) => setTimeout(res, 20))
}

// Обменяться с главным (и он — с кассой) прямо сейчас
export async function swap(c) {
  await c.lan.sync()
  await c.lan.now()
}

export async function stockOf(c, id) {
  const r = await c.req('GET', '/products')
  assert.ok(Array.isArray(r.data), `${c.tag}: ${r.status} ${JSON.stringify(r.data)}`)
  return r.data.find((p) => p.id === id)?.stock
}
export const pending = (c) => q(c.db(), "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n

// Главный: магазин, владелец, кассир, смена, товар
export async function mainShop(time, { requireCode = false } = {}) {
  const m = computer('MAIN', { time, requireCode })
  assert.equal((await m.gw.standalone.setupShop({ shopName: 'Магазин у дома', login: OWNER, password: PASS })).ok, true)
  assert.equal((await m.login()).status, 201)
  assert.equal((await m.req('POST', '/users', { name: KASSIR, password: KASSIR_PASS })).status, 201)
  assert.equal((await m.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const p = (await m.req('POST', '/products', { name: 'Соль', barcode: '4600000000401', price: 5, cost: 3, stock: 10 })).data
  return { m, p }
}

// Касса подключается к главному по коду: через поиск в сети или по адресу
export async function joinRegister(m, time, tag, { byAddress = false, requireCode = false } = {}) {
  const open = m.gw.standalone.pairStart()
  assert.equal(open.ok, true, JSON.stringify(open))
  assert.match(open.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  await listening(m)
  assert.ok(m.lan.port() > 0, 'главный слушает сеть, пока открыт код')
  const r = computer(tag, { time, udpFind: m.lan.udpPort(), requireCode })
  const info = r.gw.standalone.info()
  assert.equal(info.shop, false)
  assert.equal(info.role, '')
  const res = await r.gw.standalone.join({ code: open.code.toLowerCase(), address: byAddress ? `127.0.0.1:${m.lan.port()}` : '' })
  if (!res.ok) r.close()
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.shopName, 'Магазин у дома')
  // Код — на одну кассу: после подключения его нет
  assert.equal(m.gw.standalone.net().pairing, null)
  return { r, name: res.name }
}
