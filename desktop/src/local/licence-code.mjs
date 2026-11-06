// ── Код активации программы без интернета (версия 1.6.0): проверка ──
//
// Тот же расчёт, что на сервере (server/src/common/licence-code.ts), но только чтение:
// секретного ключа здесь нет, только открытый (build-config.json, licenceKey). Подпись —
// схема Шнорра на кривой secp128r1 с 64-битным «вызовом»; подделать код без секретного
// ключа нельзя, перенести на другой компьютер тоже — подпись покрывает код компьютера.
// Меняется только вместе с сервером: обе стороны сверяют одни образцы (licence-vectors.json).
//
// Электрон собран с BoringSSL, а в нём этой кривой нет — поэтому арифметика своя, на BigInt.
// Она короткая, и тесты сверяют её с OpenSSL (server/test/licence-code.test.js).
import { createHash } from 'node:crypto'

const P = 0xfffffffdffffffffffffffffffffffffn
const A = 0xfffffffdfffffffffffffffffffffffcn
const B = 0xe87579c11079f43dd824993c2cee5ed3n
const N = 0xfffffffe0000000075a30d1b9038a115n
const G = { x: 0x161ff7528b899b2d0c28607ca52c5b86n, y: 0xcf5ac8395bafeb13c02da292dded7a83n }

const mod = (a, m = P) => {
  const r = a % m
  return r >= 0n ? r : r + m
}
function inv(a, m = P) {
  let t = 0n
  let nt = 1n
  let r = m
  let nr = mod(a, m)
  while (nr !== 0n) {
    const q = r / nr
    ;[t, nt] = [nt, t - q * nt]
    ;[r, nr] = [nr, r - q * nr]
  }
  if (r !== 1n) throw new Error('нет обратного')
  return mod(t, m)
}
function dbl(p) {
  if (!p || p.y === 0n) return null
  const l = mod((3n * p.x * p.x + A) * inv(2n * p.y))
  const x = mod(l * l - 2n * p.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
function add(p, q) {
  if (!p) return q
  if (!q) return p
  if (p.x === q.x) return mod(p.y + q.y) === 0n ? null : dbl(p)
  const l = mod((q.y - p.y) * inv(q.x - p.x))
  const x = mod(l * l - p.x - q.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
function mul(k, p) {
  let r = null
  for (const bit of k.toString(2)) {
    r = dbl(r)
    if (bit === '1') r = add(r, p)
  }
  return r
}
const neg = (p) => (p ? { x: p.x, y: mod(-p.y) } : null)
const onCurve = (p) => !!p && p.x < P && p.y < P && mod(p.y * p.y - (p.x * p.x * p.x + A * p.x + B)) === 0n

const toBytes = (v, len) => Buffer.from(v.toString(16).padStart(len * 2, '0'), 'hex')
const toBig = (b) => (b.length ? BigInt('0x' + b.toString('hex')) : 0n)
const pointBytes = (p) => Buffer.concat([toBytes(p.x, 16), toBytes(p.y, 16)])
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
const TAG = Buffer.from('FMX-LIC-1')

// Открытый ключ годится: 64 знака hex и точка на кривой
export function validKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return false
  return onCurve({ x: BigInt('0x' + hex.slice(0, 32)), y: BigInt('0x' + hex.slice(32)) })
}

function verify(publicKey, msg, sig) {
  if (sig.length !== 24 || !validKey(publicKey)) return false
  const pub = { x: BigInt('0x' + publicKey.slice(0, 32)), y: BigInt('0x' + publicKey.slice(32)) }
  const e = toBig(sig.subarray(0, 8))
  const s = toBig(sig.subarray(8))
  if (s === 0n || s >= N) return false
  const r = add(mul(s, G), neg(mul(e, pub)))
  if (!r) return false
  return toBig(sha(TAG, pointBytes(r), pointBytes(pub), msg).subarray(0, 8)) === e
}

// ── Знаки кода: base32 Крокфорда ──
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function encode32(bytes) {
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}
// Ввод человека: регистр не важен, O → 0, I и L → 1, пробелы и дефисы не в счёт
export function clean32(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}
function decode32(text, bytes) {
  let bits = ''
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    bits += v.toString(2).padStart(5, '0')
  }
  if (bits.length < bytes * 8) return null
  const out = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  return out
}
const check2 = (tag, data) => encode32(sha(Buffer.from(tag), data).subarray(0, 2)).slice(0, 2)
const groups = (s) => s.match(/.{1,5}/g).join('-')

// ── Код компьютера: из постоянного номера Windows (MachineGuid) ──
// 5 байт + 2 знака проверки = «XXXXX-XXXXX». Тот же номер — тот же код при каждом запуске
export function computerRawOf(machineId) {
  return sha(Buffer.from('FMX-PC-1'), Buffer.from(String(machineId).trim().toLowerCase())).subarray(0, 5)
}
export const formatComputer = (raw) => groups(encode32(raw) + check2('FMX-PCC', raw))
export const computerCodeOf = (machineId) => formatComputer(computerRawOf(machineId))
// Код компьютера «XXXXX-XXXXX» → его 5 байт (касса проверяет код активации главного по коду
// компьютера главного, 1.7.1). Опечатка или не код — null
export function computerRawFromCode(text) {
  const c = clean32(text)
  if (c.length !== 10) return null
  const raw = decode32(c.slice(0, 8), 5)
  return raw && check2('FMX-PCC', raw) === c.slice(8) ? raw : null
}

// ── Дни: от 1 января 2026 по Душанбе (UTC+5) ──
const TZ_MS = 5 * 3600000
const EPOCH = Date.UTC(2026, 0, 1)
const DAY = 86400000
export const FOREVER = 0xffff
export const todayDay = (now) => Math.floor((now + TZ_MS - EPOCH) / DAY)
export const dateOfDay = (day) => new Date(EPOCH + day * DAY).toISOString().slice(0, 10)
// Конец дня «до» — первое мгновение следующего дня по Душанбе: срок действует весь этот день
export const endOfDayMs = (day) => EPOCH + (day + 1) * DAY - TZ_MS

const KINDS = { 1: 'activate', 2: 'reset' }
const message = (computer, payload) => Buffer.concat([Buffer.from('FMX-CODE-1'), computer, payload])

// ── Прочитать код ──
// { ok: true, fields: { kind, until, registers, serial } } или { ok: false, why }:
// 'typo' — опечатка (не сошлась проверка), 'bad' — код не для этого компьютера или подделан
export function readCode(publicKey, computerRaw, text) {
  const c = clean32(text)
  if (c.length !== 50) return { ok: false, why: 'typo' }
  const body = decode32(c.slice(0, 48), 30)
  if (!body || check2('FMX-CHK', body) !== c.slice(48)) return { ok: false, why: 'typo' }
  const payload = body.subarray(0, 6)
  if (payload[0] >> 4 !== 1) return { ok: false, why: 'bad' }
  const kind = KINDS[payload[0] & 0x0f]
  if (!kind) return { ok: false, why: 'bad' }
  if (!verify(publicKey, message(computerRaw, payload), body.subarray(6))) return { ok: false, why: 'bad' }
  return { ok: true, fields: { kind, until: payload.readUInt16BE(1), registers: payload[3], serial: payload.readUInt16BE(4) } }
}
