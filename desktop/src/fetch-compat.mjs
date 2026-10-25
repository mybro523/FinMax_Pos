// ── Запросы к серверу на старом движке (Windows 7 и 8) ──
//
// Основная часть программы ходит на сервер через net.fetch — сетевую часть Chromium:
// она знает про системный прокси и сертификаты Windows. net.fetch появился в Electron 25,
// а Windows 7 и 8 поддерживает только Electron 22, у которого его нет. Здесь тот же
// запрос поверх net.request (та же сетевая часть Chromium) — ровно в том объёме, какой
// нужен программе (net.mjs): метод, заголовки, тело строкой, прерывание по таймеру;
// у ответа — status, headers.get и text.
//
// Windows 7, давно не получавшая обновлений, может не знать корневого сертификата, которым
// подписан сервер. Тогда запрос повторяется через Node: у него свой список корневых
// сертификатов, а проверка подлинности сервера та же. Повторять безопасно: при ошибке
// сертификата запрос до сервера не дошёл — рукопожатие оборвалось раньше.
//
// Electron и модули Node передаются снаружи — модуль проверяется обычными тестами.

// Корневого сертификата нет в Windows (или он устарел) — тот случай, когда помогает Node
const CERT_UNKNOWN = /ERR_CERT_AUTHORITY_INVALID|ERR_CERT_INVALID|ERR_CERT_WEAK_SIGNATURE_ALGORITHM/

export function abortError() {
  const e = new Error('Запрос прерван')
  e.name = 'AbortError'
  return e
}

// Заголовки ответа — с именами строчными буквами, как у fetch
function lower(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = v
  return out
}

function responseOf(status, headers, body) {
  const get = (name) => {
    const v = headers[String(name).toLowerCase()]
    if (v == null) return null
    return Array.isArray(v) ? v.join(', ') : String(v)
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get },
    text: () => body.then((b) => b.toString('utf8')),
    json: () => body.then((b) => JSON.parse(b.toString('utf8'))),
  }
}

// Один запрос: start(onResponse, onError) запускает его и возвращает «оборвать».
// Ответ приходит сразу, как пришли заголовки; тело дочитывается отдельно — и обрыв по
// таймеру действует на обе половины, как у fetch
function run(init, start) {
  return new Promise((resolve, reject) => {
    const signal = init.signal
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    let bodyFail = null
    let stop = () => {}
    const settle = (fn, v) => {
      if (settled) return
      settled = true
      fn(v)
    }
    const fail = (e) => {
      signal?.removeEventListener('abort', onAbort)
      settle(reject, e)
      if (bodyFail) bodyFail(e)
    }
    const onAbort = () => {
      try {
        stop()
      } catch {
        /* уже оборван */
      }
      fail(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const onResponse = (res) => {
      const chunks = []
      const body = new Promise((ok, no) => {
        bodyFail = no
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort)
          ok(Buffer.concat(chunks))
        })
        res.on('error', (e) => fail(e))
        res.on('aborted', () => fail(abortError()))
      })
      // Тело могут и не читать (ответ 204) — тогда его обрыв никого не касается
      body.catch(() => {})
      settle(resolve, responseOf(res.statusCode, lower(res.headers), body))
    }
    try {
      stop = start(onResponse, fail)
    } catch (e) {
      fail(e)
    }
  })
}

// Через сетевую часть Chromium (Electron net.request)
function viaChromium(net, url, init) {
  return run(init, (onResponse, onError) => {
    const req = net.request({ method: init.method || 'GET', url, redirect: 'follow' })
    for (const [k, v] of Object.entries(init.headers || {})) req.setHeader(k, String(v))
    req.on('response', onResponse)
    req.on('error', onError)
    if (init.body != null) req.write(init.body)
    req.end()
    return () => req.abort()
  })
}

// Через Node (свой список корневых сертификатов)
function viaNode(mod, url, init) {
  return run(init, (onResponse, onError) => {
    const req = mod.request(url, { method: init.method || 'GET', headers: { ...(init.headers || {}) } }, onResponse)
    req.on('error', onError)
    if (init.body != null) req.write(init.body)
    req.end()
    return () => req.destroy(abortError())
  })
}

export function createFetch({ net, https, http, log }) {
  // Новый движок (Windows 10 и 11) — как было: net.fetch
  if (typeof net?.fetch === 'function') return (url, init) => net.fetch(url, init)
  // Серверы, сертификата которых Windows не знает, — к ним сразу через Node, до перезапуска
  // программы: без лишней неудачной попытки на каждый запрос и без строки в журнале на каждый
  const viaNodeOrigins = new Set()
  const originOf = (u) => {
    try {
      return new URL(String(u)).origin
    } catch {
      return ''
    }
  }
  return async (url, init = {}) => {
    const origin = originOf(url)
    const mod = String(url).startsWith('https:') ? https : http
    if (origin && viaNodeOrigins.has(origin)) return viaNode(mod, url, init)
    try {
      return await viaChromium(net, url, init)
    } catch (e) {
      if (e?.name === 'AbortError' || !CERT_UNKNOWN.test(String(e?.message || ''))) throw e
      if (origin) viaNodeOrigins.add(origin)
      log?.warn?.(`сертификат сервера ${origin} Windows не знает — дальше запросы к нему через Node`, e?.message || '')
      return viaNode(mod, url, init)
    }
  }
}
