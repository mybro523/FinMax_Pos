// ── Код активации (версия 1.6.0) ──
// Подпись Шнорра на secp128r1: арифметика кривой сверяется с OpenSSL, код — с подделкой,
// опечаткой и чужим компьютером. Образцы в конце — те же, что проверяет программа
// (desktop/test/licence-code.test.mjs): если они разойдутся, коды сервера программа не примет.
// Запуск: npm test (в папке server; сначала собирается dist)
const test = require('node:test')
const assert = require('node:assert/strict')
const { createECDH, randomBytes } = require('node:crypto')
const L = require('../dist/common/licence-code')

const G = { x: 0x161ff7528b899b2d0c28607ca52c5b86n, y: 0xcf5ac8395bafeb13c02da292dded7a83n }
const N = 0xfffffffe0000000075a30d1b9038a115n

test('кривая: G на кривой, n·G — бесконечность, k·G совпадает с OpenSSL', () => {
  assert.equal(L.onCurve(G), true)
  assert.equal(L.mul(N, G), null)
  for (let i = 0; i < 12; i++) {
    const ecdh = createECDH('secp128r1')
    const d = randomBytes(16)
    // Ключ должен быть меньше n
    d[0] &= 0x7f
    ecdh.setPrivateKey(d)
    const want = ecdh.getPublicKey('hex').slice(2)
    const got = L.mul(BigInt('0x' + d.toString('hex')), G)
    assert.equal(got.x.toString(16).padStart(32, '0') + got.y.toString(16).padStart(32, '0'), want)
  }
})

test('подпись: верная проходит, любая порча — нет', () => {
  const { privateKey, publicKey } = L.makeKeys()
  assert.equal(L.publicOf(privateKey), publicKey)
  const msg = Buffer.from('магазин 1')
  const sig = L.sign(privateKey, msg)
  assert.equal(sig.length, 24)
  assert.equal(L.verify(publicKey, msg, sig), true)
  assert.equal(L.verify(publicKey, Buffer.from('магазин 2'), sig), false)
  for (let i = 0; i < sig.length; i++) {
    const bad = Buffer.from(sig)
    bad[i] ^= 1 << i % 8
    assert.equal(L.verify(publicKey, msg, bad), false, 'испорчен байт ' + i)
  }
  // Чужой ключ
  assert.equal(L.verify(L.makeKeys().publicKey, msg, sig), false)
  // Подпись одного сообщения детерминирована (одноразовое число — из ключа и сообщения)
  assert.deepEqual(L.sign(privateKey, msg), sig)
})

test('код компьютера: 10 знаков, опечатку видно, буквы O/I/L и регистр прощаются', () => {
  const code = L.computerCodeOf('8f1c2b3a-0000-4abc-9def-1234567890ab')
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
  assert.equal(L.computerCodeOf('8F1C2B3A-0000-4ABC-9DEF-1234567890AB'), code, 'регистр GUID не важен')
  const raw = L.parseComputerCode(code)
  assert.equal(raw.length, 5)
  assert.equal(L.formatComputerCode(raw), code)
  assert.deepEqual(L.parseComputerCode(code.toLowerCase().replace('-', ' ')), raw)
  // Опечатка в любом знаке ловится
  const plain = code.replace('-', '')
  let caught = 0
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i] === 'A' ? 'B' : 'A'
    if (!L.parseComputerCode(plain.slice(0, i) + ch + plain.slice(i + 1))) caught++
  }
  assert.ok(caught >= 9, 'опечаток поймано ' + caught + ' из 10')
})

test('код активации: 50 знаков, читается только на своём компьютере, порча и опечатка ловятся', () => {
  const { privateKey, publicKey } = L.makeKeys()
  const pc = L.parseComputerCode(L.computerCodeOf('pc-1'))
  const other = L.parseComputerCode(L.computerCodeOf('pc-2'))
  const until = L.dayOf('2027-11-01')
  const code = L.issueCode(privateKey, pc, { kind: 'activate', until, registers: 3, serial: 17 })
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{5}-){9}[0-9A-HJKMNP-TV-Z]{5}$/)
  const r = L.readCode(publicKey, pc, code)
  assert.deepEqual(r, { ok: true, fields: { kind: 'activate', until, registers: 3, serial: 17 } })
  assert.equal(L.dateOfDay(r.fields.until), '2027-11-01')
  // Тот же код на другом компьютере — «не подходит», а не «опечатка»
  assert.deepEqual(L.readCode(publicKey, other, code), { ok: false, why: 'bad' })
  // Чужой ключ (поддельный сервис)
  assert.deepEqual(L.readCode(L.makeKeys().publicKey, pc, code), { ok: false, why: 'bad' })
  // Опечатка в одном знаке
  const plain = L.clean32(code)
  let typos = 0
  let bad = 0
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i] === 'A' ? 'B' : 'A'
    const res = L.readCode(publicKey, pc, plain.slice(0, i) + ch + plain.slice(i + 1))
    assert.equal(res.ok, false, 'знак ' + i)
    if (res.why === 'typo') typos++
    else bad++
  }
  assert.ok(typos >= 45, 'как опечатка поймано ' + typos + ' из 50 (остальное — «не подходит»: ' + bad + ')')
  // Ввод как попало: строчными, через пробелы, с O вместо нуля
  assert.equal(L.readCode(publicKey, pc, code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')).ok, true)
  // Код сброса пароля — свой вид
  const reset = L.issueCode(privateKey, pc, { kind: 'reset', until: L.todayDay(Date.now()) + 2, registers: 0, serial: 40001 })
  assert.equal(L.readCode(publicKey, pc, reset).fields.kind, 'reset')
  // «Навсегда»
  const forever = L.issueCode(privateKey, pc, { kind: 'activate', until: L.FOREVER, registers: 1, serial: 1 })
  assert.equal(L.readCode(publicKey, pc, forever).fields.until, L.FOREVER)
})

test('дни: 1 января 2026 — день 0, сегодня — по Душанбе (UTC+5)', () => {
  assert.equal(L.dayOf('2026-01-01'), 0)
  assert.equal(L.dayOf('2027-01-01'), 365)
  assert.equal(L.dateOfDay(L.dayOf('2026-11-01')), '2026-11-01')
  // 31 декабря 2026, 19:30 UTC — в Душанбе уже 1 января 2027
  assert.equal(L.todayDay(Date.UTC(2026, 11, 31, 19, 30)), 365)
  assert.equal(L.todayDay(Date.UTC(2026, 11, 31, 18, 30)), 364)
})

// Образцы для программы: ключ, компьютер и коды, выпущенные этим расчётом. Программа
// (desktop/test/licence-code.test.mjs) читает их своим — так обе стороны держат одну формулу
const VECTORS = {
  privateKey: '2f6d0b9a8c7e5d4f3a2b1c0d9e8f7a6b',
  machine: 'C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F',
}
test('образцы для программы', () => {
  const publicKey = L.publicOf(VECTORS.privateKey)
  const computer = L.computerCodeOf(VECTORS.machine)
  const pc = L.parseComputerCode(computer)
  const code = L.issueCode(VECTORS.privateKey, pc, { kind: 'activate', until: L.dayOf('2027-11-01'), registers: 2, serial: 7 })
  const reset = L.issueCode(VECTORS.privateKey, pc, { kind: 'reset', until: L.dayOf('2026-11-03'), registers: 0, serial: 4242 })
  const expected = require('./licence-vectors.json')
  assert.deepEqual({ publicKey, computer, code, reset }, expected)
})
