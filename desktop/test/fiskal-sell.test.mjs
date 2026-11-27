// ── Фискализация продажи и смены через шлюз (с поддельным устройством) ──
//
// Главное правило владельца: нет фискального чека — нет продажи. Проверяем на настоящем
// шлюзе с поддельным фискальным принтером: успех — чек записан и устройство получило его;
// отказ устройства — продажа отклонена, товар и деньги не тронуты; долг не фискализируется;
// выключенный модуль устройство не трогает.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { createGateway } from '../src/gateway.mjs'
import { NOW, product } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from '../test-support/server.mjs'

// Поддельный фискальный принтер: помнит, что ему посылали, и отвечает по сценарию.
// receipt — отказ на formReceipt; fail — отказ на конкретный метод { endpoint: результат }.
function fakeFiskal({ enabled = true, receipt = null, fail = {} } = {}) {
  const calls = []
  const byEndpoint = { ...(receipt ? { formReceipt: receipt } : {}), ...fail }
  return {
    calls,
    enabled: () => enabled,
    config: () => ({ taxType: 'GENERAL', vatCode: 'STANDARD', commodity: 'GOODS' }),
    send: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (byEndpoint[endpoint]) return byEndpoint[endpoint]
      return { ok: true, data: { fdNumber: calls.length, fpd: 'FPD' }, fd: { fdNumber: calls.length, fpd: 'FPD' } }
    },
    status: async () => ({ ok: true, data: { shiftStatus: true } }),
  }
}

function shop({ modulesOff = [], fiskal } = {}) {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('kassir', 'Parol-123', 'founder')
  srv.state.pharmacy.modulesOff = modulesOff
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  const core = openDb(':memory:', CORE_SCHEMA)
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'finmax-fiskal-'))
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
    fiskal,
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  return {
    gw,
    srv,
    core,
    req,
    login: () => req('POST', '/auth/login', { name: 'kassir', password: 'Parol-123' }),
  }
}

async function ready(t) {
  assert.equal((await t.login()).status, 201)
  await t.gw.syncNow()
}
const stockOf = async (t, id) => (await t.req('GET', '/products')).data.find((p) => p.id === id)?.stock

test('успех: смена и продажа пробиты на устройстве, чек записан', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)

  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201)

  // Устройство получило открытие смены и чек прихода
  assert.ok(fk.calls.some((c) => c.endpoint === 'openShift'))
  const rcpt = fk.calls.find((c) => c.endpoint === 'formReceipt')
  assert.ok(rcpt, 'formReceipt послан')
  assert.equal(rcpt.payload.receiptSum, 15000) // 150 сомони = 15000 дирамов
  assert.equal(rcpt.payload.receiptCash, 15000)
  assert.equal(rcpt.payload.operationType, 'INCOME')
  assert.equal(rcpt.payload.products[0].sum, 15000)
  // Чек записан, товар списан
  assert.equal((await t.req('GET', '/sales')).data.length, 1)
  assert.equal(await stockOf(t, 'nur'), 4)
})

test('нет чека — нет продажи: устройство недоступно → отказ 409, товар и чек не тронуты', async (tt) => {
  const fk = fakeFiskal({ receipt: { ok: false, net: 'unreachable' } })
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)

  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 409)
  assert.match(sale.data.message, /фискальный принтер не отвечает/i)
  // Продажа не записана, остаток не изменился
  assert.equal((await t.req('GET', '/sales')).data.length, 0)
  assert.equal(await stockOf(t, 'nur'), 5)
})

test('долг не фискализируется: устройство чек не получает, продажа проходит', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const cust = await t.req('POST', '/customers', { name: 'Иван Клиент' })
  assert.equal(cust.status, 201)

  const sale = await t.req('POST', '/sales', { payment: 'debt', customerId: cust.data.id, items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201)
  assert.equal(
    fk.calls.filter((c) => c.endpoint === 'formReceipt').length,
    0,
    'чек прихода в долг не пробивается',
  )
  assert.equal((await t.req('GET', '/sales')).data.length, 1)
})

test('модуль «Фискальный принтер» выключен — устройство не трогаем', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ modulesOff: ['fiskal'], fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  assert.equal((await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })).status, 201)
  assert.equal(fk.calls.length, 0, 'ни одного обращения к устройству')
})

test('смена кассы открыта, а на устройстве закрыта → чек сам открывает смену и проходит', async (tt) => {
  // Устройство: смена то открыта, то нет; чек без открытой смены — SHIFT_MUST_BE_OPENED
  let deviceShift = false
  const calls = []
  const fk = {
    calls,
    enabled: () => true,
    config: () => ({ taxType: 'GENERAL', vatCode: 'STANDARD', commodity: 'GOODS' }),
    send: async (endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'openShift') {
        deviceShift = true
        return { ok: true, data: {}, fd: {} }
      }
      if (endpoint === 'formReceipt') {
        if (!deviceShift) return { ok: false, code: 'SHIFT_MUST_BE_OPENED' }
        return { ok: true, data: { fdNumber: 1 }, fd: { fdNumber: 1 } }
      }
      return { ok: true, data: {}, fd: {} }
    },
    status: async () => ({ ok: true, data: {} }),
  }
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201) // открыла смену устройства
  deviceShift = false // устройство «перезагрузилось» — смена на нём пропала

  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201, 'продажа прошла после авто-переоткрытия смены')
  // Чек пробивался дважды: первый раз — отказ «смена не открыта», второй — после openShift
  assert.equal(calls.filter((c) => c === 'formReceipt').length, 2)
  assert.equal((await t.req('GET', '/sales')).data.length, 1)
})

test('устройство отказало (нет бумаги) → продажа отклонена с понятным текстом', async (tt) => {
  const fk = fakeFiskal({ receipt: { ok: false, code: 'OUT_OF_PAPER' } })
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 409)
  assert.match(sale.data.message, /бумага/i)
  assert.equal(await stockOf(t, 'nur'), 5)
})

// ── Фаза 2: возвраты ──
test('возврат фискализируется как REVERT_INCOME; товар на полке, возврат записан', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const sale = await t.req('POST', '/sales', { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201)
  const ret = await t.req('POST', '/returns', { saleId: sale.data.id, refund: 'cash', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(ret.status, 201)
  const rcpt = fk.calls.filter((c) => c.endpoint === 'formReceipt')
  assert.equal(rcpt.length, 2, 'приход (продажа) и возврат прихода')
  assert.equal(rcpt[1].payload.operationType, 'REVERT_INCOME')
  assert.equal(rcpt[1].payload.receiptSum, 15000)
  assert.equal(rcpt[1].payload.receiptCash, 15000)
  assert.equal((await t.req('GET', '/returns')).data.length, 1)
  assert.equal(await stockOf(t, 'nur'), 5) // продали 1 (5→4), вернули на полку (4→5)
})

test('нет чека — нет возврата: устройство недоступно → 409, товар и возврат не тронуты', async (tt) => {
  const fk = fakeFiskal({ fail: { formReceipt: { ok: false, net: 'unreachable' } } })
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const ret = await t.req('POST', '/returns', { refund: 'cash', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(ret.status, 409)
  assert.equal((await t.req('GET', '/returns')).data.length, 0)
  assert.equal(await stockOf(t, 'nur'), 5) // на полку не вернулся
})

test('возврат в долг не фискализируется', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const cust = await t.req('POST', '/customers', { name: 'Иван Клиент' })
  const sale = await t.req('POST', '/sales', { payment: 'debt', customerId: cust.data.id, items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.status, 201)
  const before = fk.calls.filter((c) => c.endpoint === 'formReceipt').length
  const ret = await t.req('POST', '/returns', { saleId: sale.data.id, refund: 'debt', items: [{ productId: 'nur', units: 1 }] })
  assert.equal(ret.status, 201)
  assert.equal(fk.calls.filter((c) => c.endpoint === 'formReceipt').length, before, 'возврат в долг чек не шлёт')
})

// ── Фаза 2: внесение/изъятие ──
test('внесение наличных фискализируется (addCash)', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  assert.equal((await t.req('POST', '/shifts/cash', { kind: 'in', amount: 100 })).status, 201)
  const add = fk.calls.find((c) => c.endpoint === 'addCash')
  assert.ok(add, 'addCash послан')
  assert.equal(add.payload.addAmount, 10000) // 100 сомони = 10000 дирамов
  assert.equal((await t.req('GET', '/cash-moves')).data.length, 1)
})

test('изъятие при сбое устройства — блок, запись не заводится', async (tt) => {
  const fk = fakeFiskal({ fail: { removeCash: { ok: false, code: 'BALANCE_IS_NEGATIVE' } } })
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  assert.equal((await t.req('POST', '/shifts/open', { openingCash: 0 })).status, 201)
  const r = await t.req('POST', '/shifts/cash', { kind: 'out', amount: 50 })
  assert.equal(r.status, 409)
  assert.match(r.data.message, /недостаточно наличных для изъятия/i)
  assert.equal((await t.req('GET', '/cash-moves')).data.length, 0)
})

// ── Фаза 2: X-отчёт ──
test('X-отчёт: шлюз зовёт getXReport на устройстве', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  const r = await t.gw.fiskalXReport()
  assert.equal(r.ok, true)
  assert.ok(fk.calls.some((c) => c.endpoint === 'getXReport'))
})

test('X-отчёт: модуль выключен → устройство не трогаем', async (tt) => {
  const fk = fakeFiskal()
  const t = shop({ modulesOff: ['fiskal'], fiskal: fk })
  tt.after(() => t.gw.close())
  await ready(t)
  const r = await t.gw.fiskalXReport()
  assert.equal(r.ok, false)
  assert.equal(fk.calls.length, 0)
})
