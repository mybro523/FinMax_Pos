// ── Магазин без интернета: кассы по сети — правки, сделанные одновременно (1.7.0, четвёртый круг) ──
//
// Поле, которое на главном (или на другой кассе) поменяли позже того, что касса видела, остаётся
// как на главном; владелец видит в «Расхождениях», что было на кассе. Здесь — случаи, которые
// нашёл четвёртый круг проверки:
//   • закупочная цена: не легла правка — не ложится и её движение «закупочная из карточки»;
//   • приход с новой упаковкой при споре — целиком владельцу (его партии посчитаны в ней);
//   • правки главного, сделанные, пока к нему не подключена ни одна касса, — тоже «позже»;
//   • цены из прихода (списки prices/pieces/packs) — так же, как правка карточки, в обе стороны;
//   • переименование категории: не легло название — товары не переезжают, касса возвращается к главному;
//   • операция самого главного, вернувшаяся с кассой после подъёма из копии, — штрихкод проверяется;
//   • подъём из копии и две кассы: правка, сделанная кассой после того, как она видела правку
//     главного, остаётся, в каком бы порядке кассы ни подключались заново;
//   • поставщика с долгом не удалить, даже если и приход в долг, и удаление пришли одной пачкой;
//   • поправки главного (расхождения, строки для касс) — в самой записи журнала; присланное кассой
//     под этим именем не в счёт.
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
import { NOW } from '../test-support/pharmacy.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, listening, mainShop, OWNER, PASS, pending, swap } from '../test-support/solo-shop.mjs'

const HOUR = 3600000
const MIN10 = 10 * 60000
const discs = async (m, kind) => (await m.req('GET', '/discrepancies')).data.filter((d) => !kind || d.kind === kind)
const fieldsOf = (d) => JSON.parse(d.note).fields

// Главный «ломается» и сам поднимается из копии, снятой до первой кассы
function copyNow(m) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-trim-'))
  m.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(m.dataDir, 'pharmacy-local.db'), join(dir, 'pharmacy-local.db'))
  return dir
}
async function restoredMain(m, dir, time, tt) {
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
  return m2
}
async function rejoin(m, r) {
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const re = await r.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  return re
}

test('закупочная цена: правка кассы не легла — не ложится и её движение; владельцу — одной строкой', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { cost: 4 })).status, 200)
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { cost: 6 })).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.deepEqual(q(m.db(), 'SELECT costC, sCostC FROM products WHERE id = ?').get(p.id), { costC: 600, sCostC: 600 })
  assert.deepEqual(q(r1.db(), 'SELECT costC, sCostC FROM products WHERE id = ?').get(p.id), { costC: 600, sCostC: 600 }, 'и на кассе')
  const [d] = await discs(m, 'soloEdit')
  assert.deepEqual(fieldsOf(d), [{ field: 'sCostC', kassa: 400, main: 600 }])
})

test('приход с новой упаковкой, а цену на главном поменяли позже: приход целиком — владельцу (партии посчитаны в той упаковке)', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  await swap(r1)
  const a = await r1.req('POST', '/arrivals', {
    supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 0,
    items: [{ productId: p.id, qty: 2, cost: 30, unitsPerPack: 10, packChanged: true, packScale: true }],
  })
  assert.equal(a.status, 201, JSON.stringify(a.data))
  assert.equal(q(r1.db(), 'SELECT unitsPerPack FROM products WHERE id = ?').get(p.id).unitsPerPack, 10, 'на кассе упаковка сменилась')
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 6 })).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  for (const c of [m, r1]) {
    assert.deepEqual(q(c.db(), 'SELECT unitsPerPack, priceC FROM products WHERE id = ?').get(p.id), { unitsPerPack: 1, priceC: 600 }, c.tag)
    assert.equal((await c.req('GET', '/products')).data.find((x) => x.id === p.id).stock, 10, `${c.tag}: прихода нет — остаток прежний`)
  }
  const nt = await discs(m, 'notTaken')
  assert.equal(nt.length, 1)
  assert.equal(nt[0].opType, 'arrival')
  assert.match(JSON.parse(nt[0].note).error, /приход с другой упаковкой не принят/)
})

test('приход без смены упаковки, цену на главном поменяли позже: приход ложится, цена — главного', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  await swap(r1)
  assert.equal((await r1.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 2, cost: 3, price: 9 }] })).status, 201)
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 6 })).status, 200)
  await swap(r1)
  await swap(r1)
  for (const c of [m, r1]) {
    assert.equal(q(c.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 600, c.tag)
    assert.equal((await c.req('GET', '/products')).data.find((x) => x.id === p.id).stock, 12, `${c.tag}: приход лёг`)
  }
})

test('правка главного, пока ни одна касса не подключена, — позже правки кассы', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 30 })).status, 200)
  assert.equal(m.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 40 })).status, 200)
  await rejoin(m, r1)
  assert.equal(q(m.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 4000)
  assert.equal(q(r1.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 4000, 'и на кассе')
  assert.deepEqual(fieldsOf((await discs(m, 'soloEdit'))[0]), [{ field: 'priceC', kassa: 3000, main: 4000 }])
})

test('цена из прихода другой кассы — позже старой правки цены: остаётся', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  assert.equal((await r1.login()).status, 201)
  assert.equal((await r2.login()).status, 201)
  await swap(r1)
  await swap(r2)
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 7 })).status, 200)
  time.now += MIN10
  const a = await r2.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 1, cost: 3, price: 9 }] })
  assert.equal(a.status, 201, JSON.stringify(a.data))
  await swap(r2)
  await swap(r2)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(q(m.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 900)
  assert.equal(q(r1.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 900, 'и на кассе')
  assert.deepEqual(fieldsOf((await discs(m, 'soloEdit'))[0]), [{ field: 'priceC', kassa: 700, main: 900 }])
})

test('цена из прихода кассы — раньше новой цены на главном: остаётся цена главного', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const sup = (await m.req('POST', '/suppliers', { name: 'Оптовик' })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  await swap(r1)
  const a = await r1.req('POST', '/arrivals', { supplierId: sup.id, debt: 0, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 1, cost: 3, price: 9 }] })
  assert.equal(a.status, 201, JSON.stringify(a.data))
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 6 })).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal(q(m.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 600)
  assert.equal(q(r1.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 600, 'и на кассе')
  assert.equal(await (async () => (await m.req('GET', '/products')).data.find((x) => x.id === p.id).stock)(), 11, 'сам приход лёг')
  assert.deepEqual(fieldsOf((await discs(m, 'soloEdit'))[0]), [{ field: 'priceC', kassa: 900, main: 600 }])
})

test('категорию переименовали и на кассе, и на главном: товары и на кассе — в категории главного', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  await swap(r1)
  const catName = q(m.db(), 'SELECT category FROM products WHERE id = ?').get(p.id).category
  const cat = q(m.db(), 'SELECT id FROM categories WHERE name = ?').get(catName)
  assert.ok(cat, 'у товара есть категория: ' + catName)
  assert.equal((await r1.req('PATCH', `/categories/${cat.id}`, { name: 'Разное' })).status, 200)
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/categories/${cat.id}`, { name: 'Другое' })).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  for (const c of [m, r1]) {
    assert.equal(q(c.db(), 'SELECT name FROM categories WHERE id = ?').get(cat.id).name, 'Другое', c.tag)
    assert.equal(q(c.db(), 'SELECT category FROM products WHERE id = ?').get(p.id).category, 'Другое', c.tag)
  }
  assert.deepEqual(fieldsOf((await discs(m, 'soloEdit'))[0]), [{ field: 'name', kassa: 'Разное', main: 'Другое' }])
})

test('касса молчала больше месяца и переименовала категорию: товары не уходят в несуществующую', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  const catName = q(m.db(), 'SELECT category FROM products WHERE id = ?').get(p.id).category
  const cat = q(m.db(), 'SELECT id FROM categories WHERE name = ?').get(catName)
  assert.equal((await r1.req('PATCH', `/categories/${cat.id}`, { name: 'Разное' })).status, 200)
  // Главный работает дальше; проходит 40 дней — его журнал за это время убран
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { minStock: 3 })).status, 200)
  time.now += 40 * 24 * HOUR
  assert.equal((await m.login()).status, 201)
  m.gw.tick()
  await swap(r1)
  assert.equal(r1.gw.standalone.net().main.error, 'gone')
  await rejoin(m, r1)
  for (const c of [m, r1]) {
    assert.equal(q(c.db(), 'SELECT name FROM categories WHERE id = ?').get(cat.id).name, catName, c.tag)
    assert.equal(q(c.db(), 'SELECT category FROM products WHERE id = ?').get(p.id).category, catName, c.tag)
  }
  assert.deepEqual(fieldsOf((await discs(m, 'soloOld'))[0]), [{ field: 'name', kassa: 'Разное', main: catName }])
})

test('подъём из копии: товар главного, вернувшийся с кассой, со штрихкодом, который уже занят, — внутренний код', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  const dir = copyNow(m)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  const x = (await m.req('POST', '/products', { name: 'Сахар', barcode: '4600000000555', price: 9, cost: 6, stock: 3 })).data
  await swap(r1)
  assert.ok(q(r1.db(), 'SELECT 1 FROM products WHERE id = ?').get(x.id))
  const m2 = await restoredMain(m, dir, time, tt)
  const y = (await m2.req('POST', '/products', { name: 'Сахар (новая)', barcode: '4600000000555', price: 10, cost: 6, stock: 0 })).data
  await rejoin(m2, r1)
  assert.deepEqual(q(m2.db(), 'SELECT id FROM products WHERE barcode = ?').all('4600000000555').map((r) => r.id), [y.id], 'код — у карточки, заведённой после копии')
  assert.match(q(m2.db(), 'SELECT barcode FROM products WHERE id = ?').get(x.id).barcode, /^2\d{12}$/, 'вернувшийся товар — с внутренним кодом')
  assert.equal((await discs(m2, 'barcode')).length, 1)
})

test('подъём из копии и две кассы: правка кассы, видевшей правку главного, остаётся при любом порядке подключения', async (tt) => {
  for (const order of [['r1', 'r2'], ['r2', 'r1']]) {
    const time = { now: NOW }
    const { m, p } = await mainShop(time)
    const dir = copyNow(m)
    const { r: r1 } = await joinRegister(m, time, 'KASSA2')
    tt.after(() => r1.close())
    const { r: r2 } = await joinRegister(m, time, 'KASSA3')
    tt.after(() => r2.close())
    assert.equal((await r1.login()).status, 201)
    assert.equal((await r2.login()).status, 201)
    // Главный: цена 20, обе кассы её получили; касса 2 после этого — 25
    assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 20 })).status, 200)
    await swap(r1)
    await swap(r2)
    time.now += MIN10
    assert.equal((await r2.req('PATCH', `/products/${p.id}`, { price: 25 })).status, 200)
    const m2 = await restoredMain(m, dir, time, tt)
    const regs = { r1, r2 }
    for (const k of order) await rejoin(m2, regs[k])
    assert.equal(q(m2.db(), 'SELECT priceC FROM products WHERE id = ?').get(p.id).priceC, 2500, `порядок ${order.join(', ')}`)
    assert.equal((await discs(m2, 'soloEdit')).length, 0, `порядок ${order.join(', ')}: спора нет`)
  }
})

test('поставщик с долгом: приход в долг и удаление одной пачкой — не удаляется', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const roleR = await m.req('POST', '/roles', { name: 'Приёмщик', permissions: ['arrivals.create', 'arrivals.debt', 'suppliers.edit', 'suppliers.delete'] })
  assert.equal(roleR.status, 201, JSON.stringify(roleR.data))
  const kassir = (await m.req('GET', '/users')).data.find((u) => u.name === KASSIR)
  assert.equal((await m.req('PATCH', `/users/${kassir.id}`, { roleId: roleR.data.id })).status, 200)
  await swap(r1)
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  const s = (await r1.req('POST', '/suppliers', { name: 'Новый поставщик' })).data
  assert.equal((await r1.req('POST', '/arrivals', { supplierId: s.id, debt: 40, payMethod: 'cash', paidCash: 0, items: [{ productId: p.id, qty: 4, cost: 10 }] })).status, 201)
  assert.equal((await r1.req('DELETE', `/suppliers/${s.id}`)).status, 200)
  await swap(r1)
  await swap(r1)
  assert.equal(q(m.db(), 'SELECT sDebtC FROM suppliers WHERE id = ?').get(s.id)?.sDebtC, 4000, 'поставщик и его долг — на месте')
  assert.ok(q(r1.db(), 'SELECT 1 FROM suppliers WHERE id = ?').get(s.id), 'и на кассе вернулся')
  const nt = await discs(m, 'notTaken')
  assert.equal(nt.length, 1)
  assert.equal(JSON.parse(nt[0].note).error, 'У поставщика есть долг — сначала закройте его')
  assert.equal(JSON.parse(nt[0].note).what.rows[0].name, 'Новый поставщик', 'в «не принято» — какой поставщик')
})

test('поправки главного — в самой записи журнала; присланное кассой под этим именем — не в счёт', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login()).status, 201)
  // Касса подсовывает в свою запись «поправки главного»: расхождение и строку для касс
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { minStock: 2 })).status, 200)
  const row = q(r1.db(), "SELECT id, body FROM lan_log WHERE kind = 'op' AND type = 'product.update'").get()
  const body = JSON.parse(row.body)
  body.trim = { flags: [{ kind: 'soloEdit', productId: p.id, name: 'Подделка', units: 0, note: '{}' }], touch: [{ tbl: 'products', col: 'category', names: ['x'] }] }
  q(r1.db(), 'UPDATE lan_log SET body = ? WHERE id = ?').run(JSON.stringify(body), row.id)
  await swap(r1)
  await swap(r1)
  assert.equal(pending(r1), 0)
  assert.equal((await discs(m)).length, 0, 'подделанного расхождения нет')
  assert.equal(JSON.parse(q(m.db(), 'SELECT body FROM lan_log WHERE id = ?').get(row.id).body).trim, undefined)
  // Настоящая поправка главного — в записи
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { price: 7 })).status, 200)
  time.now += MIN10
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 8 })).status, 200)
  await swap(r1)
  const op = q(m.db(), "SELECT body FROM lan_log WHERE kind = 'op' AND origin = ? AND type = 'product.update' ORDER BY seq DESC").get(r1.gw.deviceId)
  assert.deepEqual(JSON.parse(op.body).trim.touch, [{ tbl: 'products', rowId: p.id }])
  assert.equal((await discs(m, 'soloEdit')).length, 1)
})

test('главный — из копии кассы на новом компьютере: правки кассы прежнего поколения — «вслепую», операции прежнего главного — свои', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  assert.equal((await r1.login()).status, 201)
  // Прежний главный ставит цену 20 — её получает только первая касса
  assert.equal((await m.req('PATCH', `/products/${p.id}`, { price: 20 })).status, 200)
  await swap(r1)
  const oldMain = m.gw.deviceId
  // Первая касса без связи меняет минимальный остаток
  assert.equal((await r1.req('PATCH', `/products/${p.id}`, { minStock: 4 })).status, 200)
  // Главный «сломался»; копия второй кассы (без цены 20) — на новый компьютер
  m.close()
  const copyDir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-trim-regcopy-'))
  r2.db().pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(join(r2.dataDir, 'pharmacy-local.db'), join(copyDir, 'pharmacy-local.db'))
  fs.writeFileSync(join(copyDir, 'core.db'), r2.core.serialize())
  const nm = computer('NEWMAIN', { time })
  assert.equal((await nm.gw.standalone.setupShop({ shopName: 'Временный', login: OWNER, password: PASS })).ok, true)
  nm.close()
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-trim-ud-'))
  requestRestore({ userData, fs, Database, folder: copyDir, shopFile: 'pharmacy-local.db', foreign: true, at: NOW, now: () => time.now })
  assert.equal(applyRestore({ userData, dataDir: nm.dataDir, fs, Database, now: () => time.now, schemaMax: PHARMACY_SCHEMA.length }).ok, true)
  const nm2 = computer('NEWMAIN', { time, core: nm.core, dataDir: nm.dataDir })
  tt.after(() => nm2.close())
  nm2.gw.resume()
  assert.equal((await nm2.login(OWNER, PASS)).status, 201)
  assert.equal(getMeta(nm2.db(), 'soloEpochBlind'), '1')
  assert.equal(getMeta(nm2.db(), 'soloFormerMain'), oldMain)
  // На новом главном цену меняют
  time.now += MIN10
  assert.equal((await nm2.req('PATCH', `/products/${p.id}`, { price: 30 })).status, 200)
  // Первая касса подключается и приносит цену 20 прежнего главного и свой минимальный остаток
  await rejoin(nm2, r1)
  const row = q(nm2.db(), 'SELECT priceC, minStock FROM products WHERE id = ?').get(p.id)
  assert.equal(row.priceC, 3000, 'цена прежнего главного не затёрла цену, поставленную после')
  assert.notEqual(row.minStock, 4, 'правка кассы прежнего поколения сама не легла')
  assert.equal((await discs(nm2, 'notTaken')).length, 0, 'операция прежнего главного — не «чужая»')
  assert.deepEqual(fieldsOf((await discs(nm2, 'soloOld'))[0]), [{ field: 'minStock', kassa: 4, main: row.minStock }])
})
