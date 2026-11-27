// ── Связь с фискальным принтером Fiscat ──
//
// Устройство стоит в сети магазина и отвечает по http на порту 8002 (протокол v2.9,
// п. 1.1). Запрос — POST /api/<метод> с тем телом, что собрал map.mjs; ответ — JSON с
// rc:"SUCCESS" или кодом ошибки. Два правила устройства определяют всё здесь:
//   • одна задача за раз — пока принтер печатает, он отвечает 503 «занято» (повторяем);
//   • адрес — только из сети магазина (checkHost), как и у чекового принтера: окно не
//     должно превратить принтер в дорогу наружу (print/transport.mjs).
//
// Сеть (fetchImpl), проверку адреса (checkHost) и настройки (config) передают снаружи —
// модуль проверяется обычными тестами на поддельной сети (test/fiskal-client.test.mjs).
import { parseReply, statusReq } from './map.mjs'

const DEFAULT_TIMEOUT = 20000 // ответ приходит ПОСЛЕ печати — она небыстрая
const STATUS_TIMEOUT = 8000
const BUSY_RETRIES = 5
const BUSY_DELAY = 700

const portOf = (p) => {
  const n = Math.trunc(Number(p))
  return n >= 1 && n <= 65535 ? n : 8002
}

export function createFiskal({ fetchImpl, checkHost, config, log = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = () => config() || {}
  const enabled = () => !!cfg().enabled

  // Устройство выполняет одну задачу за раз: запросы к нему идут строго по очереди —
  // пока один не завершился, следующий ждёт. Иначе оба получат «занято».
  let tail = Promise.resolve()
  const serial = (fn) => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  // Один запрос без повторов. Возвращает { json } при ответе устройства, { retry } на 503,
  // { fail } при обрыве связи или нечитаемом ответе.
  async function once(url, payload, timeoutMs) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (res.status === 503) return { retry: true } // занято другим документом
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      if (res.status < 200 || res.status >= 300 || !json || typeof json !== 'object') return { fail: 'badReply' }
      return { json }
    } catch {
      // обрыв связи, таймаут (ответ ПОСЛЕ печати и не пришёл), неверный адрес
      return { fail: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  // Запрос с повторами на «занято». Нормализованный результат, НЕ бросает:
  //   { ok:true, data, fd } — успех;
  //   { ok:false, code, message } — устройство отказало (код из rc);
  //   { ok:false, net } — связь/настройки (noHost|disabled|unreachable|busy|badReply).
  async function call(endpoint, payload, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const c = cfg()
    if (!c.enabled) return { ok: false, net: 'disabled' }
    const host = checkHost(c.host)
    if (!host) return { ok: false, net: 'noHost' }
    const url = `http://${host}:${portOf(c.port)}/api/${endpoint}`
    for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
      const r = await once(url, payload, timeoutMs)
      if (r.retry) {
        if (attempt === BUSY_RETRIES) return { ok: false, net: 'busy' }
        await sleep(BUSY_DELAY)
        continue
      }
      if (r.fail) return { ok: false, net: r.fail }
      const parsed = parseReply(r.json)
      if (parsed.ok) return { ok: true, data: parsed.data, fd: parsed.fd }
      log.warn?.(`фискальный принтер отказал: ${parsed.code}${parsed.message ? ' ' + parsed.message : ''}`)
      return { ok: false, code: parsed.code, message: parsed.message }
    }
    return { ok: false, net: 'unreachable' }
  }

  return {
    enabled,
    config: cfg,
    // Любой метод устройства по очереди
    send: (endpoint, payload, opts) => serial(() => call(endpoint, payload, opts)),
    // Состояние устройства — с коротким ожиданием (без печати): для проверки связи в настройках
    status: () => serial(() => call('deviceStatus', statusReq(), { timeoutMs: STATUS_TIMEOUT })),
  }
}
