// ── Связь с фискальным принтером на поддельной сети ──
// Проверяем очередь (одна задача за раз), повтор на «занято» (503), разбор ответа и
// понятные коды связи — без настоящего устройства.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFiskal } from '../src/local/fiskal/client.mjs'
import { checkHost } from '../src/print/transport.mjs'

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) })
const ok = (data) => res(200, { rc: 'SUCCESS', data })
const makeConfig = (over = {}) => () => ({ enabled: true, host: '192.168.1.50', port: 8002, taxType: 'GENERAL', vatCode: 'STANDARD', commodity: 'GOODS', ...over })
const noSleep = () => Promise.resolve()

test('выключено или нет адреса — понятный код связи, в сеть не ходим', async () => {
  let hits = 0
  const fetchImpl = async () => {
    hits++
    return ok({})
  }
  const off = createFiskal({ fetchImpl, checkHost, config: makeConfig({ enabled: false }), sleep: noSleep })
  assert.deepEqual(await off.send('deviceStatus', {}), { ok: false, net: 'disabled' })
  const noHost = createFiskal({ fetchImpl, checkHost, config: makeConfig({ host: '' }), sleep: noSleep })
  assert.deepEqual(await noHost.send('deviceStatus', {}), { ok: false, net: 'noHost' })
  // Публичный адрес checkHost не пропускает — тоже noHost
  const pub = createFiskal({ fetchImpl, checkHost, config: makeConfig({ host: '8.8.8.8' }), sleep: noSleep })
  assert.equal((await pub.send('deviceStatus', {})).net, 'noHost')
  assert.equal(hits, 0)
})

test('адрес и метод собираются верно, успех → реквизиты ФД', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return ok({ fdNumber: 5, fpd: 'ABC' })
  }
  const f = createFiskal({ fetchImpl, checkHost, config: makeConfig(), sleep: noSleep })
  const r = await f.send('formReceipt', { formCode: 'RECEIPT' })
  assert.equal(seen.url, 'http://192.168.1.50:8002/api/formReceipt')
  assert.equal(seen.init.method, 'POST')
  assert.equal(JSON.parse(seen.init.body).formCode, 'RECEIPT')
  assert.equal(r.ok, true)
  assert.equal(r.fd.fdNumber, 5)
})

test('устройство отказало (rc≠SUCCESS) → код ошибки, не бросает', async () => {
  const fetchImpl = async () => res(200, { rc: 'OUT_OF_PAPER', message: 'no paper' })
  const f = createFiskal({ fetchImpl, checkHost, config: makeConfig(), sleep: noSleep })
  const r = await f.send('formReceipt', {})
  assert.deepEqual(r, { ok: false, code: 'OUT_OF_PAPER', message: 'no paper' })
})

test('503 «занято» — повтор; успех после повторов', async () => {
  let n = 0
  const fetchImpl = async () => (++n < 3 ? res(503, {}) : ok({ fdNumber: 1 }))
  const f = createFiskal({ fetchImpl, checkHost, config: makeConfig(), sleep: noSleep })
  const r = await f.send('formReceipt', {})
  assert.equal(r.ok, true)
  assert.equal(n, 3)
})

test('503 без конца → busy; обрыв связи → unreachable; мусор → badReply', async () => {
  const busy = createFiskal({ fetchImpl: async () => res(503, {}), checkHost, config: makeConfig(), sleep: noSleep })
  assert.equal((await busy.send('formReceipt', {})).net, 'busy')
  const down = createFiskal({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    checkHost,
    config: makeConfig(),
    sleep: noSleep,
  })
  assert.equal((await down.send('formReceipt', {})).net, 'unreachable')
  const junk = createFiskal({ fetchImpl: async () => res(200, null), checkHost, config: makeConfig(), sleep: noSleep })
  assert.equal((await junk.send('formReceipt', {})).net, 'badReply')
})

test('очередь: одно устройство — один запрос за раз', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    return ok({})
  }
  const f = createFiskal({ fetchImpl, checkHost, config: makeConfig(), sleep: noSleep })
  await Promise.all([f.send('a', {}), f.send('b', {}), f.send('c', {})])
  assert.equal(maxInFlight, 1)
})
