// ── Обновление программы на компьютере аптеки: база прежней версии под новой программой ──
//
// Установленная программа обновляется сама, а база на компьютере остаётся прежней.
// Здесь проверяется именно этот переход, без заглушек: ПРЕЖНЯЯ версия программы
// (её исходники из истории git) работает с настоящим сервером и оставляет на диске
// свою базу — с товарами, отметкой «докуда получили» и чеком, пробитым без связи.
// Затем ту же папку открывает НЫНЕШНЯЯ версия. Всё, что было, обязано остаться, чек —
// уйти на сервер, а новое (поставщики и сервисы перевода) — прийти при первом же обмене.
//
// Проверка пишет в настоящую аптеку — только в свою проверочную (не в рабочую!):
//   OLD_SRC=<папка desktop прежней версии> APP_USER=<логин владельца> APP_PASS=<пароль> \
//     node --test test-live/upgrade.live.mjs
// Папку прежней версии даёт git:  git worktree add <папка> <метка прежней версии>
// (и в её desktop нужен node_modules — ссылкой на нынешний).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from '../scripts/env.mjs'
import { fakeSeal, manualTimers, memorySession } from '../test-support/server.mjs'

const env = loadEnv()
const API = (env.API_URL || env.APTEKA_API_URL || '').replace(/\/$/, '')
const USER = env.APP_USER || ''
const PASS = env.APP_PASS || ''
const OLD = env.OLD_SRC ? resolve(env.OLD_SRC) : ''
// Нынешняя версия — та, в которой лежит эта проверка
const NEW = join(dirname(fileURLToPath(import.meta.url)), '..')
const skip = !(API && USER && PASS && OLD) && 'нужны OLD_SRC (папка desktop прежней версии), APP_USER и APP_PASS проверочной аптеки'

const TAG = 'UPG-' + Date.now().toString(36)
const from = (root, file) => import(pathToFileURL(join(root, file)).href)

// Касса одной из версий программы над общей папкой данных
async function kassa(root, dir) {
  const { createGateway } = await from(root, 'src/gateway.mjs')
  const { createClock } = await from(root, 'src/local/clock.mjs')
  const { openDb } = await from(root, 'src/local/db.mjs')
  const { CORE_SCHEMA } = await from(root, 'src/local/schema.mjs')
  const net = { online: true }
  const core = openDb(join(dir, 'core.db'), CORE_SCHEMA)
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: async (url, init) => {
      if (!net.online) throw new TypeError('нет связи')
      return fetch(url, init)
    },
    session: memorySession(),
    core,
    cipher: fakeSeal,
    clock: createClock({ mono: () => performance.now() }),
    dataDir: dir,
    appVersion: 'upgrade-test',
    timers: manualTimers(),
    emit: () => {},
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  return {
    gw,
    net,
    req,
    login: () => req('POST', '/auth/login', { name: USER, password: PASS }),
    meta: (key) => gw.pharmacyDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    close() {
      gw.close()
      core.close()
    },
  }
}

test('база прежней версии программы открывается новой: ничего не потеряно, поставщики и сервисы перевода приходят сами', { skip, timeout: 300_000 }, async (t) => {
  const token = (await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: USER, password: PASS }) })).json()).token
  assert.ok(token, 'вход на сервер не удался')
  const srv = async (method, path, body) => {
    const res = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const product = await srv('POST', '/products', { name: `${TAG} Нурофен`, barcode: `${TAG}-1`, category: 'Таблетки', minStock: 0, price: 150, cost: 100, stock: 10, expiryDate: '2028-01-31' })
  const expense = await srv('POST', '/expenses', { category: 'Аренда', amount: 77, note: TAG + ' до обновления' })
  const supplier = await srv('POST', '/suppliers', { name: `${TAG} Опт`, openingDebt: 0 })
  t.after(async () => {
    await srv('DELETE', '/products/' + product.id).catch(() => {})
    await srv('DELETE', '/expenses/' + expense.id).catch(() => {})
    await srv('DELETE', '/suppliers/' + supplier.id).catch(() => {})
  })
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-upgrade-'))

  // ── Прежняя версия: вход, первая загрузка, чек без связи — и программу закрыли ──
  const old = await kassa(OLD, dir)
  assert.equal((await old.login()).status, 201)
  await old.gw.syncNow()
  const deviceId = old.gw.deviceId
  assert.ok(old.meta('cursor') && old.meta('wcursor'), 'прежняя версия должна была запомнить, докуда получила данные')
  assert.equal(old.gw.pharmacyDb().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'suppliers'").get().n, 0, 'это и правда база прежней версии')
  // Поставщиков сервер уже отдаёт — прежняя версия их просто не замечает; расходы она знает
  assert.equal(old.gw.pharmacyDb().prepare("SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense' AND id = ?").get(expense.id).n, 1)
  old.net.online = false
  const sale = await old.req('POST', '/sales', { payment: 'cash', items: [{ productId: product.id, qty: 2 }] })
  assert.equal(sale.status, 201)
  assert.equal(old.gw.status().pending, 1)
  old.close()

  // ── Новая версия открывает ту же папку ──
  // Интернета всё ещё нет: вход — по отпечатку пароля, который сохранила прежняя версия
  const now = await kassa(NEW, dir)
  t.after(() => now.close())
  now.net.online = false
  assert.equal((await now.login()).status, 201, 'после обновления без интернета не войти')
  assert.equal(now.gw.deviceId, deviceId, 'касса осталась той же кассой')
  assert.equal(now.gw.pharmacyDb().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('suppliers', 'pay_services')").get().n, 2, 'база не доведена до новой версии')
  // Сделанное до обновления и не отправленное — на месте
  assert.equal(now.gw.status().pending, 1, 'чек, пробитый до обновления, потерялся')
  // Отметок «докуда получили» нет ни общей, ни владельца: первый обмен будет полным и
  // принесёт поставщиков и сервисы перевода, которые по прежней отметке не пришли бы никогда
  assert.equal(now.meta('cursor'), null)
  assert.equal(now.meta('wcursor'), null)
  assert.equal((await now.req('GET', '/products')).data.find((p) => p.id === product.id).stock, 8, 'остаток с учётом чека кассы')
  // Без связи и до первого обмена поставщиков и сервисов на кассе ещё нет — но разделы
  // уже отвечают, а не падают; расходы, полученные прежней версией, на месте
  assert.deepEqual((await now.req('GET', '/suppliers')).data, [])
  assert.deepEqual((await now.req('GET', '/pay-services')).data, [])
  assert.ok((await now.req('GET', '/expenses?days=180')).data.some((e) => e.id === expense.id), 'расход прежней версии пропал')

  // Интернет появился: вход через сервер, очередь уходит, владелец получает всё заново
  now.net.online = true
  assert.equal((await now.login()).status, 201)
  await now.gw.syncNow()
  await now.gw.syncNow()
  assert.deepEqual([now.gw.status().pending, now.gw.status().rejected], [0, 0])
  const onServer = (await srv('GET', '/sales')).filter((s) => s.id === sale.data.id)
  assert.equal(onServer.length, 1, 'чек дошёл до сервера ровно один раз')
  assert.equal((await srv('GET', '/products')).find((p) => p.id === product.id).stock, 8)

  // Статьи расходов и расход, внесённый до обновления программы, — на кассе
  const cats = (await now.req('GET', '/expense-categories')).data.map((c) => c.name)
  for (const name of ['Аренда', 'Зарплата', 'Другое']) assert.ok(cats.includes(name), `готовой статьи «${name}» на кассе нет`)
  assert.ok((await now.req('GET', '/expenses?days=180')).data.some((e) => e.id === expense.id), 'расход, внесённый до обновления, на кассу не пришёл')
  assert.ok(now.meta('wcursor'), 'разделы владельца получены — дальше только изменения')
  assert.ok(now.meta('cursor'), 'полный обмен прошёл — дальше только изменения')
  // Поставщики и сервисы перевода — на кассе
  assert.ok((await now.req('GET', '/suppliers')).data.some((s) => s.id === supplier.id), 'поставщик, заведённый до обновления, на кассу не пришёл')
  assert.ok((await now.req('GET', '/pay-services')).data.some((s) => s.name === 'Alif'), 'готовых сервисов перевода на кассе нет')

  // И новая версия работает как положено: расход без связи доходит до сервера
  now.net.online = false
  const spent = await now.req('POST', '/expenses', { category: 'Аренда', amount: 5, note: TAG + ' после обновления' })
  assert.equal(spent.status, 201)
  now.net.online = true
  await now.gw.syncNow()
  assert.ok((await srv('GET', '/expenses')).some((e) => e.id === spent.data.id), 'расход новой версии не дошёл до сервера')
  await srv('DELETE', '/expenses/' + spent.data.id)
})
