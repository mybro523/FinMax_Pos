// ── Магазин без интернета: главный компьютер и кассы по сети (версия 1.7.0) ──
//
// Сервера нет. Главный компьютер — тот, где завели магазин, — показывает код подключения;
// касса вводит его и получает базу магазина целиком. Дальше кассы обмениваются только с главным
// (звезда): продажа кассы ложится в базу главного и уходит на остальные кассы, приход и новый
// сотрудник с главного — на кассы. Вход на кассе — логином и паролем, заведёнными на главном.
//
// Здесь — три настоящие программы (шлюз + обмен по сети) на этом компьютере, на 127.0.0.1.
// Интернета нет: заглушка сети считает обращения, их должно быть ноль.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MESSAGES } from '../src/gateway.mjs'
import { getMeta, openDb, q } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyRestore, requestRestore } from '../src/restore.mjs'
import { NOW } from '../test-support/pharmacy.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, listening, mainShop, OWNER, PASS, pending, PNG, stockOf, swap } from '../test-support/solo-shop.mjs'

test('кассы по сети: подключение по коду, вход паролем главного, продажи и приход в обе стороны — без интернета', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1, name: n1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2, name: n2 } = await joinRegister(m, time, 'KASSA3', { byAddress: true })
  tt.after(() => r2.close())
  assert.deepEqual([n1, n2], ['Касса 2', 'Касса 3'])

  // Касса знает, что она касса, и знает своего главного
  const info = r1.gw.standalone.info()
  assert.equal(info.role, 'register')
  assert.equal(info.shop, true)
  // Главный видит свои кассы
  const net = m.gw.standalone.net()
  assert.equal(net.role, 'main')
  assert.deepEqual(net.registers.map((x) => x.name), ['Касса 2', 'Касса 3'])

  // Вход на кассе — логином и паролем, заведёнными на главном; база — магазина главного
  assert.equal((await r1.login(KASSIR, 'не тот пароль')).status, 401)
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal(await stockOf(r1, p.id), 10)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const sale = await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 2 }] })
  assert.equal(sale.status, 201, JSON.stringify(sale.data))
  // Своё касса держит, пока главный не примет
  assert.ok(pending(r1) > 0)
  assert.equal(r1.gw.status().net.pending > 0, true)

  // Обмен: главный принимает продажу и рассылает основу
  await swap(r1)
  assert.equal(pending(r1), 0, 'главный принял — касса больше не ждёт')
  assert.equal(await stockOf(m, p.id), 8)
  assert.ok((await m.req('GET', '/sales')).data.some((s) => s.id === sale.data.id), 'продажа кассы — у главного')
  assert.equal(await stockOf(r1, p.id), 8)

  // Вторая касса получает продажу первой (через главного)
  await swap(r2)
  assert.equal((await r2.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal(await stockOf(r2, p.id), 8)
  assert.equal(r2.db() && q(r2.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 1)

  // Приход на главном — на кассах
  const sup = await m.req('POST', '/suppliers', { name: 'Оптовик' })
  assert.equal(sup.status, 201)
  const arr = await m.req('POST', '/arrivals', { supplierId: sup.data.id, debt: 0, payMethod: 'cash', paidCash: 30, items: [{ productId: p.id, qty: 10, cost: 3 }] })
  assert.equal(arr.status, 201, JSON.stringify(arr.data))
  assert.equal(await stockOf(m, p.id), 18)
  await swap(r1)
  await swap(r2)
  assert.equal(await stockOf(r1, p.id), 18)
  assert.equal(await stockOf(r2, p.id), 18)

  // Новый сотрудник на главном — входит и на кассе
  assert.equal((await m.req('POST', '/users', { name: 'kassir2', password: 'Kassir-pass-2' })).status, 201)
  await swap(r2)
  assert.equal((await r2.login('kassir2', 'Kassir-pass-2')).status, 201)

  // Сотрудников и роли на кассе не меняют — это делается на главном
  r1.gw.logout()
  assert.equal((await r1.login(OWNER, PASS)).status, 201)
  const refused = await r1.req('POST', '/users', { name: 'kassir9', password: 'Kassir-pass-9' })
  assert.equal(refused.status, 403)
  assert.equal(refused.data.message, MESSAGES.onMainOnly)
  // Логотип — тоже на главном
  assert.equal((await r1.req('POST', '/shop/logo', { logo: PNG })).status, 403)

  // Свой пароль на кассе меняют (владелец — всегда; кассир — если владелец разрешил): новый действует
  // сразу, главный и другие кассы узнают его с обменом
  assert.equal((await r1.req('POST', '/auth/change-password', { oldPassword: PASS, newPassword: 'Novyi-pass-5' })).status, 201)
  r1.gw.logout()
  assert.equal((await r1.login(OWNER, 'Novyi-pass-5')).status, 201, 'новый пароль — сразу')
  await swap(r1)
  m.gw.logout()
  assert.equal((await m.login(OWNER, 'Novyi-pass-5')).status, 201, 'главный узнал новый пароль')
  m.gw.logout()
  assert.equal((await m.login(OWNER, PASS)).status, 401)
  await swap(r2)
  r2.gw.logout()
  assert.equal((await r2.login(OWNER, 'Novyi-pass-5')).status, 201, 'и другая касса')
  // Касса, сменившая пароль, после основы главного входит им же
  r1.gw.logout()
  assert.equal((await r1.login(OWNER, 'Novyi-pass-5')).status, 201)

  // Логотип с главного — на кассы (чеки, экран покупателя)
  assert.equal((await m.login(OWNER, 'Novyi-pass-5')).status, 201)
  assert.equal((await m.req('POST', '/shop/logo', { logo: PNG })).status, 200)
  await swap(r2)
  assert.equal(r2.gw.shopLogo(), PNG)

  // Интернета не было ни разу
  assert.deepEqual([m.net, r1.net, r2.net], [[], [], []])
  assert.deepEqual([m.errors, r1.errors, r2.errors], [[], [], []])
})

test('кассы по сети: продали последнее сразу на двух кассах — у главного расхождение, кассы получают остаток главного', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const last = (await m.req('POST', '/products', { name: 'Последний', barcode: '4600000000402', price: 7, cost: 4, stock: 1 })).data
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3')
  tt.after(() => r2.close())
  for (const r of [r1, r2]) {
    assert.equal((await r.login(KASSIR, KASSIR_PASS)).status, 201)
    assert.equal((await r.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
    // Связи с главным нет: каждая касса продаёт свой «последний»
    assert.equal((await r.req('POST', '/sales', { payment: 'cash', items: [{ productId: last.id, qty: 1 }] })).status, 201)
  }
  await swap(r1)
  await swap(r2)
  await swap(r1)
  // Обе продажи — у главного; товар отдан (остаток — ноль: ниже нуля партии не уходят), владелец
  // видит расхождение
  assert.equal(q(m.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 2)
  assert.equal(await stockOf(m, last.id), 0)
  const disc = (await m.req('GET', '/discrepancies')).data
  assert.equal(disc.length, 1)
  assert.equal(disc[0].kind, 'sale')
  assert.equal(disc[0].name, 'Последний')
  assert.equal(disc[0].deviceName, 'Касса 3')
  assert.equal(disc[0].userName, KASSIR)
  assert.equal((await m.req('POST', `/discrepancies/${disc[0].id}/resolve`, {})).status, 200)
  assert.equal((await m.req('GET', '/discrepancies')).data.length, 0)
  // На кассах — как у главного
  assert.equal(await stockOf(r1, last.id), 0)
  assert.equal(await stockOf(r2, last.id), 0)
  assert.equal(pending(r1) + pending(r2), 0)
  // Расхождения видит только главный
  assert.deepEqual((await r1.req('GET', '/discrepancies')).data, [])
})

test('кассы по сети: главный на экране входа и после перезапуска отвечает кассам; отключённая касса и неверный код', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r1.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)

  // Главный вышел — касса всё равно обменивается с ним
  m.gw.logout()
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 0)

  // Главный перезапустили (никто не вошёл): база магазина открыта, кассы обслуживаются
  m.close()
  const m2 = computer('MAIN', { time, core: m.core, dataDir: m.dataDir })
  tt.after(() => m2.close())
  assert.equal(m2.gw.resume(), false)
  await listening(m2)
  assert.ok(m2.lan.port() > 0)
  // Касса узнаёт новый адрес главного, как только тот откликнется (здесь — проверка вписывает порт)
  q(r1.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m.gw.deviceId)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 0, 'главный после перезапуска принял продажу без входа')
  assert.equal(q(m2.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 2)

  // Неверный код подключения — касса не подключается; без кода — тоже
  assert.equal((await m2.login()).status, 201)
  const open = m2.gw.standalone.pairStart()
  await listening(m2)
  const stranger = computer('KASSA9', { time, udpFind: m2.lan.udpPort() })
  tt.after(() => stranger.close())
  const wrong = await stranger.gw.standalone.join({ code: open.code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(wrong.error, MESSAGES.pairCode)
  assert.equal(stranger.gw.standalone.info().shop, false)
  m2.gw.standalone.pairStop()
  const late = await stranger.gw.standalone.join({ code: open.code, address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(late.error, MESSAGES.pairNoCode)
  assert.equal((await stranger.gw.standalone.join({ code: '12', address: '' })).error, MESSAGES.pairFormat)

  // Главный отключил кассу: обмен с ней закрыт, касса видит, что её отключили
  assert.equal(m2.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  assert.equal(m2.gw.standalone.net().registers.length, 0)
  assert.equal((await r1.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 1, 'отключённой кассе главный не отвечает')
  // Главный держит сеть, пока у магазина есть ключ: отключённая касса узнаёт, что её отключили
  await m2.lan.sync()
  assert.equal(m2.lan.status().running, true)
  assert.equal(r1.gw.standalone.net().main.error, 'star')
  assert.equal(r1.gw.standalone.net().main.online, false)
  // Касса подключается заново: её непринятая продажа уходит главному при подключении
  const again = m2.gw.standalone.pairStart()
  await listening(m2)
  const re = await r1.gw.standalone.join({ code: again.code, address: `127.0.0.1:${m2.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(re.name, 'Касса 2')
  assert.equal(q(m2.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 3)
  assert.equal(pending(r1), 0)
  assert.equal(q(r1.db(), "SELECT COUNT(*) AS n FROM docs WHERE kind = 'sale'").get().n, 3)
  assert.deepEqual([m2.net, r1.net, stranger.net], [[], [], []])
})

test('кассы по сети: на кассе — ни сброса пароля владельца, ни загрузки копии; новую кассу к кассе не подключить', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time)
  tt.after(() => m.close())
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  tt.after(() => r1.close())
  assert.equal((await r1.gw.standalone.resetPassword({ code: 'XXXXX-XXXXX', password: 'Novyi-pass-1' })).error, MESSAGES.onMainOnly)
  assert.equal(r1.gw.standalone.isRegister(), true)
  assert.equal(m.gw.standalone.isRegister(), false)
  assert.equal((await r1.login()).status, 201)
  assert.equal(r1.gw.standalone.pairStart().error, MESSAGES.pairNotMain)
  // Второй раз завести магазин на кассе нельзя
  assert.equal((await r1.gw.standalone.setupShop({ shopName: 'Другой', login: 'x', password: PASS })).error, MESSAGES.shopExists)
})

test('главный загрузил копию базы — у базы новое «поколение», кассы подключаются заново', () => {
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'finmax-solo-restore-'))
  const dataDir = join(userData, 'data')
  fs.mkdirSync(dataDir)
  const copyDir = join(userData, 'copy')
  fs.mkdirSync(copyDir)
  const shopFile = 'pharmacy-local.db'
  // Копия базы главного, снятая, когда кассы уже были
  const db = openDb(join(copyDir, shopFile), PHARMACY_SCHEMA)
  q(db, "INSERT INTO meta (key, value) VALUES ('soloEpoch', 'old-epoch') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
  db.close()
  // Нынешняя база
  openDb(join(dataDir, shopFile), PHARMACY_SCHEMA).close()
  requestRestore({ userData, fs, Database, folder: copyDir, shopFile, foreign: false, at: NOW, now: () => NOW })
  const r = applyRestore({ userData, dataDir, fs, Database, now: () => NOW, schemaMax: PHARMACY_SCHEMA.length })
  assert.equal(r.ok, true, JSON.stringify(r))
  const after = openDb(join(dataDir, shopFile), PHARMACY_SCHEMA)
  const epoch = getMeta(after, 'soloEpoch')
  after.close()
  assert.ok(epoch && epoch !== 'old-epoch', 'поколение базы сменилось')
})
