// ── Магазин без интернета: код активации снова обязателен (1.7.1) ──
//
// Решения владельца сервиса (07.11.2026):
//   • без кода — пробный срок 14 дней: у нового магазина — с его заведения, у заведённого раньше
//     (1.7.0, без кода) — с первого запуска версии с кодами; за 7 дней — напоминание;
//   • срок вышел — продажи и изменения остановлены, вход, просмотр и отчёты работают;
//   • число касс — в коде (вместе с главным); в пробный срок — без ограничения; касс больше,
//     чем в коде, — лишние (подключённые последними) остановлены;
//   • кассы работают по коду главного (проверяют его подпись сами) и останавливаются вместе с ним;
//     код вводят только на главном — кассам он приходит по сети.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { getMeta, q, setMeta } from '../src/local/db.mjs'
import { NOW } from '../test-support/pharmacy.mjs'
import { FOREVER, issueCode, todayDay } from '../test-support/licence-sign.mjs'
import { computer, joinRegister, KASSIR, KASSIR_PASS, KEYS, listening, mainShop, OWNER, PASS, pending, swap } from '../test-support/solo-shop.mjs'

const DAY = 86400000
const MESSAGES_LIC = /Срок работы программы закончился/
const codeFor = (c, time, over = {}) => issueCode(KEYS.privateKey, c.pc, { kind: 'activate', until: todayDay(time.now) + 365, registers: 3, serial: 1, ...over })

async function cashierShift(r) {
  assert.equal((await r.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
}
const sell = (c, p) => c.req('POST', '/sales', { payment: 'cash', items: [{ productId: p.id, qty: 1 }] })

test('новый магазин без кода: пробный срок 14 дней, напоминание за 7, потом — только просмотр; код — работа сразу', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  let a = m.gw.status().activation
  assert.deepEqual([a.active, a.trial, a.daysLeft, a.warn, a.registers], [true, true, 14, false, null])
  assert.equal((await sell(m, p)).status, 201)
  // Восьмой день — осталось 7: напоминание
  time.now += 7 * DAY
  m.gw.tick()
  a = m.gw.status().activation
  assert.deepEqual([a.active, a.daysLeft, a.warn], [true, 7, true])
  assert.equal((await m.req('GET', '/auth/me')).data.subscription.warn, true)
  // Последний (14-й) день — работает целиком
  time.now += 6 * DAY
  m.gw.tick()
  assert.equal(m.gw.status().activation.daysLeft, 1)
  assert.equal((await sell(m, p)).status, 201)
  // 15-й день — срок вышел: смотреть можно, продавать и менять — нет
  time.now += DAY
  m.gw.tick()
  a = m.gw.status().activation
  assert.deepEqual([a.active, a.expired, a.trial], [false, true, true])
  assert.equal(m.events.filter((e) => e.type === 'licence').pop()?.payload.canWrite, false)
  const no = await sell(m, p)
  assert.equal(no.status, 403)
  assert.match(no.data.message, MESSAGES_LIC)
  assert.equal((await m.req('GET', '/auth/me')).status, 200)
  assert.equal((await m.req('GET', '/products')).status, 200)
  // Вход и после выхода — для просмотра
  m.gw.logout()
  assert.equal((await m.login()).status, 201)
  // Код с другого компьютера не подходит; свой — работа сразу
  assert.match(m.gw.standalone.activate(issueCode(KEYS.privateKey, Buffer.alloc(5, 7), { until: todayDay(time.now) + 30 })).error, /не подходит/)
  const ok = m.gw.standalone.activate(codeFor(m, time, { until: todayDay(time.now) + 30, registers: 1 }))
  assert.equal(ok.ok, true, JSON.stringify(ok))
  a = m.gw.status().activation
  assert.deepEqual([a.active, a.trial, a.registers], [true, false, 1])
  assert.equal(m.events.filter((e) => e.type === 'licence').pop()?.payload.canWrite, true)
  assert.equal((await sell(m, p)).status, 201)
  assert.deepEqual(m.net, [], 'к серверу программа не обращалась')
})

test('магазин, заведённый в 1.7.0 без кода: после обновления — пробные 14 дней с обновления, а не с заведения', async (tt) => {
  const time = { now: NOW }
  // 1.7.0: без кода
  const { m, p } = await mainShop(time)
  for (let i = 0; i < 3; i++) assert.equal((await sell(m, p)).status, 201)
  time.now += 60 * DAY
  const core = m.core
  const dataDir = m.dataDir
  m.close()
  // 1.7.1: та же база, код обязателен
  const m2 = computer('MAIN', { time, core, dataDir, requireCode: true })
  tt.after(() => m2.close())
  m2.gw.resume()
  assert.equal((await m2.login()).status, 201)
  let a = m2.gw.status().activation
  assert.deepEqual([a.active, a.trial, a.daysLeft], [true, true, 14])
  assert.equal(Number(getMeta(m2.db(), 'trialFrom')), time.now, 'начало пробного срока — в базе магазина')
  assert.ok(getMeta(m2.core, 'soloTrial'), 'и зашифрованно — в общей базе')
  assert.equal((await sell(m2, p)).status, 201)
  // Одну из двух отметок стёрли — срок не начинается заново
  time.now += 10 * DAY
  q(m2.core, "DELETE FROM meta WHERE key = 'soloTrial'").run()
  m2.close()
  const m3 = computer('MAIN', { time, core, dataDir, requireCode: true })
  tt.after(() => m3.close())
  m3.gw.resume()
  assert.equal((await m3.login()).status, 201)
  a = m3.gw.status().activation
  assert.deepEqual([a.trial, a.daysLeft], [true, 4])
  assert.ok(getMeta(m3.core, 'soloTrial'), 'стёртая отметка записана снова')
})

test('кассы: в пробный срок — без ограничения; по коду — сколько в коде (с главным), лишние остановлены', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  // Пробный срок: две кассы
  const { r: r1 } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r1.close())
  const { r: r2 } = await joinRegister(m, time, 'KASSA3', { requireCode: true })
  tt.after(() => r2.close())
  for (const r of [r1, r2]) assert.deepEqual([r.gw.standalone.info().activation.active, r.gw.standalone.info().activation.trial], [true, true])
  await cashierShift(r1)
  await cashierShift(r2)
  // Код на 2 кассы (главный + 1): вторая касса — лишняя
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { registers: 2 })).ok, true)
  const net = m.gw.standalone.net()
  assert.equal(net.limit, 1)
  assert.deepEqual(net.registers.map((x) => [x.name, x.stopped]), [['Касса 2', false], ['Касса 3', true]])
  await swap(r1)
  await swap(r2)
  assert.deepEqual([r1.gw.status().activation.active, r1.gw.status().activation.trial], [true, false], 'первая касса — по коду главного')
  const a2 = r2.gw.status().activation
  assert.deepEqual([a2.active, a2.stopped], [false, true])
  assert.equal((await sell(r1, p)).status, 201)
  const no = await sell(r2, p)
  assert.equal(no.status, 403)
  assert.match(no.data.message, /касса остановлена/)
  assert.equal((await r2.req('GET', '/products')).status, 200, 'смотреть на остановленной кассе можно')
  // Подключить ещё одну — нельзя (код открывается, но новая касса им не подключится)
  const open = m.gw.standalone.pairStart()
  assert.equal(open.ok, true)
  assert.match(open.onlyKnown, /Все кассы, которые разрешает код активации, уже подключены/)
  await listening(m)
  const r3 = computer('KASSA4', { time, udpFind: m.lan.udpPort(), requireCode: true })
  tt.after(() => r3.close())
  const res3 = await r3.gw.standalone.join({ code: open.code, address: `127.0.0.1:${m.lan.port()}` })
  assert.match(res3.error || '', /Все кассы, которые разрешает код активации, уже подключены/)
  m.gw.standalone.pairStop()
  // Лишнюю отключили — по коду всё сходится; код на 3 кассы — вторая снова работает
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { registers: 3, serial: 2 })).ok, true)
  assert.deepEqual(m.gw.standalone.net().registers.map((x) => x.stopped), [false, false])
  await swap(r2)
  assert.equal(r2.gw.status().activation.active, true)
  assert.equal((await sell(r2, p)).status, 201)
  await swap(r2)
  await swap(r1)
  assert.equal(pending(r1) + pending(r2), 0)
})

test('кассы работают по коду главного: срок кончается у всех в один день; новый код приходит по сети', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  const today = todayDay(time.now)
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { until: today + 10, registers: 2 })).ok, true)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r1.close())
  let a = r1.gw.standalone.info().activation
  assert.deepEqual([a.active, a.trial, a.until], [true, false, m.gw.status().activation.until])
  // Код вводят на главном
  assert.equal(r1.gw.standalone.activate(codeFor(m, time, { until: today + 100, serial: 5 })).error, 'Код активации вводят на главном компьютере магазина — кассы получают его сами.')
  await cashierShift(r1)
  // Касса без связи: в последний день работает, на следующий — нет
  time.now += 10 * DAY
  r1.gw.tick()
  assert.equal((await sell(r1, p)).status, 201)
  time.now += DAY
  r1.gw.tick()
  m.gw.tick()
  assert.equal(r1.gw.status().activation.active, false)
  const no = await sell(r1, p)
  assert.equal(no.status, 403)
  assert.match(no.data.message, /Владелец вводит код активации на главном компьютере/)
  // Код подключения открывается — но только для прежней кассы
  const open = m.gw.standalone.pairStart()
  assert.match(open.onlyKnown, /Срок работы программы закончился/)
  m.gw.standalone.pairStop()
  // На главном — новый код; касса получает его с обменом
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { until: FOREVER, registers: 2, serial: 2 })).ok, true)
  await swap(r1)
  a = r1.gw.status().activation
  assert.deepEqual([a.active, a.forever], [true, true])
  assert.equal((await sell(r1, p)).status, 201)
  await swap(r1)
  assert.equal(pending(r1), 0)
})

test('касса, подключённая ещё в 1.7.0 (главный без кода): после обновления главный сам присылает ей срок', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2')
  await swap(r1)
  time.now += DAY
  const mc = { core: m.core, dataDir: m.dataDir }
  const rc = { core: r1.core, dataDir: r1.dataDir }
  r1.close()
  m.close()
  const m2 = computer('MAIN', { time, ...mc, requireCode: true })
  tt.after(() => m2.close())
  m2.gw.resume()
  await listening(m2)
  const r2 = computer('KASSA2', { time, ...rc, requireCode: true })
  tt.after(() => r2.close())
  r2.gw.resume()
  q(r2.db(), 'UPDATE lan_peers SET port = ? WHERE deviceId = ?').run(m2.lan.port(), m2.gw.deviceId)
  // До сведений главного — пробный срок по отметке в базе (её база — копия главного)
  assert.equal(r2.gw.standalone.info().activation.trial, true)
  assert.equal(m2.gw.standalone.activate(codeFor(m2, time, { registers: 2 })).ok, true)
  m2.gw.tick()
  await swap(r2)
  const a = r2.gw.standalone.info().activation
  assert.deepEqual([a.active, a.trial, a.registers], [true, false, 2])
  assert.equal((await r2.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await r2.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  assert.equal((await sell(r2, p)).status, 201)
})

test('код магазина нельзя подделать на кассе: сведения о сроке зашифрованы, подпись кода проверяется', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { until: todayDay(time.now) + 3, registers: 2 })).ok, true)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r1.close())
  await cashierShift(r1)
  // Подложить «свой» код на кассу руками: без шифрования Windows этой кассы он не читается
  setMeta(r1.core, 'soloLic', JSON.stringify({ code: issueCode(KEYS.privateKey, r1.pc, { until: FOREVER, registers: 9 }), computer: 'X', trialFrom: time.now, stopped: [] }))
  time.now += 5 * DAY
  r1.gw.tick()
  const a = r1.gw.status().activation
  assert.equal(a.active, false, 'подложенное не продлило срок')
  assert.equal((await sell(r1, p)).status, 403)
})

test('владелец и кассир входят и после конца срока — смотреть, считать и сохранить копию', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  assert.equal((await sell(m, p)).status, 201)
  time.now += 20 * DAY
  m.gw.tick()
  m.gw.logout()
  const r = await m.login(OWNER, PASS)
  assert.equal(r.status, 201)
  assert.deepEqual([r.data.user.subscription.canWrite, r.data.user.subscription.readOnly], [false, true])
  assert.equal((await m.login(KASSIR, KASSIR_PASS)).status, 201)
  assert.equal((await m.req('GET', '/sales?days=60')).data.length, 1)
  assert.equal((await m.req('POST', '/shifts/open', { openingCash: 0 })).status, 403)
})

test('кассу отключили на главном — она останавливается; подключили заново — работает', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { until: FOREVER, registers: 2 })).ok, true)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r1.close())
  await cashierShift(r1)
  assert.equal((await sell(r1, p)).status, 201)
  assert.equal(m.gw.standalone.unpair(r1.gw.deviceId).ok, true)
  // Главный отвечает «такой кассы нет» — касса верит этому не сразу после получения сведений
  time.now += 10 * 60000
  await swap(r1)
  r1.gw.tick()
  let a = r1.gw.status().activation
  assert.deepEqual([a.active, a.unpaired], [false, true])
  const no = await sell(r1, p)
  assert.equal(no.status, 403)
  assert.match(no.data.message, /Главный компьютер отключил эту кассу/)
  // Отметка «отключена» помнится и без связи
  r1.lan.stop()
  assert.equal(r1.gw.status().activation.active, false)
  // Подключили заново — сведения новые, работает
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const re = await r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })
  assert.equal(re.ok, true, JSON.stringify(re))
  assert.equal(r1.gw.standalone.info().activation.active, true)
})

test('касса больше месяца без подтверждения главного — останавливается; связь вернулась — работает', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  assert.equal(m.gw.standalone.activate(codeFor(m, time, { until: FOREVER, registers: 2 })).ok, true)
  const { r: r1 } = await joinRegister(m, time, 'KASSA2', { requireCode: true })
  tt.after(() => r1.close())
  await cashierShift(r1)
  time.now += 29 * DAY
  r1.gw.tick()
  assert.equal((await sell(r1, p)).status, 201, 'месяц без главного — работает')
  time.now += 2 * DAY
  r1.gw.tick()
  const a = r1.gw.status().activation
  assert.deepEqual([a.active, a.lease], [false, true])
  assert.match((await sell(r1, p)).data.message, /больше месяца не получала подтверждения/)
  // Главный включили: он присылает сведения (раз в сутки), касса снова работает
  await m.login()
  m.gw.tick()
  await swap(r1)
  assert.equal(r1.gw.status().activation.active, true)
  assert.equal((await sell(r1, p)).status, 201)
})

test('часы кассы переведены на год назад — срок на кассе всё равно по часам главного', async (tt) => {
  const time = { now: NOW }
  const { m, p } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  const behind = {
    get now() {
      return time.now - 365 * DAY
    },
  }
  const code = m.gw.standalone.pairStart().code
  await listening(m)
  const r1 = computer('KASSA2', { time: behind, udpFind: m.lan.udpPort(), requireCode: true })
  tt.after(() => r1.close())
  assert.equal((await r1.gw.standalone.join({ code, address: `127.0.0.1:${m.lan.port()}` })).ok, true)
  await cashierShift(r1)
  assert.equal((await sell(r1, p)).status, 201)
  // Пробный срок главного кончился (15-й день) — на кассе тоже, хоть по её часам прошёл год назад
  time.now += 15 * DAY
  r1.gw.tick()
  const a = r1.gw.status().activation
  assert.deepEqual([a.active, a.expired], [false, true])
  assert.equal((await sell(r1, p)).status, 403)
})

test('срок вышел — логотип и «Разобрался» тоже не меняют (только просмотр)', async (tt) => {
  const time = { now: NOW }
  const { m } = await mainShop(time, { requireCode: true })
  tt.after(() => m.close())
  time.now += 20 * DAY
  m.gw.tick()
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc5ba0e0000000049454e44ae426082', 'hex').toString('base64')
  assert.equal((await m.req('POST', '/shop/logo', { logo: png })).status, 403)
  assert.equal((await m.req('POST', '/discrepancies/x/resolve')).status, 403)
  assert.equal((await m.req('GET', '/shop/logo')).status, 200)
})
