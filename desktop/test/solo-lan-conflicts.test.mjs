// ── Магазин без интернета: кассы по сети — одновременные правки, версии, копии (1.7.0) ──
//
// Третий круг проверки обмена главного и касс:
//   • часы кассы с главным не сверены — одновременность правок решает журнал главного, а не часы;
//   • спорные поля правки — как на главном, остальные поля кассы ложатся;
//   • занятый и освобождённый в одной пачке штрихкод — по порядку операций;
//   • поставщика с долгом касса не удалит; долг поставщика, заведённого на кассе, не теряется;
//   • разные версии программы не обмениваются: операции кассы ждут обновления, а не пропадают;
//   • при подключении заново не принятое главным — у владельца с тем, что в нём было;
//   • база главного сама поднялась из копии, снятой до первой кассы, — кассы подключаются заново;
//   • после подъёма из копии правки кассы и вернувшиеся с ней правки самого главного не затирают
//     того, что на главном поменяли после;
//   • касса молчала больше месяца (журнал главного убран) — её правки справочника не ложатся сами.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { getMeta, openDb, q } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { NOW } from '../test-support/pharmacy.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, listening, mainShop, pending, stockOf, swap } from '../test-support/solo-shop.mjs'

const HOUR = 3600000
const docsOf = (c, kind) => q(c.db(), 'SELECT COUNT(*) AS n FROM docs WHERE kind = ?').get(kind).n

// Касса со своими часами: shift — на сколько они отстают (минус) или спешат
async function skewedRegister(m, time, tag, shift) {
  const own = {
    get now() {
      return time.now + shift
    },
  }
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const r = computer(tag, { time: own, udpFind: m.lan.udpPort() })
  const res = await r.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  if (!res.ok) r.close()
  assert.equal(res.ok, true, JSON.stringify(res))
  return r
}

test('часы кассы отстают на час: её правка, сделанная после правки главного, — ложится', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const r1 = await skewedRegister(m, time, 'KASSA2', -HOUR)
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Главный ставит цену 20, касса это получает
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 20 })).status, 200)
  await swap(r1)
  // Через 10 минут касса (по её часам — на час раньше) ставит 25
  time.now += 10 * 60000
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 25 })).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(Number((await m.req('GET', '/products')).data.find((x) => x.id === p.id).price), 25, 'правка кассы — последняя, она и осталась')
  assert.equal((await m.req('GET', '/discrepancies')).data.length, 0)
})

test('часы кассы спешат на час: её удаление товара, по которому потом был приход на главном, — не проходит', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const extra = (await m.req('POST', '/products', { name: 'Сахар', barcode: '4600000000555', price: 9, cost: 6, stock: 10 })).data
  const r1 = await skewedRegister(m, time, 'KASSA2', HOUR)
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('DELETE', `/products/${extra.id}`)).status, 200)
  time.now += 10 * 60000
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  assert.equal((await m.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 60, items: [{ productId: extra.id, qty: 10, cost: 6 }] })).status, 201)
  await swap(r1)
  await swap(r1)
  assert.equal((await m.req('GET', '/products')).data.find((x) => x.id === extra.id)?.stock, 20, 'товар с приходом остался')
  assert.equal((await r1.req('GET', '/products')).data.find((x) => x.id === extra.id)?.stock, 20, 'и вернулся на кассу')
})

test('спорные поля — как на главном, остальные поля правки кассы ложатся', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Касса без связи: новое название, минимальный остаток и цена
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { name: 'Соль поваренная', minStock: 3, price: 7 })).status, 200)
  // Главный тем временем меняет только цену
  time.now += 10 * 60000
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 8 })).status, 200)
  await swap(r1)
  await swap(r1)
  const onMain = q(m.db(), 'SELECT name, minStock, priceC FROM products WHERE id = ?').get(p.id)
  assert.deepEqual(onMain, { name: 'Соль поваренная', minStock: 3, priceC: 800 })
  const onReg = q(r1.db(), 'SELECT name, minStock, priceC FROM products WHERE id = ?').get(p.id)
  assert.deepEqual(onReg, onMain, 'на кассе — как на главном')
  const edit = (await m.req('GET', '/discrepancies')).data.find((d) => d.kind === 'soloEdit')
  assert.deepEqual(JSON.parse(edit.note).fields.map((f) => f.field), ['priceC'])
})

test('штрихкод освободили и заняли в одной пачке — по порядку операций, без внутренних кодов', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const a = (await m.req('POST', '/products', { name: 'Старая карточка', barcode: '4600000000999', price: 5, cost: 3, stock: 0 })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('DELETE', `/products/${a.id}`)).status, 200)
  const b = (await r1.req('POST', '/products', { name: 'Новая карточка', barcode: '4600000000999', price: 6, cost: 4, stock: 0 })).data
  await swap(r1)
  await swap(r1)
  assert.equal(q(m.db(), 'SELECT barcode FROM products WHERE id = ?').get(b.id)?.barcode, '4600000000999')
  assert.equal(q(m.db(), 'SELECT COUNT(*) AS n FROM products WHERE id = ?').get(a.id).n, 0)
  assert.equal((await m.req('GET', '/discrepancies')).data.length, 0)
})

test('поставщика с долгом касса не удалит; долг поставщика, заведённого на кассе, не теряется', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Должник' })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Главный берёт товар в долг, касса (ещё не знает) удаляет поставщика
  assert.equal((await m.req('POST', '/arrivals', { supplierId: sup.id, debt: 30, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 10, cost: 3 }] })).status, 201)
  assert.equal((await r1.req('DELETE', `/suppliers/${sup.id}`)).status, 200)
  await swap(r1)
  await swap(r1)
  assert.ok(q(m.db(), 'SELECT 1 FROM suppliers WHERE id = ?').get(sup.id), 'поставщик с долгом остался')
  assert.ok(q(r1.db(), 'SELECT 1 FROM suppliers WHERE id = ?').get(sup.id), 'и на кассе вернулся')
  const disc = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'notTaken')
  assert.equal(JSON.parse(disc[0].note).error, 'У поставщика есть долг — сначала закройте его')
  // Кассир без права видеть деньги заводит поставщика и берёт у него в долг (кассир с правами прихода)
  const roleR = await m.req('POST', '/roles', { name: 'Приёмщик', permissions: ['arrivals.create', 'arrivals.debt', 'suppliers.edit'] })
  assert.equal(roleR.status, 201, JSON.stringify(roleR.data))
  const role = roleR.data
  const kassir = (await m.req('GET', '/users')).data.find((u) => u.name === KASSIR)
  assert.equal((await m.req('PATCH', `/users/${kassir.id}`, { roleId: role.id })).status, 200)
  await swap(r1)
  r1.gw.logout()
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  const s2 = (await r1.req('POST', '/suppliers', { name: 'Новый поставщик' })).data
  assert.equal((await r1.req('POST', '/arrivals', { supplierId: s2.id, debt: 40, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 4, cost: 10 }] })).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(q(m.db(), 'SELECT sDebtC FROM suppliers WHERE id = ?').get(s2.id).sDebtC, 4000, 'долг поставщика с кассы — у главного')
})

test('разные версии программы не обмениваются: операции кассы ждут и уходят после обновления', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  // Касса — другой версии
  const state = r1.gw.lanHub.state
  r1.gw.lanHub.state = () => ({ ...state(), version: 'другая' })
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'version')
  assert.equal(pending(r1), 2, 'операции ждут — ничего не отвергнуто')
  assert.equal(docsOf(m, 'sale'), 0)
  // Обновили
  r1.gw.lanHub.state = state
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(docsOf(m, 'sale'), 1)
})

test('при подключении заново не принятое главным — у владельца, с тем, что в нём было', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  // Закупщик делает приход на кассе без связи, а на главном его тем временем удаляют
  const roleR = await m.req('POST', '/roles', { name: 'Закупщик', permissions: ['arrivals.create', 'suppliers.edit', 'suppliers.view'] })
  assert.equal(roleR.status, 201, JSON.stringify(roleR.data))
  const role = roleR.data
  const boss = await m.req('POST', '/users', { name: 'zav', password: 'Zaveduyushiy-1', roleId: role.id })
  assert.equal(boss.status, 201, JSON.stringify(boss.data))
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  await swap(r1)
  assert.equal((await r1.login('zav', 'Zaveduyushiy-1')).status, 201)
  assert.equal((await r1.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 10, cost: 3 }] })).status, 201)
  assert.equal((await m.req('DELETE', `/users/${boss.data.id}`)).status, 200)
  assert.equal(m.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  const disc = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'notTaken')
  assert.equal(disc.length, 1, 'приход удалённого сотрудника без права — у владельца')
  assert.equal(disc[0].deviceName, re.name, 'с какой кассы — подписано и при подключении заново')
  const note = JSON.parse(disc[0].note)
  assert.equal(disc[0].opType, 'arrival')
  assert.equal(note.what.docs[0].kind, 'arrival')
  assert.equal(note.what.docs[0].items, 1)
})

test('база главного сама поднялась из копии, снятой до первой кассы: кассы подключаются заново и приносят своё', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  // Копия программы — до первой кассы
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-copy-'))
  m.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(m.dataDir, 'pharmacy-local.db'), join(dir, 'pharmacy-local.db'))
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  for (let i = 0; i < 3; i++) assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(docsOf(m, 'sale'), 3)
  m.gw.tick()
  // Файл базы главного испортился — программа поднимает его из той копии
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
  assert.ok(getMeta(m2.db(), 'shopId'), 'номер магазина — из общей базы программы')
  assert.equal(getMeta(m2.db(), 'shopId'), getMeta(r1.db(), 'shopId'))
  q(r1.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m.gw.deviceId)
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'epoch')
  assert.equal((await m2.login()).status, 201)
  const code = m2.gw.standalone.pairStart().code
  await listening(m2)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(docsOf(m2, 'sale'), 3)
  assert.equal(await stockOf(m2, p.id), 7)
})

test('главный поднялся из копии: правка кассы прежнего «поколения» не затирает то, что на главном поменяли после', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-copy-'))
  m.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(m.dataDir, 'pharmacy-local.db'), join(dir, 'pharmacy-local.db'))
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // После подключения кассы главный работает дальше, касса получает его журнал
  for (const price of [11, 12, 13, 14, 15]) assert.equal((await m.req('PATCH', `/products/${p.id}`, { price })).status, 200)
  await swap(r1)
  const seen = q(r1.db(), 'SELECT gotUpTo FROM lan_peers WHERE deviceId = ?').get(m.gw.deviceId).gotUpTo
  assert.ok(seen > JSON.parse(getMeta(m.core, 'soloMirror')).top, 'касса видела журнал дальше, чем записано в общей базе программы')
  // Касса без связи меняет цену
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 30 })).status, 200)
  // Файл базы главного испортился — поднят из копии; на главном цену меняют снова
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
  assert.equal((await m2.login()).status, 201)
  time.now += 10 * 60000
  assert.equal((await m2.req('PATCH', `/products/${p.id}`, { price: 40 })).status, 200)
  const editSeq = q(m2.db(), "SELECT MAX(l.seq) AS n FROM row_edits e JOIN lan_log l ON l.id = e.opId WHERE e.tbl = 'products' AND e.rowId = ?").get(p.id).n
  assert.ok(editSeq <= seen, 'номер правки на главном — из тех, что касса «видела» в прежнем поколении')
  // Касса подключается заново и приносит свою правку
  const code = m2.gw.standalone.pairStart().code
  await listening(m2)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(q(m2.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 4000, 'цена главного, поставленная после подъёма из копии, осталась')
  assert.equal(q(r1.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 4000, 'и на кассе — она')
  const edit = (await m2.req('GET', '/discrepancies')).data.find((d) => d.kind === 'soloEdit')
  assert.ok(edit, 'владелец видит, что правка кассы не легла')
  assert.deepEqual(JSON.parse(edit.note).fields, [{ field: 'priceC', kassa: 3000, main: 4000 }])
})

test('касса молчала больше месяца: её правки справочника — как на главном, владелец видит, что было на кассе', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const p2 = (await m.req('POST', '/products', { name: 'Перец', barcode: '4600000000777', price: 25, cost: 10, stock: 5 })).data
  const p3 = (await m.req('POST', '/products', { name: 'Лавровый лист', barcode: '4600000000888', price: 12, cost: 5, stock: 5 })).data
  const p4 = (await m.req('POST', '/products', { name: 'Корица', barcode: '4600000000666', price: 18, cost: 9, stock: 0 })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Касса без связи меняет цены трёх товаров (у третьего — ту же, что потом поставят на главном)
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 30 })).status, 200)
  assert.equal((await r1.req('PATCH', `/products/${p2.id}`, { price: 26 })).status, 200)
  assert.equal((await r1.req('PATCH', `/products/${p3.id}`, { price: 14 })).status, 200)
  assert.equal((await r1.req('DELETE', `/products/${p4.id}`)).status, 200)
  // Главный меняет цену первого и третьего; проходит 40 дней — журнал главного убран
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 20 })).status, 200)
  assert.equal((await m.req('PATCH', `/products/${p3.id}`, { price: 14 })).status, 200)
  time.now += 40 * 24 * HOUR
  assert.equal((await m.login()).status, 201)
  m.gw.tick()
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'gone')
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  const price = (id) => q(m.db(), 'SELECT priceC FROM products WHERE id = ?').get(id).priceC
  assert.deepEqual([price(p.id), price(p2.id), price(p3.id)], [2000, 2500, 1400], 'всё — как на главном')
  const old = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'soloOld')
  assert.deepEqual(
    old.map((d) => [d.productId, JSON.parse(d.note).fields]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      [p.id, [{ field: 'priceC', kassa: 3000, main: 2000 }]],
      [p2.id, [{ field: 'priceC', kassa: 2600, main: 2500 }]],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    'расходится — у владельца; совпало — нет',
  )
  assert.equal((await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'soloEdit').length, 0)
  // Удаление с такой кассы само не ложится — владелец решит
  assert.ok(q(m.db(), 'SELECT 1 FROM products WHERE id = ?').get(p4.id), 'товар не удалён')
  const nt = (await m.req('GET', '/discrepancies')).data.filter((d) => d.kind === 'notTaken')
  assert.equal(nt.length, 1)
  assert.match(JSON.parse(nt[0].note).error, /больше месяца не была на связи/)
})
