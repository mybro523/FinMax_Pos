// ── Код активации программы без интернета (версия 1.6.0) ──
//
// Магазин без интернета работает на компьютере владельца, и сервер его не видит. Оплату
// держит код активации: программа показывает «код компьютера», владелец сервиса в своей
// панели выпускает под него код — срок и сколько касс можно подключить — и код вводится на
// компьютере магазина. Код подписан секретным ключом сервиса; в программе лежит только
// открытый ключ, поэтому код нельзя ни подделать, ни перенести на другой компьютер (подпись
// покрывает код компьютера).
//
// Код вводят руками — его диктуют по телефону или присылают в мессенджер, — поэтому он
// короткий: 50 знаков, 10 групп по 5. Отсюда выбор подписи: схема Шнорра на кривой
// secp128r1 (SEC 2) с 64-битным «вызовом» — 24 байта подписи вместо 64 у Ed25519. Подделка
// стоит ~2^64 операций — для этого применения недостижимо. Последние два знака — проверка:
// по ним программа отличает опечатку от «код не для этого компьютера».
//
// Тот же расчёт — в программе (desktop/src/local/licence-code.mjs): меняются только вместе.
// Обе стороны сверяют одни и те же образцы (test/licence-code.test.js на сервере,
// desktop/test/licence-code.test.mjs).
import { createHash, createHmac, randomBytes } from 'node:crypto'

// ── Кривая secp128r1: y² = x³ + ax + b над полем p, точка G порядка n ──
const P = 0xfffffffdffffffffffffffffffffffffn
const A = 0xfffffffdfffffffffffffffffffffffcn
const B = 0xe87579c11079f43dd824993c2cee5ed3n
const N = 0xfffffffe0000000075a30d1b9038a115n
type Point = { x: bigint; y: bigint } | null
const G: Point = { x: 0x161ff7528b899b2d0c28607ca52c5b86n, y: 0xcf5ac8395bafeb13c02da292dded7a83n }

const mod = (a: bigint, m: bigint = P) => {
  const r = a % m
  return r >= 0n ? r : r + m
}
function inv(a: bigint, m: bigint = P): bigint {
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
function dbl(p: Point): Point {
  if (!p || p.y === 0n) return null
  const l = mod((3n * p.x * p.x + A) * inv(2n * p.y))
  const x = mod(l * l - 2n * p.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
function add(p: Point, q: Point): Point {
  if (!p) return q
  if (!q) return p
  if (p.x === q.x) return mod(p.y + q.y) === 0n ? null : dbl(p)
  const l = mod((q.y - p.y) * inv(q.x - p.x))
  const x = mod(l * l - p.x - q.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}
export function mul(k: bigint, p: Point): Point {
  let r: Point = null
  for (const bit of k.toString(2)) {
    r = dbl(r)
    if (bit === '1') r = add(r, p)
  }
  return r
}
const neg = (p: Point): Point => (p ? { x: p.x, y: mod(-p.y) } : null)
export const onCurve = (p: Point) => !!p && p.x < P && p.y < P && mod(p.y * p.y - (p.x * p.x * p.x + A * p.x + B)) === 0n

// ── Байты и числа ──
const toBytes = (v: bigint, len: number) => Buffer.from(v.toString(16).padStart(len * 2, '0'), 'hex')
const toBig = (b: Buffer) => (b.length ? BigInt('0x' + b.toString('hex')) : 0n)
const pointBytes = (p: Point) => Buffer.concat([toBytes(p!.x, 16), toBytes(p!.y, 16)])
function pointOf(hex: string): Point {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('открытый ключ — 64 знака hex')
  const p = { x: BigInt('0x' + hex.slice(0, 32)), y: BigInt('0x' + hex.slice(32)) }
  if (!onCurve(p)) throw new Error('открытый ключ не лежит на кривой')
  return p
}
const sha = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()
const TAG = Buffer.from('FMX-LIC-1')
const NONCE = Buffer.from('FMX-NONCE-1')

// ── Ключи ──
export function makeKeys(): { privateKey: string; publicKey: string } {
  let x = 0n
  while (x === 0n || x >= N) x = toBig(randomBytes(16))
  return { privateKey: toBytes(x, 16).toString('hex'), publicKey: pointBytes(mul(x, G)).toString('hex') }
}
export const publicOf = (privateKey: string) => pointBytes(mul(BigInt('0x' + privateKey), G)).toString('hex')

// ── Подпись: (e — 8 байт, s — 16 байт) ──
function challenge(r: Point, pub: Buffer, msg: Buffer) {
  return toBig(sha(TAG, pointBytes(r), pub, msg).subarray(0, 8))
}
export function sign(privateKey: string, msg: Buffer): Buffer {
  const x = BigInt('0x' + privateKey)
  if (x <= 0n || x >= N) throw new Error('секретный ключ не годится')
  const pub = pointBytes(mul(x, G))
  // Одноразовое число — из ключа, открытого ключа, расчёта вызова (TAG) и сообщения: разные
  // сообщения не получат одно и то же. Расчёт вызова в нём нарочно: одно и то же число при двух
  // разных вызовах (скажем, после смены TAG) выдало бы секретный ключ. Меняете расчёт вызова —
  // меняйте и TAG
  const k = mod(toBig(createHmac('sha256', toBytes(x, 16)).update(Buffer.concat([NONCE, TAG, pub, msg])).digest()), N - 1n) + 1n
  const e = challenge(mul(k, G), pub, msg)
  const s = mod(k + e * x, N)
  return Buffer.concat([toBytes(e, 8), toBytes(s, 16)])
}
export function verify(publicKey: string, msg: Buffer, sig: Buffer): boolean {
  if (sig.length !== 24) return false
  let pubPt: Point
  try {
    pubPt = pointOf(publicKey)
  } catch {
    return false
  }
  const e = toBig(sig.subarray(0, 8))
  const s = toBig(sig.subarray(8))
  if (s === 0n || s >= N) return false
  const r = add(mul(s, G), neg(mul(e, pubPt)))
  if (!r) return false
  return challenge(r, pointBytes(pubPt), msg) === e
}

// ── Знаки кода: base32 Крокфорда (без I, L, O, U — их не спутать с 1 и 0) ──
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function encode32(bytes: Buffer): string {
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}
// Ввод человека: регистр не важен, O → 0, I и L → 1, пробелы и дефисы не в счёт
export function clean32(text: string): string {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}
function decode32(text: string, bytes: number): Buffer | null {
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
// Проверка — 10 бит (2 знака) от отпечатка данных
const check2 = (tag: string, data: Buffer) => encode32(sha(Buffer.from(tag), data).subarray(0, 2)).slice(0, 2)
const groups = (s: string) => s.match(/.{1,5}/g)!.join('-')

// ── Код компьютера: 5 байт (40 бит) + 2 знака проверки = 10 знаков «XXXXX-XXXXX» ──
export function computerCodeOf(machineId: string): string {
  const raw = sha(Buffer.from('FMX-PC-1'), Buffer.from(String(machineId).trim().toLowerCase())).subarray(0, 5)
  return groups(encode32(raw) + check2('FMX-PCC', raw))
}
// Код компьютера, введённый человеком → 5 байт; null — опечатка
export function parseComputerCode(text: string): Buffer | null {
  const c = clean32(text)
  if (c.length !== 10) return null
  const raw = decode32(c.slice(0, 8), 5)
  if (!raw || check2('FMX-PCC', raw) !== c.slice(8)) return null
  return raw
}
export const formatComputerCode = (raw: Buffer) => groups(encode32(raw) + check2('FMX-PCC', raw))

// ── Сам код ──
// Начало отсчёта дней — 1 января 2026 по Душанбе (UTC+5, без перехода на летнее время)
const TZ_MS = 5 * 3600000
const EPOCH = Date.UTC(2026, 0, 1)
const DAY = 86400000
export const FOREVER = 0xffff
export const KIND = { activate: 1, reset: 2 } as const
export type LicenceKind = keyof typeof KIND

// Дата «ГГГГ-ММ-ДД» → номер дня; день «сегодня» по Душанбе
export function dayOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error('дата — ГГГГ-ММ-ДД')
  const day = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / DAY)
  // Такого дня нет (31 февраля, 13-й месяц) — Date.UTC молча перенёс бы его на другой
  if (dateOfDay(day) !== date) throw new Error('такого дня нет')
  return day
}
export const todayDay = (now: number) => Math.floor((now + TZ_MS - EPOCH) / DAY)
export function dateOfDay(day: number): string {
  return new Date(EPOCH + day * DAY).toISOString().slice(0, 10)
}

const message = (computer: Buffer, payload: Buffer) => Buffer.concat([Buffer.from('FMX-CODE-1'), computer, payload])

export type LicenceFields = { kind: LicenceKind; until: number; registers: number; serial: number }

// Выпустить код (сервер): computer — 5 байт кода компьютера
export function issueCode(privateKey: string, computer: Buffer, f: LicenceFields): string {
  if (computer.length !== 5) throw new Error('код компьютера — 5 байт')
  const kind = KIND[f.kind]
  if (!kind) throw new Error('вид кода')
  if (!Number.isInteger(f.until) || f.until < 0 || f.until > FOREVER) throw new Error('срок')
  if (!Number.isInteger(f.registers) || f.registers < 0 || f.registers > 250) throw new Error('число касс')
  const payload = Buffer.alloc(6)
  payload[0] = 0x10 | kind
  payload.writeUInt16BE(f.until, 1)
  payload[3] = f.registers
  payload.writeUInt16BE(f.serial & 0xffff, 4)
  const body = Buffer.concat([payload, sign(privateKey, message(computer, payload))])
  return groups(encode32(body) + check2('FMX-CHK', body))
}

// Прочитать код (программа и проверки): null — опечатка; bad — не подходит (подпись,
// чужой компьютер, неизвестный вид)
export function readCode(publicKey: string, computer: Buffer, text: string): { ok: true; fields: LicenceFields } | { ok: false; why: 'typo' | 'bad' } {
  const c = clean32(text)
  if (c.length !== 50) return { ok: false, why: 'typo' }
  const body = decode32(c.slice(0, 48), 30)
  if (!body || check2('FMX-CHK', body) !== c.slice(48)) return { ok: false, why: 'typo' }
  const payload = body.subarray(0, 6)
  if (payload[0] >> 4 !== 1) return { ok: false, why: 'bad' }
  const kind = (Object.keys(KIND) as LicenceKind[]).find((k) => KIND[k] === (payload[0] & 0x0f))
  if (!kind) return { ok: false, why: 'bad' }
  if (!verify(publicKey, message(computer, payload), body.subarray(6))) return { ok: false, why: 'bad' }
  return { ok: true, fields: { kind, until: payload.readUInt16BE(1), registers: payload[3], serial: payload.readUInt16BE(4) } }
}
