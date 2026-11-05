// ── Обмен кассами по местной сети: связь ──
//
// Как кассы находят друг друга и как разговаривают. Что именно они передают и как
// это ложится в базу — в local/lan.mjs.
//
// Поиск. Каждая касса раз в 15 секунд кричит в свою сеть (UDP, широковещательно):
// «я касса такого-то магазина, слушаю на таком-то порту». Магазин назван не кодом, а
// отпечатком общего ключа магазина: соседний магазин в той же сети не отзовётся, а
// посторонний не узнает, чей это магазин. Услышавшая отвечает тем же — напрямую.
// Если поиск не работает (его закрыл брандмауэр), адрес соседа можно вписать вручную.
//
// Разговор. Обычный HTTP-запрос к соседу, тело — зашифровано общим ключом магазина
// (AES-256-GCM): прочитать или подделать его без ключа нельзя. В одном запросе обе
// стороны передают друг другу новые записи своих журналов и подтверждают, докуда
// получили чужие. Поэтому достаточно, чтобы входящие подключения разрешил хотя бы один
// компьютер: второй звонит ему сам, и данные идут в обе стороны.
//
// Ключ магазина выдаёт сервер (при обмене). Пока ключа нет — касса ни разу не была в
// сети — обмена нет. Сам обмен идёт и при интернете: продажа соседа так появляется
// у владельца за секунду, а не после обмена обеих касс с сервером.
//
// Магазин без интернета (1.7.0): сервера нет, ключ заводит главный компьютер и отдаёт кассе
// при подключении (см. «Подключение кассы» ниже). Кассы говорят только с главным, главный —
// только со своими кассами (hub.allow): так у всех один порядок операций. У каждой кассы свой
// ключ обмена с главным (hub.keyFor): сообщение тогда начинается с номера отправителя открытым
// текстом — по нему получатель берёт ключ. Отключил главный кассу — её ключа больше нет.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { constants as bufferConstants } from 'node:buffer'
import nodeHttp from 'node:http'
import nodeDgram from 'node:dgram'
import nodeOs from 'node:os'

export const LAN_TCP_PORT = 47810
export const LAN_UDP_PORT = 47811
const PATH = '/lan/v1/x'
const MAX_BODY = 8 * 1024 * 1024
const HELLO_MS = 15000
const TICK_MS = 4000
const KICK_MS = 250
const REQ_TIMEOUT_MS = 12000
// Сосед «на связи», если последний обмен с ним был не дольше этого назад
export const ONLINE_MS = 20000
const MAX_ENTRIES = 500
// Часы касс сверены с сервером; запрос старше трёх суток — чужой повтор, не наш
const TS_SLACK_MS = 3 * 86400000
// Знакомый адрес соседа пробуем, пока он отвечал за последний месяц
const KNOWN_DAYS = 30
const ID = /^[A-Za-z0-9_:.-]{1,100}$/
const AAD = Buffer.from('finmax-lan-v1')

// ── Ключи из общего ключа магазина ──
// enc — шифрование сообщений; tag — отпечаток магазина для поиска в сети
export function lanKeys(key) {
  const raw = Buffer.from(String(key), 'base64url')
  const enc = Buffer.from(hkdfSync('sha256', raw, Buffer.from('finmax-lan'), Buffer.from('seal-v1'), 32))
  const tag = createHmac('sha256', raw).update('finmax-lan-tag-v1').digest('hex').slice(0, 24)
  return { enc, tag }
}

// Байты — в шифр и обратно (база магазина при подключении кассы); сообщения — JSON поверх них
export function sealRaw(enc, bytes) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', enc, iv)
  c.setAAD(AAD)
  const data = Buffer.concat([c.update(bytes), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), data])
}

export function unsealRaw(enc, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) throw new Error('сообщение повреждено')
  const d = createDecipheriv('aes-256-gcm', enc, buf.subarray(0, 12))
  d.setAAD(AAD)
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()])
}

export const seal = (enc, obj) => sealRaw(enc, Buffer.from(JSON.stringify(obj), 'utf8'))

export function unseal(enc, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 29) throw new Error('сообщение повреждено')
  return JSON.parse(unsealRaw(enc, buf).toString('utf8'))
}

// ── Подключение кассы к главному компьютеру (магазин без интернета, 1.7.0) ──
// Главный показывает код из 8 знаков на 10 минут. Касса по коду находит главного в сети и
// забирает у него базу магазина. Сам код по сети не ходит: поиск — по отпечатку ключа из кода,
// а запрос и ответ зашифрованы этим ключом (scrypt — подбирать код по подслушанному долго).
// Знаки — без похожих (I, L, O, U); набранные похожие и русские буквы-двойники принимаются
export const PAIR_LEN = 8
const PAIR_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PAIR_LOOKALIKE = { O: '0', I: '1', L: '1', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: '0', Р: 'P', С: 'C', Т: 'T', Х: 'X' }
const PAIR_PATH = '/lan/v1/pair'
// Запрос кассы — её журнал, сжатый (подключение заново); ответ — вся база магазина
const PAIR_MAX_REQ = 16 * 1024 * 1024
// Сколько всего байт порт держит в памяти разом и сколько подключений принимает: забитый
// мусором порт не должен положить кассу
const MAX_INFLIGHT = 48 * 1024 * 1024
const MAX_CONNECTIONS = 24
export const PAIR_MAX_RES = 512 * 1024 * 1024
const PAIR_MAGIC = Buffer.from('FMXP1')
// Пока главный собирает базу, касса ждёт без единого байта — дольше обычного обмена
const PAIR_TIMEOUT_MS = 180000

export function newPairCode() {
  let s = ''
  for (const b of randomBytes(PAIR_LEN)) s += PAIR_ABC[b & 31]
  return s
}
export function normalizePairCode(raw) {
  let out = ''
  for (const ch of String(raw ?? '').toUpperCase()) {
    const c = PAIR_LOOKALIKE[ch] || ch
    if (PAIR_ABC.includes(c)) out += c
  }
  return out.slice(0, PAIR_LEN)
}
export function formatPairCode(raw) {
  const c = normalizePairCode(raw)
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c
}
export function pairKeys(code) {
  const enc = scryptSync(normalizePairCode(code), 'finmax-pair-v1', 32, { N: 16384, r: 8, p: 1 })
  const tag = createHmac('sha256', enc).update('finmax-pair-tag-v1').digest('hex').slice(0, 24)
  return { enc, tag }
}
// Сообщение со своим ключом у каждого соседа: «FMXK», длина номера, номер, зашифрованное
const PEER_MAGIC = Buffer.from('FMXK')
function peerFrame(fromId, sealed) {
  const id = Buffer.from(String(fromId), 'utf8')
  return Buffer.concat([PEER_MAGIC, Buffer.from([id.length]), id, sealed])
}
function peerUnframe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || !buf.subarray(0, 4).equals(PEER_MAGIC)) return null
  const n = buf[4]
  if (!n || buf.length < 5 + n) return null
  return { id: buf.subarray(5, 5 + n).toString('utf8'), rest: buf.subarray(5 + n) }
}

// Ответ главного: сведения о магазине и база — двумя шифрованными частями. Запрос кассы — так же:
// сведения и её журнал (сжатый)
function pairFrame(meta, db) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(meta.length)
  return Buffer.concat([PAIR_MAGIC, len, meta, db])
}
function pairUnframe(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 9 || !raw.subarray(0, 5).equals(PAIR_MAGIC)) return null
  const n = raw.readUInt32BE(5)
  if (raw.length < 9 + n) return null
  return { meta: raw.subarray(9, 9 + n), rest: raw.subarray(9 + n) }
}

// HTTP-запрос к соседу: тело — уже зашифрованное сообщение
function httpPost(http, host, port, path, body, { max = MAX_BODY, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > max) req.destroy(Object.assign(new Error('ответ слишком большой'), { status: 413 }))
          else chunks.push(c)
        })
        res.on('end', () => {
          if (res.statusCode === 200) resolve(Buffer.concat(chunks))
          else reject(Object.assign(new Error('ответ ' + res.statusCode), { status: res.statusCode }))
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('сосед не ответил'), { code: 'TIMEOUT' })))
    req.on('error', reject)
    req.end(body)
  })
}

// Касса ищет главного: кричит в сеть отпечатком кода, главный с этим кодом отвечает своим портом
function findMain({ tag, deviceId, dgram, os, udpPort, ms }) {
  return new Promise((resolve) => {
    let sock = null
    let every = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (every) clearInterval(every)
      try {
        sock?.close()
      } catch {
        /* уже закрыт */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), ms)
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      finish(null)
      return
    }
    sock.on('error', () => finish(null))
    sock.on('message', (buf, rinfo) => {
      if (!buf || buf.length > 2048) return
      let m
      try {
        m = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      if (m?.a !== 'finmax-pair' || m.v !== 1 || m.t !== 'here' || m.s !== tag || !Number.isInteger(m.p) || m.p <= 0 || m.p > 65535) return
      finish({ host: cleanAddr(rinfo.address), port: m.p })
    })
    const msg = Buffer.from(JSON.stringify({ a: 'finmax-pair', v: 1, t: 'find', s: tag, d: deviceId }))
    const shout = () => {
      // И на этот же компьютер: проверка запускает «главного» и «кассу» рядом
      for (const addr of [...broadcastAddrs(os), '127.0.0.1']) {
        try {
          sock.send(msg, udpPort, addr, () => {})
        } catch {
          /* сеть пропала — следующая попытка через секунду */
        }
      }
    }
    try {
      sock.bind(0, () => {
        try {
          sock.setBroadcast(true)
        } catch {
          /* без широковещания найдёт только этот же компьютер */
        }
        shout()
        every = setInterval(shout, 1000)
      })
    } catch {
      finish(null)
    }
  })
}

// ── Касса: подключиться к главному по коду ──
// address — адрес главного, вписанный вручную (поиск в сети закрыт брандмауэром); иначе ищем.
// entries — свои операции, которые главный ещё не принял (касса подключается заново).
// Ответ: { meta, db, address, port } или { error: 'format' | 'address' | 'notfound' | 'code' |
// 'nocode' | 'connect' | 'big' | 'broken' | слово главного ('limit', 'licence', …) }
export async function pairRequest({
  code,
  address = '',
  deviceId,
  name = '',
  host = '',
  shopId = '',
  entries = [],
  // Версия базы этой кассы (число шагов схемы): база главного другой версии ей не подойдёт
  schema = 0,
  // Касса раньше работала с другим главным: подключить как новую, ничего не неся
  fresh = false,
  http = nodeHttp,
  dgram = nodeDgram,
  os = nodeOs,
  udpPort = LAN_UDP_PORT,
  findMs = 6000,
  timeoutMs = PAIR_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const norm = normalizePairCode(code)
  if (norm.length !== PAIR_LEN) return { error: 'format' }
  const k = pairKeys(norm)
  let target = null
  if (String(address || '').trim()) {
    const a = parseAddress(address)
    if (!a) return { error: 'address' }
    target = { host: a.host, port: a.port }
  } else {
    target = await findMain({ tag: k.tag, deviceId, dgram, os, udpPort, ms: findMs })
    if (!target) return { error: 'notfound' }
  }
  const z = gzipSync(Buffer.from(JSON.stringify(Array.isArray(entries) ? entries : []), 'utf8'))
  const body = pairFrame(seal(k.enc, { v: 1, t: 'pair', from: deviceId, name, host, shopId, ts: now(), schema, fresh: !!fresh }), sealRaw(k.enc, z))
  if (body.length > PAIR_MAX_REQ) return { error: 'big' }
  let raw
  try {
    raw = await httpPost(http, target.host, target.port, PAIR_PATH, body, { max: PAIR_MAX_RES, timeoutMs })
  } catch (e) {
    if (e?.status === 403) return { error: 'code' }
    if (e?.status === 404) return { error: 'nocode' }
    if (e?.status === 413) return { error: 'big' }
    return { error: 'connect' }
  }
  const f = pairUnframe(raw)
  if (!f) return { error: 'broken' }
  let meta
  try {
    meta = unseal(k.enc, f.meta)
  } catch {
    return { error: 'code' }
  }
  if (!meta?.ok) return { error: typeof meta?.error === 'string' ? meta.error.slice(0, 40) : 'broken' }
  let db
  try {
    db = gunzipSync(unsealRaw(k.enc, f.rest), { maxOutputLength: Math.min(bufferConstants.MAX_LENGTH, 2 * 1024 * 1024 * 1024) })
  } catch {
    return { error: 'broken' }
  }
  return { meta, db, address: target.host, port: Number.isInteger(meta.port) && meta.port > 0 ? meta.port : target.port }
}

// ── Широковещательные адреса сетей этого компьютера ──
// 255.255.255.255 Windows отправляет не во все сети, поэтому кричим ещё и в каждую
// по отдельности: 192.168.1.255 и т. п. Прямой кабель без роутера — сеть 169.254.x.x
export function broadcastAddrs(os = nodeOs) {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue
      const ip = String(a.address).split('.').map(Number)
      const mask = String(a.netmask || '255.255.255.0').split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4 || ip.some((x) => !(x >= 0 && x <= 255))) continue
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

// ── Адрес, вписанный вручную ──
// «192.168.1.10», «KASSA-2» (имя компьютера в сети), «192.168.1.10:47810»
export function parseAddress(raw) {
  const s = String(raw || '').trim()
  if (!s || s.length > 100) return null
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/)
  if (!m) return null
  const port = m[2] ? Number(m[2]) : LAN_TCP_PORT
  if (!(port > 0 && port < 65536)) return null
  return { host: m[1], port, text: m[2] ? `${m[1]}:${port}` : m[1] }
}

const cleanAddr = (a) => String(a || '').replace(/^::ffff:/, '')

// Адреса этого компьютера в его сетях — их вписывают на соседней кассе вручную
export function localAddresses(os = nodeOs) {
  const out = []
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.address) out.push(a.address)
    }
  }
  return [...new Set(out)]
}

// Сообщение обмена: от кого, докуда что получено, записи журнала
function validMsg(msg, s, nowMs) {
  return (
    !!msg &&
    msg.v === 1 &&
    msg.t === 'x' &&
    typeof msg.from === 'string' &&
    ID.test(msg.from) &&
    Array.isArray(msg.entries) &&
    msg.entries.length <= MAX_ENTRIES &&
    Number.isInteger(msg.ack) &&
    msg.ack >= 0 &&
    Number.isInteger(msg.upTo) &&
    msg.upTo >= 0 &&
    (msg.port === undefined || (Number.isInteger(msg.port) && msg.port >= 0 && msg.port < 65536)) &&
    Number.isFinite(Number(msg.ts)) &&
    // Магазин без интернета: часы кассы с сервером не сверены и могут уйти на дни — по ним не судим
    (s?.anyTime === true || Math.abs(nowMs - Number(msg.ts)) < TS_SLACK_MS) &&
    !!s
  )
}

// hub — то, что знает база магазина (gateway.mjs, lanHub):
//   state() → { enabled, deviceId, name, key, wide, epoch?, anyTime? } или null (магазин не открыт)
//   entriesFor(since, wide) → { entries, upTo, more }
//   receive(peerId, entries)
//   progress(peerId, { sentUpTo, gotUpTo })
//   peers(), peer(id), peerSeen({ … }), manual(), forgetAddress(deviceId)
// Магазин без интернета (1.7.0), всё — по желанию:
//   allow(deviceId) — с этой кассой можно говорить (звезда: касса — только с главным)
//   epochOk(epoch) — сосед из того же «поколения» магазина (главный не загружал копию)
//   pairInfo(address) → { enc, tag } — у главного открыт код подключения (null — нет, или с этого
//   адреса уже подбирали); pairFailed(address) — неверный код
//   pairServe({ from, name, host, shopId, entries, schema, fresh, address }) → { meta, db } или { error }
//   keyFor(deviceId) — ключ обмена с этим соседом (state().perPeer); gapFor(since) — журнала с этого
//   места здесь уже нет (сосед долго молчал): 410, ему подключиться заново
export function createLan({
  hub,
  log = { info() {}, warn() {} },
  http = nodeHttp,
  dgram = nodeDgram,
  os = nodeOs,
  now = () => Date.now(),
  tcpPort = LAN_TCP_PORT,
  udpPort = LAN_UDP_PORT,
  bindAddress = '0.0.0.0',
  portTries = 10,
  timers = { set: setTimeout, clear: clearTimeout, every: setInterval, stop: clearInterval },
}) {
  let server = null
  let udp = null
  let port = 0
  let keys = null
  let keyRaw = ''
  let running = false
  let starting = null
  let tickTimer = null
  let helloTimer = null
  let kickTimer = null
  let serverError = ''
  // Сколько байт тел запросов порт держит сейчас
  let inflightBytes = 0
  const inflight = new Map()
  // Неудачи по адресу: сколько подряд и раньше какого момента не пробовать снова
  const fails = new Map()
  // Что сказал адрес соседа в последний раз (для экрана)
  const errors = new Map()
  // Вписанный вручную адрес → чья это касса (узнаём при первом ответе)
  const manualDevice = new Map()

  const st = () => {
    try {
      return hub.state()
    } catch (e) {
      log.warn('обмен по сети: состояние магазина не прочиталось', e)
      return null
    }
  }
  function ensureKeys(s) {
    if (s.key !== keyRaw) {
      keys = lanKeys(s.key)
      keyRaw = s.key
    }
    return keys
  }
  // Ключи обмена соседей (perPeer): по их ключу — шифр сообщений
  const peerKeys = new Map()
  function encFor(key) {
    if (!peerKeys.has(key)) {
      if (peerKeys.size > 64) peerKeys.clear()
      peerKeys.set(key, lanKeys(key).enc)
    }
    return peerKeys.get(key)
  }
  const perPeer = (s) => s?.perPeer === true && typeof hub.keyFor === 'function'

  // ── Сосед звонит нам ──
  function handleBody(buf, remote) {
    const s = st()
    if (!s || !s.enabled || !s.key) return { code: 503 }
    let enc = null
    let claimed = ''
    if (perPeer(s)) {
      // Свой ключ у каждого соседа: кто пишет — открытым текстом, ключ — его
      const f = peerUnframe(buf)
      if (!f || !ID.test(f.id)) return { code: 400 }
      const key = hub.keyFor(f.id)
      // Не своя касса (её отключили на главном, или она чужая)
      if (!key) return { code: 423 }
      enc = encFor(key)
      claimed = f.id
      buf = f.rest
    } else enc = ensureKeys(s).enc
    let msg
    try {
      msg = unseal(enc, buf)
    } catch {
      // Не тот ключ: другой магазин или посторонний
      return { code: 403 }
    }
    const t = now()
    if (!validMsg(msg, s, t)) return { code: 400 }
    // Назвался одной кассой, а ключ — другой
    if (claimed && msg.from !== claimed) return { code: 403 }
    // Звоним сами себе (вписали свой же адрес)
    if (msg.from === s.deviceId) return { code: 409 }
    // Магазин без интернета: не своя касса (её отключили на главном) и касса прежнего «поколения»
    if (typeof hub.allow === 'function' && !hub.allow(msg.from)) return { code: 423 }
    if (typeof hub.epochOk === 'function' && !hub.epochOk(msg.e)) return { code: 412 }
    // Журнала, который ей нужен, здесь уже нет — подключиться заново
    if (typeof hub.gapFor === 'function' && hub.gapFor(msg.ack)) return { code: 410 }
    hub.peerSeen({ deviceId: msg.from, name: msg.name, address: remote, port: msg.port || 0, wide: !!msg.wide, ok: true, now: t })
    hub.receive(msg.from, msg.entries)
    hub.progress(msg.from, { sentUpTo: msg.ack, gotUpTo: msg.upTo })
    const out = hub.entriesFor(msg.ack, !!msg.wide)
    const reply = { v: 1, t: 'x', from: s.deviceId, name: s.name, wide: !!s.wide, port, ts: t, ack: msg.upTo, entries: out.entries, upTo: out.upTo, more: !!out.more, e: s.epoch || undefined }
    return { code: 200, body: seal(enc, reply) }
  }

  // ── Касса подключается по коду (магазин без интернета) ──
  function handlePair(buf, remote) {
    const p = typeof hub.pairInfo === 'function' ? hub.pairInfo(remote) : null
    if (!p) return { code: 404 }
    const f = pairUnframe(buf)
    let msg = null
    try {
      if (!f) throw new Error('не тот формат')
      msg = unseal(p.enc, f.meta)
    } catch {
      // Код не тот: считаем — подбирать его по сети не дадут
      hub.pairFailed?.(remote)
      return { code: 403 }
    }
    const t = now()
    if (!msg || msg.v !== 1 || msg.t !== 'pair' || typeof msg.from !== 'string' || !ID.test(msg.from) || !Number.isFinite(Number(msg.ts))) return { code: 400 }
    let entries = []
    try {
      const list = JSON.parse(gunzipSync(unsealRaw(p.enc, f.rest), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'))
      entries = Array.isArray(list) ? list : []
    } catch {
      return { code: 400 }
    }
    const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
    let r
    try {
      r = hub.pairServe({
        from: msg.from,
        name: text(msg.name, 60),
        host: text(msg.host, 60),
        shopId: text(msg.shopId, 64),
        entries,
        schema: Number.isInteger(msg.schema) ? msg.schema : 0,
        fresh: msg.fresh === true,
        address: remote,
        at: t,
      })
    } catch (e) {
      log.warn('обмен по сети: касса не подключилась', e)
      r = { error: 'broken' }
    }
    if (!r || r.error) return { code: 200, body: pairFrame(seal(p.enc, { ok: false, error: String(r?.error || 'broken') }), Buffer.alloc(0)) }
    return { code: 200, body: pairFrame(seal(p.enc, { ok: true, ...r.meta, port }), sealRaw(p.enc, gzipSync(r.db))) }
  }

  function onRequest(req, res) {
    if (req.method !== 'POST' || (req.url !== PATH && req.url !== PAIR_PATH)) {
      res.writeHead(404, { Connection: 'close' })
      res.end()
      return
    }
    const pairing = req.url === PAIR_PATH
    const limit = pairing ? PAIR_MAX_REQ : MAX_BODY
    const remote = cleanAddr(req.socket?.remoteAddress)
    const refuse = (code) => {
      res.writeHead(code, { Connection: 'close' })
      res.end()
      req.destroy()
    }
    // Кода подключения нет — тело не читаем вовсе; заявленное тело больше предела — тоже;
    // порт и так держит в памяти слишком много — пусть повторят позже
    if (pairing && !(typeof hub.pairInfo === 'function' && hub.pairInfo(remote))) return refuse(404)
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) return refuse(413)
    if (inflightBytes > MAX_INFLIGHT) return refuse(503)
    const chunks = []
    let size = 0
    let tooBig = false
    let held = 0
    const release = () => {
      inflightBytes -= held
      held = 0
    }
    req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy())
    req.on('data', (c) => {
      if (tooBig) return
      size += c.length
      if (size > limit || inflightBytes + c.length > MAX_INFLIGHT) {
        tooBig = true
        release()
        res.writeHead(size > limit ? 413 : 503, { Connection: 'close' })
        res.end()
        req.destroy()
      } else {
        chunks.push(c)
        held += c.length
        inflightBytes += c.length
      }
    })
    req.on('end', () => {
      if (tooBig) return
      let r
      try {
        r = (pairing ? handlePair : handleBody)(Buffer.concat(chunks), remote)
      } catch (e) {
        log.warn('обмен по сети: запрос соседа не обработан', e)
        r = { code: 500 }
      }
      release()
      res.writeHead(r.code, { 'Content-Type': 'application/octet-stream', Connection: 'close' })
      res.end(r.body)
    })
    req.on('close', release)
    req.on('error', () => {})
  }

  function startServer() {
    return new Promise((resolve) => {
      let attempt = 0
      const tryListen = () => {
        const srv = http.createServer(onRequest)
        srv.maxConnections = MAX_CONNECTIONS
        srv.on('error', (e) => {
          if (e?.code === 'EADDRINUSE' && attempt < portTries - 1) {
            attempt++
            tryListen()
            return
          }
          serverError = String(e?.code || e?.message || e)
          log.warn('обмен по сети: входящие подключения не открылись', e)
          resolve(null)
        })
        srv.listen(tcpPort + attempt, bindAddress, () => {
          server = srv
          // Порт 0 — «любой свободный» (так запускают проверки): узнаём, какой дали
          port = srv.address()?.port || tcpPort + attempt
          serverError = ''
          log.info(`обмен по сети: слушаю порт ${port}`)
          resolve(srv)
        })
      }
      tryListen()
    })
  }

  // ── Звоним соседу ──
  const post = (host, p, body) => httpPost(http, host, p, PATH, body)

  const errorText = (e) => {
    if (e?.status === 403) return 'key'
    if (e?.status === 409) return 'self'
    // Магазин без интернета: главный эту кассу не знает (отключил) или загрузил копию базы
    if (e?.status === 423) return 'star'
    if (e?.status === 412) return 'epoch'
    // Журнала с нужного места у главного уже нет (касса долго молчала) — подключиться заново
    if (e?.status === 410) return 'gone'
    // Основа главного не легла на эту кассу (gateway, regReceive)
    if (e?.code === 'BASE') return 'base'
    if (e?.status === 503) return 'off'
    if (e?.code === 'ECONNREFUSED') return 'refused'
    if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return 'notfound'
    if (e?.code === 'TIMEOUT' || e?.code === 'ETIMEDOUT' || e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return 'timeout'
    return 'error'
  }

  // Одна попытка обменяться с соседом по адресу. Записей больше, чем помещается в одно
  // сообщение, — сразу ещё раунд, пока обе стороны не передадут всё
  function exchange(target) {
    const s = st()
    if (!s || !s.enabled || !s.key || !running) return Promise.resolve(false)
    const addr = `${target.host}:${target.port}`
    if (inflight.has(addr)) return inflight.get(addr)
    const f = fails.get(addr)
    if (f && f.until > now() && !target.force) return Promise.resolve(false)
    // Свой ключ у каждого соседа: без номера соседа (адрес вписан вручную) звонить нечем
    let enc
    const framed = perPeer(s)
    if (framed) {
      const key = target.deviceId ? hub.keyFor(target.deviceId) : ''
      if (!key) return Promise.resolve(false)
      enc = encFor(key)
    } else enc = ensureKeys(s).enc
    const k = { enc }
    const job = (async () => {
      for (let round = 0; round < 20; round++) {
        const peer = target.deviceId ? hub.peer(target.deviceId) : null
        // Журнала, который нужен соседу, здесь уже нет: он позвонит сам и узнает, что подключаться заново
        if (peer && typeof hub.gapFor === 'function' && hub.gapFor(peer.sentUpTo)) throw Object.assign(new Error('журнала с этого места нет'), { status: 410 })
        const out = peer ? hub.entriesFor(peer.sentUpTo, !!peer.wide) : { entries: [], upTo: 0, more: false }
        const req = {
          v: 1, t: 'x', from: s.deviceId, name: s.name, wide: !!s.wide, port, ts: now(),
          ack: peer ? peer.gotUpTo : 0, entries: out.entries, upTo: peer ? out.upTo : 0, e: s.epoch || undefined,
        }
        const sealed = seal(k.enc, req)
        const msg = unseal(k.enc, await post(target.host, target.port, framed ? peerFrame(s.deviceId, sealed) : sealed))
        const t = now()
        if (!validMsg(msg, s, t)) throw new Error('сосед ответил непонятно')
        if (msg.from === s.deviceId) throw Object.assign(new Error('это этот же компьютер'), { status: 409 })
        if (typeof hub.allow === 'function' && !hub.allow(msg.from)) throw Object.assign(new Error('не главный компьютер этой кассы'), { status: 423 })
        if (typeof hub.epochOk === 'function' && !hub.epochOk(msg.e)) throw Object.assign(new Error('главный компьютер загрузил копию базы'), { status: 412 })
        // По этому адресу теперь другая касса (компьютер переустановили) — прежней
        // записи адрес больше не принадлежит
        if (target.deviceId && target.deviceId !== msg.from) hub.forgetAddress(target.deviceId)
        hub.peerSeen({ deviceId: msg.from, name: msg.name, address: target.host, port: msg.port || target.port, wide: !!msg.wide, ok: true, now: t })
        if (target.manual) manualDevice.set(target.text, msg.from)
        const first = !peer || target.deviceId !== msg.from
        target.deviceId = msg.from
        hub.receive(msg.from, msg.entries)
        hub.progress(msg.from, { sentUpTo: msg.ack, gotUpTo: msg.upTo })
        errors.delete(msg.from)
        if (target.manual) errors.delete('m:' + target.text)
        // Первый разговор: о себе мы ещё ничего не передали — ещё раунд
        if (!msg.more && !out.more && !first) break
      }
      fails.delete(addr)
      return true
    })()
      .catch((e) => {
        const n = (fails.get(addr)?.n || 0) + 1
        // Не отвечает — пробуем реже: 4 секунды, потом 30, потом раз в две минуты
        fails.set(addr, { n, until: now() + (n < 3 ? 0 : n < 10 ? 30000 : 120000) })
        const why = errorText(e)
        if (target.deviceId) errors.set(target.deviceId, why)
        if (target.manual) errors.set('m:' + target.text, why)
        if (n === 1 || n === 10) log.warn(`обмен по сети: ${addr} — ${e?.message || e}`)
        return false
      })
      .finally(() => inflight.delete(addr))
    inflight.set(addr, job)
    return job
  }

  // Все, с кем стоит поговорить: знакомые соседи и вписанные вручную адреса
  function targets(force = false) {
    const list = []
    const known = now() - KNOWN_DAYS * 86400000
    const byDevice = new Set()
    // Магазин без интернета (звезда): свой главный и свои кассы — всегда, сколько бы ни молчали
    const always = perPeer(st())
    for (const p of hub.peers()) {
      if (!p.address || !p.port) continue
      const fresh = (p.okAt && Date.parse(p.okAt) > known) || (p.seenAt && Date.parse(p.seenAt) > known)
      if (!fresh && !(always && hub.keyFor(p.deviceId))) continue
      list.push({ host: p.address, port: p.port, deviceId: p.deviceId, force })
      byDevice.add(p.deviceId)
    }
    for (const m of hub.manual()) {
      const a = parseAddress(m)
      if (!a) continue
      const dev = manualDevice.get(a.text)
      if (dev && byDevice.has(dev) && hub.peer(dev)?.address) continue
      if (list.some((t) => t.host === a.host && t.port === a.port)) continue
      list.push({ host: a.host, port: a.port, manual: true, text: a.text, deviceId: dev, force })
    }
    return list
  }

  function tick(force = false) {
    const s = st()
    if (!s?.enabled || !running) return Promise.resolve([])
    return Promise.all(targets(force).map((t) => exchange(t)))
  }

  // ── Поиск в сети ──
  function hello(type = 'hi', to = null) {
    const s = st()
    if (!s?.enabled || !udp || !port || !s.key) return
    const k = ensureKeys(s)
    const msg = Buffer.from(JSON.stringify({ a: 'finmax-lan', v: 1, t: type, s: k.tag, d: s.deviceId, p: port, n: s.name }))
    const send = (addr, p) => {
      try {
        udp.send(msg, p, addr, () => {})
      } catch {
        /* сеть пропала — следующая попытка через 15 секунд */
      }
    }
    if (to) send(to.address, to.port)
    else for (const addr of broadcastAddrs(os)) send(addr, udpPort)
  }

  function onHello(buf, rinfo) {
    if (!buf || buf.length > 2048) return
    let m
    try {
      m = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    // Новая касса ищет главного по коду подключения: отвечаем, где нас слушать
    if (m?.a === 'finmax-pair') {
      const p = typeof hub.pairInfo === 'function' ? hub.pairInfo() : null
      if (!p || !udp || !port || m.v !== 1 || m.t !== 'find' || m.s !== p.tag) return
      const s = st()
      const reply = Buffer.from(JSON.stringify({ a: 'finmax-pair', v: 1, t: 'here', s: p.tag, p: port, n: s?.name || '' }))
      try {
        udp.send(reply, rinfo.port, rinfo.address, () => {})
      } catch {
        /* касса спросит ещё раз через секунду */
      }
      return
    }
    const s = st()
    if (!s?.enabled || !s.key) return
    const k = ensureKeys(s)
    if (m?.a !== 'finmax-lan' || m.v !== 1 || m.s !== k.tag || typeof m.d !== 'string' || !ID.test(m.d) || m.d === s.deviceId) return
    if (!Number.isInteger(m.p) || m.p <= 0 || m.p > 65535) return
    // Магазин без интернета: другая касса того же магазина — не наш собеседник (звезда)
    if (typeof hub.allow === 'function' && !hub.allow(m.d)) return
    const address = cleanAddr(rinfo.address)
    // Знакомого соседа новый адрес из одного «привет» не меняет (его подделать легко): адрес
    // запишется, если обмен по нему удастся
    if (!hub.peer?.(m.d)) hub.peerSeen({ deviceId: m.d, name: typeof m.n === 'string' ? m.n : '', address, port: m.p, now: now() })
    if (m.t === 'hi') hello('re', { address: rinfo.address, port: rinfo.port })
    exchange({ host: address, port: m.p, deviceId: m.d })
  }

  function startUdp() {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sock.on('error', (e) => {
        log.warn('обмен по сети: поиск касс в сети не работает', e)
        try {
          sock.close()
        } catch {
          /* уже закрыт */
        }
        if (udp === sock) udp = null
      })
      sock.on('message', onHello)
      sock.bind(udpPort, bindAddress === '0.0.0.0' ? undefined : bindAddress, () => {
        try {
          sock.setBroadcast(true)
        } catch {
          /* без широковещания найдут нас сами */
        }
        hello()
      })
      udp = sock
    } catch (e) {
      log.warn('обмен по сети: поиск касс не запустился', e)
      udp = null
    }
  }

  async function start() {
    running = true
    await startServer()
    // Пока порт открывался, сеть остановили (stop): открытый порт закрываем сразу
    if (!running) {
      try {
        server?.close()
      } catch {
        /* уже закрыт */
      }
      server = null
      port = 0
      return
    }
    startUdp()
    tickTimer = timers.every(() => tick(), TICK_MS)
    helloTimer = timers.every(() => hello(), HELLO_MS)
    tick()
  }

  function stop() {
    running = false
    if (tickTimer) timers.stop(tickTimer)
    if (helloTimer) timers.stop(helloTimer)
    if (kickTimer) timers.clear(kickTimer)
    tickTimer = helloTimer = kickTimer = null
    try {
      server?.close()
    } catch {
      /* уже закрыт */
    }
    try {
      udp?.close()
    } catch {
      /* уже закрыт */
    }
    server = null
    udp = null
    port = 0
  }

  return {
    // Состояние магазина могло измениться (открыли базу, пришёл ключ, вписали адрес)
    async sync() {
      if (starting) await starting
      const s = st()
      if (s?.enabled && s.key && !running) {
        starting = start().finally(() => {
          starting = null
        })
        await starting
      } else if (!(s?.enabled && s.key) && running) stop()
    },
    // Здесь что-то изменилось — передать соседям поскорее
    kick() {
      if (!running || kickTimer) return
      kickTimer = timers.set(() => {
        kickTimer = null
        tick()
      }, KICK_MS)
    },
    // Обменяться сейчас со всеми, даже с теми, кто недавно не отвечал
    now: () => tick(true),
    status() {
      const s = st()
      const t = now()
      const peers = s?.enabled
        ? hub.peers().map((p) => ({
            deviceId: p.deviceId,
            name: p.name,
            address: p.address,
            port: p.port,
            online: !!p.okAt && t - Date.parse(p.okAt) < ONLINE_MS,
            okAt: p.okAt || null,
            error: errors.get(p.deviceId) || '',
          }))
        : []
      const manual = s?.enabled
        ? hub.manual().map((m) => {
            const a = parseAddress(m)
            return { address: m, deviceId: (a && manualDevice.get(a.text)) || null, error: (a && errors.get('m:' + a.text)) || '' }
          })
        : []
      let addresses = []
      try {
        addresses = localAddresses(os)
      } catch {
        /* сеть не прочиталась — адреса просто не покажем */
      }
      return { enabled: !!s?.enabled, running, listening: !!server, port, search: !!udp, error: serverError, peers, manual, addresses }
    },
    stop,
    port: () => port,
    // Порт поиска — проверки запускают «главного» и «кассу» на свободных портах
    udpPort: () => {
      try {
        return udp?.address()?.port || 0
      } catch {
        return 0
      }
    },
  }
}
