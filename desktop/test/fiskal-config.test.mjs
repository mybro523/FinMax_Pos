// ── Настройки фискального принтера ──
import test from 'node:test'
import assert from 'node:assert/strict'
import { FISKAL_DEFAULTS, sanitizeFiskal } from '../src/local/fiskal/config.mjs'

test('по умолчанию — выключено и пусто', () => {
  assert.deepEqual(sanitizeFiskal(null), FISKAL_DEFAULTS)
  assert.equal(sanitizeFiskal(undefined).enabled, false)
  assert.equal(sanitizeFiskal({}).port, 8002)
})

test('адрес — только из сети магазина; порт и перечисления — в своих пределах', () => {
  const ok = sanitizeFiskal({ enabled: true, host: '192.168.0.10', port: 8002, taxType: 'SIMPLIFIED1', vatCode: 'REDUCED2', commodity: 'SERVICE' })
  assert.deepEqual(ok, { enabled: true, host: '192.168.0.10', port: 8002, taxType: 'SIMPLIFIED1', vatCode: 'REDUCED2', commodity: 'SERVICE' })
  // Публичный адрес отбрасывается
  assert.equal(sanitizeFiskal({ host: '8.8.8.8' }).host, '')
  // Негодный порт → 8002, негодные перечисления → умолчания
  assert.equal(sanitizeFiskal({ port: 0 }).port, 8002)
  assert.equal(sanitizeFiskal({ port: 70000 }).port, 8002)
  assert.equal(sanitizeFiskal({ taxType: 'НЕТ' }).taxType, 'GENERAL')
  assert.equal(sanitizeFiskal({ vatCode: 'НЕТ' }).vatCode, 'STANDARD')
  assert.equal(sanitizeFiskal({ commodity: 'НЕТ' }).commodity, 'GOODS')
  // enabled — строго булево true
  assert.equal(sanitizeFiskal({ enabled: 'yes' }).enabled, false)
  assert.equal(sanitizeFiskal({ enabled: 1 }).enabled, false)
})
