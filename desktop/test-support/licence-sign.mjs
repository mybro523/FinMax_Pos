// ── Выпуск кодов активации для проверок ──
// Тот же расчёт, что у сервера (server/src/common/licence-code.ts, issueCode): проверкам
// программы нужны коды на разные сроки и случаи, а сервер в них не участвует. Что расчёт тот
// же — сверяют серверные образцы (test/licence-vectors.json, test/local-standalone.test.mjs)
import { createHash, createHmac, randomBytes } from 'node:crypto'

const P = 0xfffffffdffffffffffffffffffffffffn
const A = 0xfffffffdfffffffffffffffffffffffcn
const N = 0xfffffffe0000000075a30d1b9038a115n
const G = { x: 0x161ff7528b899b2d0c28607ca52c5b86n, y: 0xcf5ac8395bafeb13c02da292dded7a83n }
const mod = (a, m = P) => ((a % m) + m) % m
function inv(a, m = P) {
  let [t, nt, r, nr] = [0n, 1n, m, mod(a, m)]
  while (nr) {
    const q = r / nr
    ;[t, nt] = [nt, t - q * nt]
    ;[r, nr] = [nr, r - q * nr]
  }
  return mod(t, m)
}
const dbl = (p) => {
  if (!p || p.y === 0n) return null
  const l = mod((3n * p.x * p.x + A) * inv(2n * p.y))
  const x = mod(l * l - 2n * p.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
const add = (p, q) => {
  if (!p) return q
  if (!q) return p
  if (p.x === q.x) return mod(p.y + q.y) === 0n ? null : dbl(p)
  const l = mod((q.y - p.y) * inv(q.x - p.x))
  const x = mod(l * l - p.x - q.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
const mul = (k, p) => {
  let r = null
  for (const b of k.toString(2)) {
    r = dbl(r)
    if (b === '1') r = add(r, p)
  }
  return r
}
const toBytes = (v, len) => Buffer.from(v.toString(16).padStart(len * 2, '0'), 'hex')
const toBig = (b) => BigInt('0x' + b.toString('hex'))
const pointBytes = (p) => Buffer.concat([toBytes(p.x, 16), toBytes(p.y, 16)])
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function encode32(bytes) {
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}
const check2 = (tag, data) => encode32(sha(Buffer.from(tag), data).subarray(0, 2)).slice(0, 2)
const groups = (s) => s.match(/.{1,5}/g).join('-')

export function makeKeys() {
  let x = 0n
  while (x === 0n || x >= N) x = toBig(randomBytes(16))
  return { privateKey: toBytes(x, 16).toString('hex'), publicKey: pointBytes(mul(x, G)).toString('hex') }
}
export const publicOf = (privateKey) => pointBytes(mul(BigInt('0x' + privateKey), G)).toString('hex')

function sign(privateKey, msg) {
  const x = BigInt('0x' + privateKey)
  const pub = pointBytes(mul(x, G))
  const k = mod(toBig(createHmac('sha256', toBytes(x, 16)).update(Buffer.concat([Buffer.from('FMX-NONCE-1'), Buffer.from('FMX-LIC-1'), pub, msg])).digest()), N - 1n) + 1n
  const e = toBig(sha(Buffer.from('FMX-LIC-1'), pointBytes(mul(k, G)), pub, msg).subarray(0, 8))
  const s = mod(k + e * x, N)
  return Buffer.concat([toBytes(e, 8), toBytes(s, 16)])
}

const EPOCH = Date.UTC(2026, 0, 1)
export const dayOf = (date) => Math.round((Date.parse(date + 'T00:00:00Z') - EPOCH) / 86400000)
export const todayDay = (now) => Math.floor((now + 5 * 3600000 - EPOCH) / 86400000)
export const FOREVER = 0xffff

// computerRaw — 5 байт кода компьютера; kind — 'activate' | 'reset'
export function issueCode(privateKey, computerRaw, { kind = 'activate', until, registers = 1, serial = 1 }) {
  const payload = Buffer.alloc(6)
  payload[0] = 0x10 | (kind === 'reset' ? 2 : 1)
  payload.writeUInt16BE(until, 1)
  payload[3] = registers
  payload.writeUInt16BE(serial & 0xffff, 4)
  const body = Buffer.concat([payload, sign(privateKey, Buffer.concat([Buffer.from('FMX-CODE-1'), computerRaw, payload]))])
  return groups(encode32(body) + check2('FMX-CHK', body))
}
