// ── Магазин без интернета: кассы по сети — восстановление и споры правок (1.7.0) ──
//
// Второй круг проверки обмена главного и касс:
//   • касса, долго бывшая без связи, подключаясь заново, приносит главному своё ждущее любой давности;
//   • блокировка сотрудника на главном не отменяет сделанного им на кассе до блокировки;
//   • база главного сама поднялась из копии (файл испортился) — кассы узнают и подключаются заново;
//   • старая правка или удаление с кассы не перетирают то, что на главном сделали позже;
//   • один штрихкод, заведённый на кассе и на главном, — товар кассы с внутренним кодом и расхождение;
//   • документ, удалённый на главном, с подключением кассы заново не возвращается;
//   • главный загрузил копию без журнала обмена — заведённое на кассе после неё возвращается.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getMeta, openDb, q } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyRestore, requestRestore } from '../src/restore.mjs'
import { NOW, DAY } from '../test-support/pharmacy.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, listening, mainShop, pending, stockOf, swap } from '../test-support/solo-shop.mjs'

const HOUR = 3600000
const docsOf = (c, kind) => q(c.db(), 'SELECT COUNT(*) AS n FROM docs WHERE kind = ?').get(kind).n

async function kassirShift(r) {
  assert.equal((await r.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
}
// Касса подключается к главному заново (код — на главном)
async function rejoin(m, r) {
  const code = m.gw.standalone.pairStart().code
  assert.ok(code, 'главный открыл код')
  await listening(m)
  const re = await r.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
}
// Копия базы главного — как «Сохранить копию в…»
function copyOf(c) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-copy-'))
  c.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(c.dataDir, 'pharmacy-local.db'), join(dir, 'pharmacy-local.db'))
  return dir
}
// Главный загрузил копию (перезапуск программы)
async function restoreMain(m, time, dir) {
  m.close()
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-ud-'))
  requestRestore({ userData, fs, Database, folder: dir, shopFile: 'pharmacy-local.db', foreign: false, at: time.now, now: () => time.now })
  const done = applyRestore({ userData, dataDir: m.dataDir, fs, Database, now: () => time.now, schemaMax: PHARMACY_SCHEMA.length })
  assert.equal(done.ok, true, JSON.stringify(done))
  const m2 = computer('MAIN', { time, core: m.core, dataDir: m.dataDir })
  m2.gw.resume()
  await listening(m2)
  assert.equal((await m2.login()).status, 201)
  return m2
}

test('касса больше месяца без связи: подключаясь заново, она приносит главному всё ждущее', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })).status, 201)
  // Главный работает (его журнал для кассы копится)
  assert.equal((await m.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  // Сорок дней без связи; у кассы — уборка журнала каждый день
  for (let d = 0; d < 40; d++) {
    time.now += DAY
    r1.gw.tick()
    m.gw.tick()
  }
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  assert.equal(pending(r1), 3, 'смена и две продажи ждут главного')
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'gone')
  await rejoin(m, r1)
  assert.equal(docsOf(m, 'sale'), 3, 'и продажа сорокадневной давности — на главном')
  assert.equal(await stockOf(m, p.id), 6)
  assert.equal(await stockOf(r1, p.id), 6)
})

test('кассира заблокировали на главном — сделанное им на кассе до этого принимается', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  for (let i = 0; i < 3; i++) assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  // Главный блокирует кассира, пока касса без связи
  const kassir = (await m.req('GET', '/users')).data.find((u) => u.name === KASSIR)
  assert.equal((await m.req('PATCH', `/users/${kassir.id}`, { active: false })).status, 200)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(docsOf(m, 'sale'), 3)
  assert.equal(await stockOf(m, p.id), 7)
  assert.equal((await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'notTaken').length, 0)
})

test('база главного сама поднялась из копии (файл испортился) — кассы подключаются заново, ничего не теряется', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  await kassirShift(r1)
  await swap(r1)
  const dir = copyOf(m)
  for (let i = 0; i < 3; i++) assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(docsOf(m, 'sale'), 3)
  // Файл базы главного испортился — программа поднимает его из своей копии
  m.close()
  for (const ext of ['-wal', '-shm']) fs.rmSync(join(m.dataDir, 'pharmacy-local.db' + ext), { force: true })
  fs.copyFileSync(join(dir, 'pharmacy-local.db'), join(m.dataDir, 'pharmacy-local.db'))
  let first = true
  const m2 = computer('MAIN', {
    time,
    core: m.core,
    dataDir: m.dataDir,
    openFile: (file) => {
      const restored = first ? { at: time.now - HOUR } : null
      first = false
      return { db: openDb(file, PHARMACY_SCHEMA), restored }
    },
  })
  tt.after(() => m2.close())
  m2.gw.resume()
  await listening(m2)
  assert.equal(docsOf(m2, 'sale'), 0, 'в копии продаж нет')
  q(r1.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m.gw.deviceId)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'epoch', 'касса узнала, что база главного другая')
  assert.equal((await m2.login()).status, 201)
  await rejoin(m2, r1)
  assert.equal(docsOf(m2, 'sale'), 3)
  assert.equal(await stockOf(m2, p.id), 7)
})

test('старое удаление и старая цена с кассы не перетирают сделанное на главном позже', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const extra = (await m.req('POST', '/products', { name: 'Сахар', barcode: '4600000000555', price: 9, cost: 6, stock: 10 })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Касса без связи: в 10:00 удаляет «Сахар» и ставит «Соли» цену 15
  assert.equal((await r1.req('DELETE', `/products/${extra.id}`)).status, 200)
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 15 })).status, 200)
  // В 11:00 на главном: приход «Сахара» и цена «Соли» 20
  time.now += HOUR
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  assert.equal((await m.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 60, items: [{ productId: extra.id, qty: 10, cost: 6 }] })).status, 201)
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 20 })).status, 200)
  // В 12:00 касса на связи
  time.now += HOUR
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  const onMain = (await m.req('GET', '/products')).data
  assert.equal(onMain.find((x) => x.id === extra.id)?.stock, 20, 'товар с приходом не удалён')
  assert.equal(Number(onMain.find((x) => x.id === p.id)?.price), 20, 'осталась более поздняя цена')
  const onReg = (await r1.req('GET', '/products')).data
  assert.equal(onReg.find((x) => x.id === extra.id)?.stock, 20, 'и на кассе товар вернулся')
  assert.equal(Number(onReg.find((x) => x.id === p.id)?.price), 20)
  const disc = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'notTaken')
  assert.equal(disc.length, 2, 'владелец видит обе правки кассы, которые не легли')
})

test('один штрихкод на кассе и на главном — товар кассы получает внутренний код, владелец видит дубль', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  const onReg = (await r1.req('POST', '/products', { name: 'Мука (касса)', barcode: '4600000000777', price: 7, cost: 5, stock: 0 })).data
  assert.equal((await m.req('POST', '/products', { name: 'Мука', barcode: '4600000000777', price: 8, cost: 5, stock: 0 })).status, 201)
  await swap(r1)
  await swap(r1)
  const rows = q(m.db(), "SELECT id, barcode FROM products WHERE name LIKE 'Мука%' ORDER BY name").all()
  assert.equal(rows.length, 2)
  const fromReg = rows.find((x) => x.id === onReg.id)
  assert.match(fromReg.barcode, /^2\d{12}$/, 'товар кассы — с внутренним кодом')
  assert.equal(q(r1.db(), 'SELECT barcode FROM products WHERE id = ?').get(onReg.id).barcode, fromReg.barcode, 'и на кассе тоже')
  const disc = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'barcode')
  assert.equal(disc.length, 1)
  assert.equal(JSON.parse(disc[0].note).barcode, '4600000000777')
})

test('расход, удалённый на главном, при подключении кассы заново не возвращается', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await m.req('POST', '/expense-categories', { name: 'Хозяйство' })).status, 201)
  await swap(r1)
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const exp = await r1.req('POST', '/expenses', { amount: 50, category: 'Хозяйство', note: 'вода' })
  assert.equal(exp.status, 201, JSON.stringify(exp.data))
  await swap(r1)
  assert.equal(docsOf(m, 'expense'), 1)
  assert.equal((await m.req('DELETE', `/expenses/${exp.data.id}`)).status, 200)
  // Три недели: главный убрал журнал обмена, касса — ещё нет (уборка у каждого в своё время)
  time.now += 22 * DAY
  m.gw.tick()
  assert.equal(m.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  await rejoin(m, r1)
  assert.equal(q(m.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense' AND sync <> 'deleted'").get().n, 0, 'удалённый расход не вернулся')
})

test('главный загрузил копию, снятую до первой кассы: заведённое на кассе после неё возвращается', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  const dir = copyOf(m)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  const prod = (await r1.req('POST', '/products', { name: 'Чай', barcode: '4600000000888', price: 12, cost: 9, stock: 0 })).data
  const sup = (await r1.req('POST', '/suppliers', { name: 'Чайная лавка' })).data
  await swap(r1)
  assert.ok(q(m.db(), 'SELECT 1 FROM products WHERE id = ?').get(prod.id))
  time.now += HOUR
  const m2 = await restoreMain(m, time, dir)
  tt.after(() => m2.close())
  assert.equal(q(m2.db(), 'SELECT COUNT(*) AS n FROM products WHERE id = ?').get(prod.id).n, 0, 'в копии чая нет')
  // Номер магазина, ключ и кассы — с нынешней базы главного, «поколение» — новое: касса подключается заново
  q(r1.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m.gw.deviceId)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'epoch')
  await rejoin(m2, r1)
  assert.ok(q(m2.db(), 'SELECT 1 FROM products WHERE id = ?').get(prod.id), 'товар, заведённый на кассе, — на главном')
  assert.ok(q(m2.db(), 'SELECT 1 FROM suppliers WHERE id = ?').get(sup.id), 'и поставщик')
  assert.equal(getMeta(m2.db(), 'shopId'), getMeta(r1.db(), 'shopId'))
})
