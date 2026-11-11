// ── Табло покупателя на COM-порту (1.7.6): настройка и запись в порт ──
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTabloWriter, PORT_PREFIX, portsFrom, sanitizeTablo, tabloBytesIn } from '../src/tablo.mjs'
import { sanitizeSettings } from '../src/settings.mjs'

test('настройка табло: по умолчанию выключено; порт COMn; скорость по виду', () => {
  assert.deepEqual(sanitizeTablo(null), { vid: 'off', baud: 2400, port: '' })
  assert.deepEqual(sanitizeTablo({ vid: 'vfd', port: 'com3' }), { vid: 'vfd', baud: 9600, port: 'COM3' })
  assert.deepEqual(sanitizeTablo({ vid: 'led8', baud: 19200, port: 'LPT1' }), { vid: 'led8', baud: 19200, port: '' })
  assert.deepEqual(sanitizeSettings({}).tablo, { vid: 'off', baud: 2400, port: '' })
})

test('список портов Windows и байты из окна', () => {
  assert.deepEqual(portsFrom('COM10,COM3,COM1\r\n'), ['COM1', 'COM3', 'COM10'])
  assert.deepEqual(portsFrom(''), [])
  assert.deepEqual([...tabloBytesIn([27, 64, 12])], [27, 64, 12])
  assert.equal(tabloBytesIn([256]), null)
  assert.equal(tabloBytesIn('x'), null)
  assert.equal(tabloBytesIn([]), null)
})

test('запись: скорость порта ставится один раз, байты — в порт COMn; ошибка — словами', async () => {
  const modes = []
  const writes = []
  let fail = false
  const write = createTabloWriter({
    runMode: async (port, args) => modes.push(args.join(' ')),
    openPort: async (path, buf) => {
      if (fail) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      writes.push([path, [...buf]])
    },
  })
  const cfg = { vid: 'led8', baud: 2400, port: 'COM3' }
  assert.deepEqual(await write(cfg, Buffer.from([1])), { ok: true })
  assert.deepEqual(await write(cfg, Buffer.from([2])), { ok: true })
  assert.deepEqual(modes, ['COM3: BAUD=2400 PARITY=N DATA=8 STOP=1'])
  assert.deepEqual(writes, [[PORT_PREFIX + 'COM3', [1]], [PORT_PREFIX + 'COM3', [2]]])
  assert.equal(PORT_PREFIX.length, 4)
  fail = true
  const r = await write(cfg, Buffer.from([3]))
  assert.equal(r.ok, false)
  assert.match(r.error, /COM3/)
  fail = false
  await write(cfg, Buffer.from([4]))
  assert.equal(modes.length, 2, 'после ошибки скорость ставится заново')
  assert.equal((await write({ vid: 'off' }, Buffer.from([1]))).ok, false)
  assert.equal((await write({ vid: 'led8' }, Buffer.from([1]))).error, 'Не выбран COM-порт табло.')
})
