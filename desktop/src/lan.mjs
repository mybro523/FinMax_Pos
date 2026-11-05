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
// только со своими кассами (hub.allow): так у всех один порядок операций.
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
// Запрос кассы — её неотправленные операции (подключение заново); ответ — вся база магазина
const PAIR_MAX_REQ = 64 * 1024 * 1024
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
// Ответ главного: сведения о магазине и база — двумя шифрованными частями
function pairFrame(meta, db) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(meta.length)
  return Buffer.concat([PAIR_MAGIC, len, meta, db])
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
  const body = seal(k.enc, { v: 1, t: 'pair', from: deviceId, name, host, shopId, ts: now(), entries })
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
  if (raw.length < 9 || !raw.subarray(0, 5).equals(PAIR_MAGIC)) return { error: 'broken' }
  const n = raw.readUInt32BE(5)
  let meta
  try {
    meta = unseal(k.enc, raw.subarray(9, 9 + n))
  } catch {
    return { error: 'code' }
  }
  if (!meta?.ok) return { error: typeof meta?.error === 'string' ? meta.error.slice(0, 40) : 'broken' }
  let db
  try {
    db = gunzipSync(unsealRaw(k.enc, raw.subarray(9 + n)), { maxOutputLength: Math.min(bufferConstants.MAX_LENGTH, 2 * 1024 * 1024 * 1024) })
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
//   pairInfo() → { enc, tag } — у главного открыт код подключения; pairFailed() — неверный код
//   pairServe({ from, name, host, shopId, entries, address }) → { meta, db } или { error }
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

  // ── Сосед звонит нам ──
  function handleBody(buf, remote) {
    const s = st()
    if (!s || !s.enabled || !s.key) return { code: 503 }
    const k = ensureKeys(s)
    let msg
    try {
      msg = unseal(k.enc, buf)
    } catch {
      // Не тот ключ: другой магазин или посторонний
      return { code: 403 }
    }
    const t = now()
    if (!validMsg(msg, s, t)) return { code: 400 }
    // Звоним сами себе (вписали свой же адрес)
    if (msg.from === s.deviceId) return { code: 409 }
    // Магазин без интернета: не своя касса (её отключили на главном) и касса прежнего «поколения»
    if (typeof hub.allow === 'function' && !hub.allow(msg.from)) return { code: 423 }
    if (typeof hub.epochOk === 'function' && !hub.epochOk(msg.e)) return { code: 412 }
    hub.peerSeen({ deviceId: msg.from, name: msg.name, address: remote, port: msg.port || 0, wide: !!msg.wide, ok: true, now: t })
    hub.receive(msg.from, msg.entries)
    hub.progress(msg.from, { sentUpTo: msg.ack, gotUpTo: msg.upTo })
    const out = hub.entriesFor(msg.ack, !!msg.wide)
    const reply = { v: 1, t: 'x', from: s.deviceId, name: s.name, wide: !!s.wide, port, ts: t, ack: msg.upTo, entries: out.entries, upTo: out.upTo, more: !!out.more, e: s.epoch || undefined }
    return { code: 200, body: seal(k.enc, reply) }
  }

  // ── Касса подключается по коду (магазин без интернета) ──
  function handlePair(buf, remote) {
    const p = typeof hub.pairInfo === 'function' ? hub.pairInfo() : null
    if (!p) return { code: 404 }
    let msg
    try {
      msg = unseal(p.enc, buf)
    } catch {
      // Код не тот: считаем — подбирать его по сети не дадут
      hub.pairFailed?.()
      return { code: 403 }
    }
    const t = now()
    if (!msg || msg.v !== 1 || msg.t !== 'pair' || typeof msg.from !== 'string' || !ID.test(msg.from) || !Number.isFinite(Number(msg.ts))) return { code: 400 }
    const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
    let r
    try {
      r = hub.pairServe({
        from: msg.from,
        name: text(msg.name, 60),
        host: text(msg.host, 60),
        shopId: text(msg.shopId, 64),
        entries: Array.isArray(msg.entries) ? msg.entries : [],
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
    const chunks = []
    let size = 0
    let tooBig = false
    req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy())
    req.on('data', (c) => {
      if (tooBig) return
      size += c.length
      if (size > limit) {
        tooBig = true
        res.writeHead(413, { Connection: 'close' })
        res.end()
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (tooBig) return
      let r
      try {
        r = (pairing ? handlePair : handleBody)(Buffer.concat(chunks), cleanAddr(req.socket?.remoteAddress))
      } catch (e) {
        log.warn('обмен по сети: запрос соседа не обработан', e)
        r = { code: 500 }
      }
      res.writeHead(r.code, { 'Content-Type': 'application/octet-stream', Connection: 'close' })
      res.end(r.body)
    })
    req.on('error', () => {})
  }

  function startServer() {
    return new Promise((resolve) => {
      let attempt = 0
      const tryListen = () => {
        const srv = http.createServer(onRequest)
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
    const k = ensureKeys(s)
    const job = (async () => {
      for (let round = 0; round < 20; round++) {
        const peer = target.deviceId ? hub.peer(target.deviceId) : null
        const out = peer ? hub.entriesFor(peer.sentUpTo, !!peer.wide) : { entries: [], upTo: 0, more: false }
        const req = {
          v: 1, t: 'x', from: s.deviceId, name: s.name, wide: !!s.wide, port, ts: now(),
          ack: peer ? peer.gotUpTo : 0, entries: out.entries, upTo: peer ? out.upTo : 0, e: s.epoch || undefined,
        }
        const msg = unseal(k.enc, await post(target.host, target.port, seal(k.enc, req)))
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
    for (const p of hub.peers()) {
      if (!p.address || !p.port) continue
      const fresh = (p.okAt && Date.parse(p.okAt) > known) || (p.seenAt && Date.parse(p.seenAt) > known)
      if (!fresh) continue
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
    hub.peerSeen({ deviceId: m.d, name: typeof m.n === 'string' ? m.n : '', address, port: m.p, now: now() })
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
