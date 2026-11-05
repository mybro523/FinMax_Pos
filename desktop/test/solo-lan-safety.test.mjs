// ── Магазин без интернета: кассы по сети — что не должно ломаться (1.7.0) ──
//
// Случаи, найденные проверкой обмена главного компьютера и касс:
//   • партии кассы и главного не путаются (одинаковые номера), основа главного всегда ложится;
//   • операция кассы, которую главный принять не может, не останавливает приём остальных;
//   • главный загрузил копию базы (или его компьютер заменили, подняв копию кассы) — касса
//     подключается заново, и ничего из проданного на кассах не пропадает;
//   • касса не меняет сотрудников и чужие пароли; отключённая касса не говорит с главным и не
//     выдаёт себя за другую;
//   • пока касса подключается, сделанное в эту минуту не пропадает — записи нет вовсе;
//   • разные версии программы не подключаются; касса, молчавшая дольше месяца, подключается заново;
//   • большая основа (пересчёт всего склада) идёт частями.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MESSAGES } from '../src/gateway.mjs'
import { lanKeys, pairRequest, seal } from '../src/lan.mjs'
import { makeVerifier } from '../src/local/accounts.mjs'
import { getMeta, openDb, q } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { mainLogBase, pwToLan, regApplyBase } from '../src/local/solonet.mjs'
import { applyRestore, requestRestore } from '../src/restore.mjs'
import { NOW, DAY } from '../test-support/pharmacy.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, listening, mainShop, OWNER, PASS, pending, sealOf, stockOf, swap } from '../test-support/solo-shop.mjs'

const docsOf = (c, kind) => q(c.db(), 'SELECT COUNT(*) AS n FROM docs WHERE kind = ?').get(kind).n
const accountIdOf = (c, login) => q(c.core, 'SELECT id FROM accounts WHERE login = ?').get(login)?.id

// Касса открывает смену кассиром
async function kassirShift(r) {
  assert.equal((await r.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
}

test('партии: приход на кассе и на главном, пока они без связи, — основа главного ложится, остаток один', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  await swap(r1)
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  // Без связи: и касса, и главный принимают товар
  const a1 = await r1.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 9, items: [{ productId: p.id, qty: 3, cost: 3 }] })
  assert.equal(a1.status, 201, JSON.stringify(a1.data))
  const a2 = await m.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 15, items: [{ productId: p.id, qty: 5, cost: 3 }] })
  assert.equal(a2.status, 201, JSON.stringify(a2.data))
  // Номера партий кассы — со своей пометкой
  const tag = getMeta(r1.db(), 'batchTag')
  assert.ok(tag)
  assert.ok(q(r1.db(), 'SELECT 1 FROM batches WHERE id LIKE ?').get(`loc-${tag}-%`), 'партия кассы — со своей пометкой')
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0, 'основа главного легла — приход кассы принят')
  assert.equal(await stockOf(m, p.id), 18)
  assert.equal(await stockOf(r1, p.id), 18)
  assert.deepEqual([m.errors, r1.errors], [[], []])
})

test('операция кассы, которую главный принять не может, не останавливает приём: она — «не принято», остальное — принято', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  await swap(r1)
  await swap(r2)
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const arr = await r1.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 6, items: [{ productId: p.id, qty: 2, cost: 3 }] })
  assert.equal(arr.status, 201)
  assert.equal(await stockOf(r1, p.id), 12)
  // Запись испорчена по дороге (или прислана программой другой версии): главный её не примет
  const row = q(r1.db(), "SELECT id, body FROM lan_log WHERE kind = 'op' AND type = 'arrival'").get()
  const body = JSON.parse(row.body)
  body.effects.docs.find((d) => d.kind === 'arrival').body.supplierId = { x: 1 }
  q(r1.db(), 'UPDATE lan_log SET body = ? WHERE id = ?').run(JSON.stringify(body), row.id)
  await kassirShift(r2)
  assert.equal((await r2.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  await swap(r2)
  await swap(r1)
  // Продажа второй кассы принята, испорченный приход — нет
  assert.equal(pending(r2), 0)
  assert.equal(pending(r1), 0, 'касса узнала, что приход не принят')
  assert.equal(q(r1.db(), "SELECT state FROM outbox WHERE id = ?").get(row.id).state, 'rejected')
  assert.equal(r1.gw.status().rejected, 1, 'владелец видит его в «не принято»')
  assert.equal(await stockOf(m, p.id), 9)
  assert.equal(await stockOf(r1, p.id), 9, 'на кассе приход снят')
  assert.equal(await stockOf(r2, p.id), 9)
  const disc = (await m.req('GET', '/discrepancies')).data
  assert.equal(disc.length, 1)
  assert.equal(disc[0].kind, 'notTaken')
  assert.equal(disc[0].opType, 'arrival')
  assert.equal(disc[0].deviceName, 'Касса 2')
})

test('главный загрузил старую копию базы — касса подключается заново, и её продажи возвращаются на главный', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  await swap(r1)
  // Копия базы главного — до продаж
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-ud-'))
  const copyDir = join(userData, 'copy')
  fs.mkdirSync(copyDir)
  m.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(m.dataDir, 'pharmacy-local.db'), join(copyDir, 'pharmacy-local.db'))
  // Касса продаёт, главный принимает
  for (let i = 0; i < 3; i++) assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(docsOf(m, 'sale'), 3)
  // Главный загружает копию (как «Загрузить копию»: перезапуск программы)
  m.close()
  requestRestore({ userData, fs, Database, folder: copyDir, shopFile: 'pharmacy-local.db', foreign: false, at: NOW, now: () => time.now })
  const done = applyRestore({ userData, dataDir: m.dataDir, fs, Database, now: () => time.now, schemaMax: PHARMACY_SCHEMA.length })
  assert.equal(done.ok, true, JSON.stringify(done))
  const m2 = computer('MAIN', { time, core: m.core, dataDir: m.dataDir })
  tt.after(() => m2.close())
  m2.gw.resume()
  await listening(m2)
  assert.equal(docsOf(m2, 'sale'), 0, 'в копии продаж нет')
  // Касса узнаёт, что у главного другая база
  q(r1.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m.gw.deviceId)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'epoch')
  // Подключается заново — продажи переходят на главный
  assert.equal((await m2.login()).status, 201)
  const code = m2.gw.standalone.pairStart().code
  await listening(m2)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(docsOf(m2, 'sale'), 3, 'продажи кассы вернулись на главный')
  assert.equal(await stockOf(m2, p.id), 7)
  assert.equal(docsOf(r1, 'sale'), 3)
  assert.equal(await stockOf(r1, p.id), 7)
  // Прежняя база кассы не стёрта — лежит в стороне
  assert.ok(fs.readdirSync(join(r1.dataDir, 'replaced')).length >= 1)
  assert.deepEqual([m2.net, r1.net], [[], []])
})

test('главный сломался — его заменили, подняв копию кассы: новый главный со своим номером, касса подключается к нему', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  await kassirShift(r1)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })).status, 201)
  await swap(r1)
  await swap(r2)
  // Главный «сломался». Копия второй кассы — на новый компьютер
  m.close()
  const copyDir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-regcopy-'))
  r2.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(r2.dataDir, 'pharmacy-local.db'), join(copyDir, 'pharmacy-local.db'))
  fs.writeFileSync(join(copyDir, 'core.db'), r2.core.serialize())
  const nm = computer('NEWMAIN', { time })
  tt.after(() => nm.close())
  assert.equal((await nm.gw.standalone.setupShop({ shopName: 'Временный', login: OWNER, password: PASS })).ok, true)
  const nmId = nm.gw.deviceId
  nm.close()
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-ud2-'))
  requestRestore({ userData, fs, Database, folder: copyDir, shopFile: 'pharmacy-local.db', foreign: true, at: NOW, now: () => time.now })
  const done = applyRestore({ userData, dataDir: nm.dataDir, fs, Database, now: () => time.now, schemaMax: PHARMACY_SCHEMA.length })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.foreign, false, 'номер кассы новый главный не взял')
  const nm2 = computer('NEWMAIN', { time, core: nm.core, dataDir: nm.dataDir })
  tt.after(() => nm2.close())
  assert.equal(nm2.gw.deviceId, nmId)
  nm2.gw.resume()
  assert.equal(nm2.gw.standalone.info().role, '', 'новый компьютер — главный, не касса')
  // Владелец входит паролем, заданным здесь (его вход переходит к владельцу из копии)
  assert.equal((await nm2.login(OWNER, PASS)).status, 201)
  assert.equal(docsOf(nm2, 'sale'), 1, 'продажа первой кассы — в копии второй')
  // Первая касса подключается к новому главному
  const code = nm2.gw.standalone.pairStart().code
  await listening(nm2)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${nm2.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(await stockOf(nm2, p.id), 8)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, '')
})

test('касса не меняет сотрудников и пароли и не проводит то, на что у сотрудника нет права, — даже подделав запись', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const ownerId = accountIdOf(m, OWNER)
  const kassirId = accountIdOf(m, KASSIR)
  const key = sealOf('KASSA2').open(getMeta(r1.db(), 'lanKey'))
  const forged = async (id, type, rows) => {
    q(
      r1.db(),
      `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
       VALUES (?, 'op', ?, NULL, ?, ?, ?, ?, 1, 0, 'own')`,
    ).run(id, r1.gw.deviceId, type, kassirId, new Date(time.now).toISOString(), JSON.stringify({ effects: { docs: [], moves: [], debts: [], edits: { rows, adj: [] } } }))
  }
  const evil = pwToLan(key, await makeVerifier('Vzlom-pass-1'))
  // Пароль владельца — от имени кассира
  await forged('forge-1', 'user.update', [{ tbl: 'team_accounts', rowId: ownerId, action: 'put', data: { set: {}, was: {}, pwChanged: true, pwLan: evil } }])
  // Кассир делает себя владельцем
  await forged('forge-2', 'user.update', [{ tbl: 'team_accounts', rowId: kassirId, action: 'put', data: { set: { role: 'founder' }, was: { role: 'cashier' } } }])
  // Новая роль
  await forged('forge-3', 'role.create', [{ tbl: 'team_roles', rowId: 'r-evil', action: 'put', data: { row: { name: 'Всё', permissions: '[]' } } }])
  // «Переименовать во всех строках»: всех кассиров — во владельцев
  await forged('forge-4', 'user.update', [{ tbl: 'team_accounts', rowId: kassirId, action: 'map', data: { pwChanged: true, col: 'role', from: 'cashier', to: 'founder' } }])
  // Назвалась владельцем — и меняет «свой» пароль
  q(
    r1.db(),
    `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES ('forge-5', 'op', ?, NULL, 'user.update', ?, ?, ?, 1, 0, 'own')`,
  ).run(r1.gw.deviceId, ownerId, new Date(time.now).toISOString(), JSON.stringify({ effects: { docs: [], moves: [], debts: [], edits: { rows: [{ tbl: 'team_accounts', rowId: ownerId, action: 'put', data: { set: {}, was: {}, pwChanged: true, pwLan: evil } }], adj: [] } } }))
  // Расход от имени кассира, у которого нет права на расходы
  const exp = { id: 'exp-evil', amount: 500, date: new Date(time.now).toISOString(), category: 'Прочее', note: '' }
  q(
    r1.db(),
    `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES ('forge-6', 'op', ?, NULL, 'expense', ?, ?, ?, 1, 0, 'own')`,
  ).run(r1.gw.deviceId, kassirId, new Date(time.now).toISOString(), JSON.stringify({ effects: { docs: [{ kind: 'expense', body: exp }], moves: [], debts: [] } }))
  // Продажа, к которой приложена правка цены товара
  q(
    r1.db(),
    `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES ('forge-7', 'op', ?, NULL, 'sale', ?, ?, ?, 1, 0, 'own')`,
  ).run(r1.gw.deviceId, kassirId, new Date(time.now).toISOString(), JSON.stringify({ effects: { docs: [], moves: [], debts: [], prices: [['nope', 1]] } }))
  await swap(r1)
  m.gw.logout()
  assert.equal((await m.login(OWNER, 'Vzlom-pass-1')).status, 401, 'пароль владельца не сменился')
  assert.equal((await m.login(OWNER, PASS)).status, 201)
  assert.equal(q(m.core, 'SELECT role FROM accounts WHERE id = ?').get(kassirId).role, 'cashier')
  assert.equal(q(m.db(), "SELECT COUNT(*) AS n FROM team_roles WHERE id = 'r-evil'").get().n, 0)
  assert.equal(q(m.db(), "SELECT COUNT(*) AS n FROM team_accounts WHERE role = 'founder'").get().n, 1, 'владелец один')
  assert.equal(q(m.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense'").get().n, 0, 'расход без права не лёг')
  const disc = (await m.req('GET', '/discrepancies')).data
  assert.equal(disc.filter((d) => d.kind === 'notTaken').length, 7)
  // Свой пароль на кассе не меняют вовсе
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r1.req('POST', '/auth/change-password', { oldPassword: KASSIR_PASS, newPassword: 'Novyi-pass-7' })).status, 403)
})

test('отключённая касса с главным больше не говорит и за другую кассу себя не выдаст', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  assert.equal(m.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  // Ключ отключённой кассы, сообщение — от имени второй кассы
  const k1 = sealOf('KASSA2').open(getMeta(r1.db(), 'lanRegKey'))
  const post = (id, key) =>
    new Promise((resolve) => {
      const idBuf = Buffer.from(id)
      const msg = { v: 1, t: 'x', from: id, name: '', wide: true, port: 0, ts: time.now, ack: 0, entries: [], upTo: 0 }
      const body = Buffer.concat([Buffer.from('FMXK'), Buffer.from([idBuf.length]), idBuf, seal(lanKeys(key).enc, msg)])
      const rq = http.request({ host: '127.0.0.1', port: m.lan.port(), path: '/lan/v1/x', method: 'POST', headers: { 'Content-Length': body.length } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      rq.on('error', () => resolve(0))
      rq.end(body)
    })
  assert.equal(await post(r1.gw.deviceId, k1), 423, 'своим номером — отключена')
  assert.equal(await post(r2.gw.deviceId, k1), 403, 'номером второй кассы — ключ не её')
  // Вторая касса работает как работала
  await swap(r2)
  assert.equal(r2.gw.standalone.net().main.error, '')
})

test('пока касса подключается заново, записать ничего нельзя — сделанное не пропадёт с заменой базы', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const joining = r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  const sale = await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })
  assert.equal(sale.status, 409)
  assert.equal(sale.data.message, MESSAGES.pairBusy)
  assert.equal((await joining).ok, true)
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
})

test('разные версии программы не подключаются: код не тратится, касса у главного не появляется', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const r = await pairRequest({ code, address: `127.0.0.1:${m.lan.port()}`, deviceId: 'kassa-staraya', schema: PHARMACY_SCHEMA.length - 1 })
  assert.equal(r.error, 'version')
  assert.ok(m.gw.standalone.net().pairing, 'код ещё действует')
  assert.equal(m.gw.standalone.net().registers.length, 0)
})

test('касса молчала дольше месяца, журнал главного убран — ей подключиться заново, сделанное на ней не пропадает', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  // Главный продаёт, касса выключена (не обменивается)
  for (let i = 0; i < 2; i++) assert.equal((await m.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  time.now += 40 * DAY
  m.gw.tick()
  // Касса включилась: у неё своя продажа, главный журнала для неё не держит
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'gone')
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(docsOf(m, 'sale'), 3, 'продажа кассы — на главном')
  assert.equal(await stockOf(r1, p.id), 7)
})

test('основа, которая не легла, не пропускается: касса ждёт и говорит «подключите заново»', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await swap(r1)
  const before = q(r1.db(), 'SELECT gotUpTo FROM lan_peers').get().gotUpTo
  // Основа, которую касса положить не может (строка товара без названия)
  const acc = Number(getMeta(m.db(), 'soloAcc') || 0) + 1
  q(
    m.db(),
    `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES (?, 'base', ?, NULL, '', NULL, ?, ?, 1, 0, 'own')`,
  ).run('base:' + acc, m.gw.deviceId, new Date(time.now).toISOString(), JSON.stringify({ acc, ops: [], rows: { products: [{ id: 'bad', name: null, barcode: null, createdAt: null }] } }))
  q(m.db(), "UPDATE meta SET value = ? WHERE key = 'soloAcc'").run(String(acc))
  await swap(r1)
  assert.equal(q(r1.db(), 'SELECT gotUpTo FROM lan_peers').get().gotUpTo, before, 'отметка «получено» не сдвинулась')
  assert.equal(r1.gw.standalone.net().main.error, 'base')
})

test('большая основа (пересчёт всего склада) идёт частями: операции названы в последней, касса кладёт все', () => {
  const db = openDb(':memory:', PHARMACY_SCHEMA)
  const reg = openDb(':memory:', PHARMACY_SCHEMA)
  const now = NOW
  const at = new Date(now).toISOString()
  for (const d of [db, reg]) {
    const putP = d.prepare('INSERT INTO products (id, name, barcode, createdAt, sCostC, costC) VALUES (?, ?, ?, ?, 300, 300)')
    for (let i = 0; i < 1700; i++) putP.run('p' + i, 'Товар ' + i, String(4600000000000 + i), at)
  }
  const putB = db.prepare('INSERT INTO batches (id, productId, units, sUnits, costC, createdAt) VALUES (?, ?, ?, ?, 300, ?)')
  const putM = db.prepare("INSERT INTO stock_moves (opId, productId, kind, units, createdAt, synced) VALUES ('op-big', ?, 'count', 5, ?, 1)")
  for (let i = 0; i < 1700; i++) {
    putB.run('b' + i, 'p' + i, 5, 5, at)
    // Пустые партии истории — в основу не идут
    putB.run('e' + i, 'p' + i, 0, 0, at)
    putM.run('p' + i, at)
  }
  const acc = mainLogBase(db, { ops: [{ id: 'op-big', type: 'inventory.apply', docs: [] }], deviceId: 'main', now })
  const bases = q(db, "SELECT * FROM lan_log WHERE kind = 'base' ORDER BY seq").all()
  assert.equal(bases.length, 3)
  assert.equal(acc, 3)
  for (const b of bases) assert.ok(b.body.length < 1_000_000, 'часть основы небольшая')
  const bodies = bases.map((b) => JSON.parse(b.body))
  assert.deepEqual(bodies.map((b) => b.ops.length), [0, 0, 1])
  assert.ok(bodies.every((b) => b.batches.every((x) => x.sUnits > 0)))
  for (const b of bases) regApplyBase(reg, { body: b.body })
  assert.equal(q(reg, 'SELECT COUNT(*) AS n FROM batches').get().n, 1700)
  assert.equal(q(reg, 'SELECT SUM(units) AS n FROM batches').get().n, 8500)
})
