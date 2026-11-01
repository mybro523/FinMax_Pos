// ── Код активации (версия 1.6.0): программа читает коды, выпущенные сервером ──
// Образцы (licence-vectors.json) выпущены серверным расчётом (server/test/licence-code.test.js):
// если формулы разойдутся, программа перестанет принимать коды сервера — эта проверка упадёт.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clean32, computerCodeOf, computerRawOf, dateOfDay, endOfDayMs, FOREVER, formatComputer, readCode, todayDay, validKey } from '../src/local/licence-code.mjs'
import { LICENCE_PUBLIC_KEY } from '../scripts/licence-pin.mjs'

const V = JSON.parse(readFileSync(new URL('./licence-vectors.json', import.meta.url), 'utf8'))
const MACHINE = 'C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F'

test('код компьютера — тот же, что посчитал сервер', () => {
  assert.equal(computerCodeOf(MACHINE), V.computer)
  assert.equal(computerCodeOf(MACHINE.toLowerCase()), V.computer)
  assert.equal(formatComputer(computerRawOf(MACHINE)), V.computer)
})

test('код активации сервера читается: срок, число касс, номер', () => {
  assert.equal(validKey(V.publicKey), true)
  const r = readCode(V.publicKey, computerRawOf(MACHINE), V.code)
  assert.equal(r.ok, true)
  assert.deepEqual(r.fields, { kind: 'activate', until: r.fields.until, registers: 2, serial: 7 })
  assert.equal(dateOfDay(r.fields.until), '2027-11-01')
  const reset = readCode(V.publicKey, computerRawOf(MACHINE), V.reset)
  assert.equal(reset.ok, true)
  assert.equal(reset.fields.kind, 'reset')
  assert.equal(reset.fields.serial, 4242)
})

test('чужой компьютер, чужой ключ, порча и опечатка — не проходят', () => {
  const other = computerRawOf('другой компьютер')
  assert.deepEqual(readCode(V.publicKey, other, V.code), { ok: false, why: 'bad' })
  const otherKey = V.publicKey.slice(0, 63) + (V.publicKey[63] === '0' ? '1' : '0')
  assert.equal(readCode(otherKey, computerRawOf(MACHINE), V.code).ok, false)
  const plain = clean32(V.code)
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i] === 'A' ? 'B' : 'A'
    assert.equal(readCode(V.publicKey, computerRawOf(MACHINE), plain.slice(0, i) + ch + plain.slice(i + 1)).ok, false, 'знак ' + i)
  }
  assert.deepEqual(readCode(V.publicKey, computerRawOf(MACHINE), plain.slice(0, 49)), { ok: false, why: 'typo' })
  // Ввод как попало — строчными, пробелами, O вместо нуля
  assert.equal(readCode(V.publicKey, computerRawOf(MACHINE), V.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')).ok, true)
})

test('дни по Душанбе: срок действует весь последний день', () => {
  assert.equal(todayDay(Date.UTC(2026, 0, 1, 0, 0)), 0)
  // 1 ноября 2027 по Душанбе заканчивается в 19:00 UTC
  const day = Math.round((Date.UTC(2027, 10, 1) - Date.UTC(2026, 0, 1)) / 86400000)
  assert.equal(endOfDayMs(day), Date.UTC(2027, 10, 1, 19, 0))
  assert.equal(todayDay(Date.UTC(2027, 10, 1, 18, 59)), day)
  assert.equal(todayDay(Date.UTC(2027, 10, 1, 19, 0)), day + 1)
  assert.equal(FOREVER, 65535)
})

// Ключ, закреплённый для сборок (scripts/licence-pin.mjs), — тот же, что закреплён на сервере
// (server/src/common/licence-pin.ts): иначе сервер выпускал бы коды, которые программы не примут
test('закреплённый ключ: в программе и на сервере один и тот же, и это не проверочный', () => {
  const server = readFileSync(new URL('../../server/src/common/licence-pin.ts', import.meta.url), 'utf8')
  const m = /LICENCE_PUBLIC_KEY = '([0-9a-f]*)'/.exec(server)
  assert.ok(m, 'в server/src/common/licence-pin.ts нет LICENCE_PUBLIC_KEY')
  assert.equal(LICENCE_PUBLIC_KEY, m[1])
  if (LICENCE_PUBLIC_KEY) assert.equal(validKey(LICENCE_PUBLIC_KEY), true)
  // Секретная половина проверочного ключа лежит в открытых тестах — закреплённым он быть не может
  assert.notEqual(LICENCE_PUBLIC_KEY, V.publicKey)
})
