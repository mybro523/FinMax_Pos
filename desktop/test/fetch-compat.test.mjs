// ── Запросы к серверу на старом движке (Windows 7 и 8) ──
//
// У Electron 22 нет net.fetch — программа ходит на сервер через net.request. Ответ
// должен вести себя как у fetch ровно в том, чем пользуется net.mjs: status,
// headers.get, text, обрыв по таймеру до ответа и во время чтения тела. Сертификат,
// которого не знает старая Windows, — повтор через Node.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { createFetch } from '../src/fetch-compat.mjs'

// Заглушка net.request: отвечает тем, что задано в plan
function fakeNet(plan) {
  const made = []
  return {
    made,
    request(opts) {
      const req = new EventEmitter()
      req.opts = opts
      req.headers = {}
      req.body = ''
      req.aborted = false
      req.setHeader = (k, v) => (req.headers[k] = v)
      req.write = (b) => (req.body += b)
      req.abort = () => {
        req.aborted = true
        req.emit('abort')
      }
      req.end = () => {
        setImmediate(() => {
          if (req.aborted) return
          if (plan.error) return req.emit('error', new Error(plan.error))
          if (plan.never) return
          const res = new EventEmitter()
          res.statusCode = plan.status ?? 200
          res.headers = plan.headers ?? {}
          req.emit('response', res)
          const chunks = plan.chunks ?? []
          if (plan.stall) return
          setImmediate(() => {
            for (const c of chunks) res.emit('data', Buffer.from(c))
            res.emit('end')
          })
        })
      }
      made.push(req)
      return req
    },
  }
}

test('новый движок: net.fetch есть — им и ходим, как раньше', async () => {
  let asked = null
  const net = { fetch: async (url, init) => ((asked = [url, init]), { status: 200 }) }
  const f = createFetch({ net })
  const r = await f('https://x/api/a', { method: 'GET' })
  assert.equal(r.status, 200)
  assert.deepEqual(asked, ['https://x/api/a', { method: 'GET' }])
})

test('старый движок: ответ как у fetch — статус, заголовки, текст', async () => {
  const net = fakeNet({ status: 200, headers: { Date: 'Sat, 25 Oct 2026 10:00:00 GMT', 'Set-Cookie': ['a=1', 'b=2'] }, chunks: ['{"ok":', 'true}'] })
  const f = createFetch({ net })
  const r = await f('https://x/api/me', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{"a":1}' })
  assert.equal(r.status, 200)
  assert.equal(r.ok, true)
  assert.equal(r.headers.get('date'), 'Sat, 25 Oct 2026 10:00:00 GMT', 'имя заголовка — без разницы, какими буквами')
  assert.equal(r.headers.get('set-cookie'), 'a=1, b=2')
  assert.equal(r.headers.get('x-none'), null)
  assert.equal(await r.text(), '{"ok":true}')
  const req = net.made[0]
  assert.equal(req.opts.method, 'POST')
  assert.equal(req.opts.url, 'https://x/api/me')
  assert.equal(req.headers.Authorization, 'Bearer t')
  assert.equal(req.body, '{"a":1}')
})

test('старый движок: ответ 204 без тела и ответ с ошибкой сервера — как у fetch', async () => {
  const f = createFetch({ net: fakeNet({ status: 204 }) })
  const r = await f('https://x/api/a', {})
  assert.equal(r.status, 204)
  assert.equal(await r.text(), '')
  const g = createFetch({ net: fakeNet({ status: 503, chunks: ['busy'] }) })
  const s = await g('https://x/api/a', {})
  assert.equal(s.status, 503)
  assert.equal(s.ok, false)
  assert.equal(await s.text(), 'busy')
})

test('старый движок: обрыв по таймеру — до ответа и во время чтения тела (AbortError, как у fetch)', async () => {
  // До ответа: сервер молчит
  const net = fakeNet({ never: true })
  const f = createFetch({ net })
  const ctrl = new AbortController()
  const p = f('https://x/api/slow', { signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 5)
  await assert.rejects(p, (e) => e.name === 'AbortError')
  assert.equal(net.made[0].aborted, true, 'запрос оборван по-настоящему')

  // Уже оборванный сигнал — запрос даже не уходит
  const pre = new AbortController()
  pre.abort()
  const n2 = fakeNet({ status: 200 })
  await assert.rejects(createFetch({ net: n2 })('https://x', { signal: pre.signal }), (e) => e.name === 'AbortError')
  assert.equal(n2.made.length, 0)

  // Во время тела: заголовки пришли, тело застряло
  const n3 = fakeNet({ status: 200, stall: true })
  const c3 = new AbortController()
  const r = await createFetch({ net: n3 })('https://x/api/big', { signal: c3.signal })
  assert.equal(r.status, 200)
  setTimeout(() => c3.abort(), 5)
  await assert.rejects(r.text(), (e) => e.name === 'AbortError')
})

test('старый движок: нет связи — ошибка, как у fetch (net.mjs поймёт её как «нет связи»)', async () => {
  const f = createFetch({ net: fakeNet({ error: 'net::ERR_INTERNET_DISCONNECTED' }) })
  await assert.rejects(f('https://x/api/a', {}), /ERR_INTERNET_DISCONNECTED/)
})

test('Windows не знает сертификата сервера — запрос повторяется через Node; другие ошибки — нет', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(201, { Date: 'Sat, 25 Oct 2026 10:00:00 GMT', 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/sales`
  try {
    const warned = []
    const nf = fakeNet({ error: 'net::ERR_CERT_AUTHORITY_INVALID' })
    const f = createFetch({ net: nf, http, https: null, log: { warn: (...a) => warned.push(a.join(' ')) } })
    const r = await f(url, { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{"x":1}' })
    assert.equal(r.status, 201)
    assert.equal(r.headers.get('date'), 'Sat, 25 Oct 2026 10:00:00 GMT')
    assert.deepEqual(JSON.parse(await r.text()), { method: 'POST', auth: 'Bearer k', body: '{"x":1}' })
    assert.equal(warned.length, 1, 'в журнал — одна строка о повторе')
    // Следующие запросы к тому же серверу — сразу через Node: без новой неудачной попытки
    // через Chromium и без новой строки в журнале
    assert.equal(nf.made.length, 1)
    const r2 = await f(url, { method: 'POST', body: '{"x":2}' })
    assert.equal(r2.status, 201)
    assert.deepEqual(JSON.parse(await r2.text()).body, '{"x":2}')
    assert.equal(nf.made.length, 1, 'через Chromium второй раз не пытались')
    assert.equal(warned.length, 1, 'строка в журнале — одна на весь запуск')

    // Обрыв по таймеру на запасном пути — тоже AbortError
    const slow = http.createServer(() => {})
    await new Promise((r) => slow.listen(0, '127.0.0.1', r))
    const ctrl = new AbortController()
    const p = createFetch({ net: fakeNet({ error: 'net::ERR_CERT_AUTHORITY_INVALID' }), http })(`http://127.0.0.1:${slow.address().port}/`, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 20)
    await assert.rejects(p, (e) => e.name === 'AbortError')
    slow.closeAllConnections?.()
    slow.close()

    // Обычная ошибка связи через Node не повторяется
    const g = createFetch({ net: fakeNet({ error: 'net::ERR_CONNECTION_REFUSED' }), http })
    await assert.rejects(g(url, {}), /ERR_CONNECTION_REFUSED/)
  } finally {
    server.close()
  }
})
