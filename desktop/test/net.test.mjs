// ── Запросы к серверу из основной части программы ──
//
// Окно — это веб-страница, и основная часть не должна выполнять за неё что угодно.
// Здесь проверяется граница: какие просьбы окна выполняются, какие отклоняются,
// и что ключ входа никогда не уходит обратно в окно.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRequest, createRemote, DESKTOP_TOKEN, healthProbe, isLinkFailure, PICK_WAIT_MS } from '../src/net.mjs'
import { createBaseChooser } from '../src/apibase.mjs'

const API = 'https://server.example/api'

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

// ── Что просит окно ──

test('обычные запросы интерфейса проходят проверку', () => {
  for (const path of [
    '/products',
    '/sales?days=60',
    '/auth/me',
    '/customers/cmabc123/pay',
    '/arrivals/cm1/',
    '/sales?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-04T19%3A00%3A00.000Z',
  ]) {
    assert.equal(checkRequest({ method: 'GET', path }).path, path)
  }
  assert.equal(checkRequest({ method: 'post', path: '/sales', body: { a: 1 } }).method, 'POST')
})

test('адрес целиком окно подставить не может — только путь внутри нашего API', () => {
  // Иначе основная часть ушла бы с ключом магазина на посторонний сервер
  for (const path of [
    'https://evil.example/steal',
    '//evil.example/steal',
    'products',
    '',
    '/a b',
    '/a\\b',
    '/a\nb',
    '/a#b',
    '/a"b',
  ]) {
    assert.throws(() => checkRequest({ method: 'GET', path }), /адрес/, `пропущен путь: ${JSON.stringify(path)}`)
  }
  assert.throws(() => checkRequest({ method: 'GET', path: null }), /адрес/)
  assert.throws(() => checkRequest({ method: 'GET', path: '/' + 'a'.repeat(3000) }), /адрес/)
})

test('выйти из-под /api «шагом наверх» нельзя — ни точками, ни их кодами', () => {
  for (const path of ['/../admin', '/x/../../y', '/..', '/%2e%2e/x', '/x/%2E%2E', '/.%2e/x', '/./x']) {
    assert.throws(() => checkRequest({ method: 'GET', path }), /адрес/, `пропущен путь: ${path}`)
  }
  // Косая черта кодом, коды кодов, «точки с запятой»: кто-нибудь по дороге может
  // раскрыть их раньше сервера
  for (const path of ['/x/..%2fadmin', '/x/..%2Fadmin', '/x/%252e%252e/admin', '/x/..%252fadmin', '/x/..;/admin', '/x/..%5cadmin', '/x/%25252e%25252e/y']) {
    assert.throws(() => checkRequest({ method: 'GET', path }), /адрес/, `пропущен путь: ${path}`)
  }
  // Оборванный код в пути — тоже не к нам
  assert.throws(() => checkRequest({ method: 'GET', path: '/x/%zz' }), /адрес/)
  // Точки внутри имени — это не шаг наверх
  assert.equal(checkRequest({ method: 'GET', path: '/files/report.v2.json' }).path, '/files/report.v2.json')
  // И в параметрах запроса они ничего не значат
  assert.equal(checkRequest({ method: 'GET', path: '/sales?note=..' }).path, '/sales?note=..')
})

test('посторонние методы отклоняются', () => {
  for (const method of ['PUT', 'OPTIONS', 'CONNECT', 'TRACE', '', undefined]) {
    assert.throws(() => checkRequest({ method, path: '/products' }), /метод/)
  }
})

test('время ожидания держится в разумных пределах', () => {
  assert.equal(checkRequest({ method: 'GET', path: '/p' }).timeoutMs, 15000)
  assert.equal(checkRequest({ method: 'GET', path: '/p', timeoutMs: 5 }).timeoutMs, 1000)
  assert.equal(checkRequest({ method: 'GET', path: '/p', timeoutMs: 10 ** 12 }).timeoutMs, 10 * 60 * 1000)
  assert.equal(checkRequest({ method: 'GET', path: '/p', timeoutMs: 'ерунда' }).timeoutMs, 15000)
  assert.equal(checkRequest({ method: 'GET', path: '/p', timeoutMs: 600000 }).timeoutMs, 600000)
})

test('тело есть только у записи', () => {
  assert.equal(checkRequest({ method: 'GET', path: '/p', body: { x: 1 } }).body, undefined)
  assert.equal(checkRequest({ method: 'DELETE', path: '/p/1', body: { x: 1 } }).body, undefined)
  assert.deepEqual(checkRequest({ method: 'PATCH', path: '/p/1', body: { x: 1 } }).body, { x: 1 })
})

// ── Запрос к серверу ──

test('ключ входа подставляет основная часть, окно его не присылает', async () => {
  const seen = []
  const call = createRemote({
    apiUrl: API,
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return jsonResponse(200, [{ id: 1 }], { date: 'Sun, 04 Oct 2026 12:00:00 GMT' })
    },
  })
  const r = await call(checkRequest({ method: 'GET', path: '/products' }), 'настоящий-ключ')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, [{ id: 1 }])
  assert.equal(r.date, 'Sun, 04 Oct 2026 12:00:00 GMT')
  assert.equal(seen[0].url, API + '/products')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer настоящий-ключ')
  // У чтения нет ни тела, ни заголовка о нём
  assert.equal(seen[0].init.body, undefined)
  assert.equal(seen[0].init.headers['Content-Type'], undefined)
})

test('без ключа запрос идёт без него — так выполняется сам вход', async () => {
  const call = createRemote({
    apiUrl: API,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, undefined)
      assert.deepEqual(JSON.parse(init.body), { name: 'kassir', password: 'sekret-1' })
      assert.equal(init.headers['Content-Type'], 'application/json')
      return jsonResponse(201, { token: 'ключ', user: { name: 'kassir' } })
    },
  })
  const r = await call(checkRequest({ method: 'POST', path: '/auth/login', body: { name: 'kassir', password: 'sekret-1' } }))
  assert.equal(r.status, 201)
})

test('время сервера из каждого ответа уходит в часы программы', async () => {
  const dates = []
  const call = createRemote({
    apiUrl: API,
    onDate: (d) => dates.push(d),
    fetchImpl: async () => jsonResponse(200, {}, { date: 'Sun, 04 Oct 2026 12:00:00 GMT' }),
  })
  await call(checkRequest({ method: 'GET', path: '/products' }), 'k')
  assert.deepEqual(dates, ['Sun, 04 Oct 2026 12:00:00 GMT'])
})

test('чужому ответу часы не верят: страница прокси или ошибка по дороге время не задают', async () => {
  const dates = []
  const date = 'Mon, 01 Jan 2001 00:00:00 GMT'
  const answers = [
    // Страница входа в чужой Wi-Fi: код 200, но это не наш сервер
    { status: 200, ok: true, headers: { get: () => date }, text: async () => '<html>Войдите в сеть</html>' },
    // Ошибка прокси
    { status: 502, ok: false, headers: { get: () => date }, text: async () => '{"error":"bad gateway"}' },
  ]
  for (const answer of answers) {
    const call = createRemote({ apiUrl: API, onDate: (d) => dates.push(d), fetchImpl: async () => answer })
    await call(checkRequest({ method: 'GET', path: '/products' }), 'k')
  }
  assert.deepEqual(dates, [], 'часы программы перевёл посторонний ответ')

  // Отказ нашего сервера — тоже его слово, времени из него верить можно
  const ours = createRemote({ apiUrl: API, onDate: (d) => dates.push(d), fetchImpl: async () => jsonResponse(401, { message: 'Требуется вход в систему' }, { date }) })
  await ours(checkRequest({ method: 'GET', path: '/products' }), 'k')
  assert.deepEqual(dates, [date])
})

// ── Связь ──

test('нет связи — status 0, а не исключение', async () => {
  const call = createRemote({
    apiUrl: API,
    fetchImpl: async () => {
      throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
    },
  })
  const r = await call(checkRequest({ method: 'GET', path: '/products' }), 'k')
  assert.deepEqual(r, { status: 0, date: null, data: null, timedOut: false })
  assert.equal(isLinkFailure(r), true)
})

test('сервер молчит дольше отведённого — запрос обрывается с пометкой', async () => {
  const call = createRemote({
    apiUrl: API,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      }),
  })
  const r = await call(checkRequest({ method: 'GET', path: '/products', timeoutMs: 1000 }), 'k')
  assert.equal(r.status, 0)
  assert.equal(r.timedOut, true)
})

test('отказ сервера доходит вместе с объяснением', async () => {
  const call = createRemote({
    apiUrl: API,
    fetchImpl: async () => jsonResponse(400, { message: 'Недостаточно «Аспирин» на складе (есть 2 шт)' }),
  })
  const r = await call(checkRequest({ method: 'POST', path: '/sales', body: { items: [] } }), 'k')
  assert.equal(r.status, 400)
  assert.match(r.data.message, /Недостаточно/)
  // Отказ по существу — это слово сервера, а не беда со связью
  assert.equal(isLinkFailure(r), false)
})

test('пустой ответ и ответ не в JSON не роняют запрос', async () => {
  const empty = createRemote({
    apiUrl: API,
    fetchImpl: async () => ({ status: 204, ok: true, headers: { get: () => null }, text: async () => '' }),
  })
  assert.deepEqual(await empty(checkRequest({ method: 'DELETE', path: '/products/1' }), 'k'), { status: 204, date: null, data: null })

  // Страница ошибки от прокси вместо ответа сервера — это беда по дороге, а не слово сервера
  const html = createRemote({
    apiUrl: API,
    fetchImpl: async () => ({ status: 502, ok: false, headers: { get: () => null }, text: async () => '<html>Bad Gateway</html>' }),
  })
  const r = await html(checkRequest({ method: 'GET', path: '/products' }), 'k')
  assert.deepEqual(r, { status: 502, date: null, data: null, foreign: true })
  assert.equal(isLinkFailure(r), true)

  // Страница входа в чужой Wi-Fi отвечает кодом 200 — но это не наш сервер, и для
  // программы это «связи нет», а не «сервер прислал пустоту»
  const portal = createRemote({
    apiUrl: API,
    fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '<html>Войдите в сеть</html>' }),
  })
  assert.equal(isLinkFailure(await portal(checkRequest({ method: 'GET', path: '/products' }), 'k')), true)
  // Настоящее «пусто» от сервера (товар по штрихкоду не найден) — обычный ответ
  const nothing = createRemote({ apiUrl: API, fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '' }) })
  assert.equal(isLinkFailure(await nothing(checkRequest({ method: 'GET', path: '/products/barcode/1' }), 'k')), false)
})

test('адрес сервера не задан — понятный отказ вместо запроса в никуда', async () => {
  const call = createRemote({ apiUrl: '', fetchImpl: async () => assert.fail('запрос ушёл') })
  const r = await call(checkRequest({ method: 'GET', path: '/products' }), 'k')
  assert.equal(r.status, 503)
  assert.match(r.data.message, /адрес сервера/)
})

// ── Пометка «вход выполнен» одна и та же по обе стороны моста ──
test('пометка входа совпадает в программе и в интерфейсе', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const client = readFileSync(join(here, '..', '..', 'client', 'src', 'lib', 'desktop.js'), 'utf8')
  const m = client.match(/export const DESKTOP_TOKEN = '([^']+)'/)
  assert.ok(m, 'в client/src/lib/desktop.js не найдена пометка входа')
  assert.equal(m[1], DESKTOP_TOKEN)
})

// ── Свои заголовки и возраст времени сервера ──

test('свои заголовки бывают только у запросов самой программы — у запроса окна их нет', async () => {
  let sent = null
  const remote = createRemote({
    apiUrl: API,
    fetchImpl: async (url, init) => {
      sent = init.headers
      return jsonResponse(200, { ok: true })
    },
  })
  // Обмен называет ключ кассы
  const first = await remote({ method: 'GET', path: '/sync/pull?deviceId=k', headers: { 'X-Device-Key': 'kluch' } }, 'vhod')
  assert.equal(first.status, 200)
  assert.equal(sent['X-Device-Key'], 'kluch')
  assert.equal(sent.Authorization, 'Bearer vhod')
  // Окно подложило заголовки — проверка запроса их не пропускает
  const fromWindow = checkRequest({ method: 'GET', path: '/products', headers: { 'X-Device-Key': 'podlog', Authorization: 'Bearer chuzhoj' } })
  assert.equal('headers' in fromWindow, false)
  await remote(fromWindow, 'vhod')
  assert.equal(sent['X-Device-Key'], undefined)
  assert.equal(sent.Authorization, 'Bearer vhod')
})

test('время сервера отдаётся часам вместе с тем, сколько дочитывался ответ', async () => {
  let mono = 1000
  const seen = []
  const remote = createRemote({
    apiUrl: API,
    stopwatch: () => mono,
    onDate: (date, age) => seen.push([date, age]),
    fetchImpl: async () => {
      const res = jsonResponse(200, { big: true }, { date: 'Sun, 04 Oct 2026 10:05:00 GMT' })
      // Заголовки пришли сразу, а тело читается сорок секунд
      const text = res.text
      res.text = async () => {
        mono += 40_000
        return text()
      }
      return res
    },
  })
  await remote({ method: 'GET', path: '/sync/pull' }, 'vhod')
  assert.deepEqual(seen, [['Sun, 04 Oct 2026 10:05:00 GMT', 40_000]])
})

// ── Основной или запасной адрес (1.6.5) ──
// 04.11.2026 при сбое DNS у регистратора домена каждый вход и запуск кассы ждали 10–15 секунд,
// пока Windows перестанет искать адрес. С выбором адреса запрос идёт туда, где сервер отвечает,
// а «связи нет» касса узнаёт сразу

const MAIN = 'https://main.example/api'
const SPARE = 'https://spare.example/api'

// Сеть по адресам: hang — запрос «висит» до обрыва (как при сбое DNS), down — отказ сразу
function network() {
  const net = { hang: new Set(), down: new Set(), calls: [] }
  net.fetchImpl = (url, init = {}) => {
    const host = url.startsWith(MAIN) ? MAIN : url.startsWith(SPARE) ? SPARE : ''
    const path = url.slice(host.length)
    net.calls.push((host === MAIN ? 'main' : 'spare') + path)
    if (net.hang.has(host)) {
      return new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }),
      )
    }
    if (net.down.has(host)) return Promise.reject(new TypeError('net::ERR_NAME_NOT_RESOLVED'))
    if (path === '/health') return Promise.resolve(jsonResponse(200, { status: 'ok', service: 'apteka-api' }))
    return Promise.resolve(jsonResponse(200, { from: host === MAIN ? 'main' : 'spare', path }))
  }
  return net
}

function zapas(net, over = {}) {
  const clock = { now: 0 }
  const chooser = createBaseChooser({ primary: MAIN, fallback: SPARE, probe: healthProbe(net.fetchImpl, over.probeMs ?? 300), now: () => clock.now })
  const remote = createRemote({ apiUrl: MAIN, fetchImpl: net.fetchImpl, chooser, pickWaitMs: over.pickWaitMs ?? 1000 })
  return { chooser, remote, clock }
}

test('основной адрес «висит» (сбой DNS) — запрос идёт на запасной и не ждёт', async () => {
  const net = network()
  net.hang.add(MAIN)
  const { chooser, remote } = zapas(net)
  const t0 = Date.now()
  const r = await remote({ method: 'GET', path: '/products', timeoutMs: 15000 })
  assert.equal(r.status, 200)
  assert.equal(r.data.from, 'spare')
  assert.ok(Date.now() - t0 < 1000, 'ждали ' + (Date.now() - t0) + ' мс')
  chooser.stop()
})

test('сервер молчит по обоим адресам — «связи нет» сразу, и без новых запросов, пока не пора спросить снова', async () => {
  const net = network()
  net.down.add(MAIN)
  net.down.add(SPARE)
  const { chooser, remote, clock } = zapas(net)
  const t0 = Date.now()
  const r = await remote({ method: 'POST', path: '/auth/login', body: { name: 'a' }, timeoutMs: 15000 })
  assert.deepEqual([r.status, r.timedOut], [0, false])
  assert.ok(Date.now() - t0 < 500)
  assert.deepEqual(net.calls.sort(), ['main/health', 'spare/health'], 'кроме проверки адресов — ни одного запроса')

  // Тут же ещё запрос — сеть не трогаем вовсе
  net.calls.length = 0
  assert.equal((await remote({ method: 'GET', path: '/auth/me' })).status, 0)
  assert.deepEqual(net.calls, [])

  // Прошло 20 секунд, интернет вернулся. Запрос окна ответ ждать не заставляет («связи нет»
  // сразу, касса отвечает сама), а адреса тем временем спрашиваются снова — в фоне
  net.down.clear()
  clock.now += 20000
  const t1 = Date.now()
  const asked = await remote({ method: 'GET', path: '/auth/me' })
  assert.deepEqual([asked.status, asked.skipped], [0, true])
  assert.ok(Date.now() - t1 < 100, 'окно не ждёт нового выбора')
  await chooser.failed() // выбор, начатый этим запросом
  assert.equal(chooser.reachable(), true)
  const back = await remote({ method: 'GET', path: '/auth/me' })
  assert.equal(back.status, 200)
  assert.equal(back.data.from, 'main', 'основной снова отвечает — работа через него')
  chooser.stop()
})

test('обмен (запрос самой программы) идёт на сервер, даже если проверка адреса сказала «молчит»: медленная связь', async () => {
  const net = network()
  // Проверка адреса не успевает (связь медленная), а настоящий запрос проходит
  const slow = (url, init = {}) => (url.endsWith('/health') ? Promise.reject(new Error('не успела')) : net.fetchImpl(url, init))
  const clock = { now: 0 }
  const chooser = createBaseChooser({ primary: MAIN, fallback: SPARE, probe: healthProbe(slow, 100), now: () => clock.now })
  const remote = createRemote({ apiUrl: MAIN, fetchImpl: slow, chooser, pickWaitMs: 500 })
  // Окну — «связи нет» сразу
  assert.equal((await remote({ method: 'GET', path: '/auth/me' })).status, 0)
  assert.equal(chooser.reachable(), false)
  // Обмен пробует по-настоящему — и проходит; сервер снова «доступен» и для окна
  const sync = await remote({ method: 'GET', path: '/sync/pull', patient: true })
  assert.equal(sync.status, 200)
  assert.equal(chooser.reachable(), true)
  assert.equal((await remote({ method: 'GET', path: '/auth/me' })).status, 200)
  chooser.stop()
})

test('первый запрос после запуска: оба адреса «висят» — ответ «связи нет» не позже, чем через отведённое ожидание', async () => {
  const net = network()
  net.hang.add(MAIN)
  net.hang.add(SPARE)
  const { chooser, remote } = zapas(net, { probeMs: 2000, pickWaitMs: 150 })
  const t0 = Date.now()
  const r = await remote({ method: 'GET', path: '/auth/me', timeoutMs: 15000 })
  const took = Date.now() - t0
  assert.equal(r.status, 0)
  assert.ok(took >= 140 && took < 1000, 'ждали ' + took + ' мс')
  assert.equal(chooser.chosen(), false, 'выбор идёт дальше в фоне')
  // Выбор закончился: оба молчат — и следующий запрос отвечает сразу
  await chooser.ready()
  assert.equal(chooser.reachable(), false)
  const t1 = Date.now()
  assert.equal((await remote({ method: 'GET', path: '/auth/me' })).status, 0)
  assert.ok(Date.now() - t1 < 100)
})

test('основной отказал посреди работы — следующий запрос уже на запасной', async () => {
  const net = network()
  const { chooser, remote, clock } = zapas(net)
  assert.equal((await remote({ method: 'GET', path: '/products' })).data.from, 'main')
  net.down.add(MAIN)
  clock.now += 30000
  const failed = await remote({ method: 'GET', path: '/products' })
  assert.equal(failed.status, 0, 'сам запрос не повторяется: запись могла дойти, а касса ответит сама')
  // Выбор заново идёт в фоне — дожидаемся его
  await chooser.failed()
  const next = await remote({ method: 'GET', path: '/products' })
  assert.equal(next.data.from, 'spare')
  chooser.stop()
})

test('ответил не наш сервер (страница входа в чужой Wi-Fi) — адрес выбирается заново', async () => {
  let picks = 0
  const chooser = {
    ready: async () => MAIN,
    reachable: () => true,
    failed: async () => {
      picks++
      return MAIN
    },
  }
  const fetchImpl = async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '<html>Вход в сеть</html>' })
  const remote = createRemote({ apiUrl: MAIN, fetchImpl, chooser })
  const r = await remote({ method: 'GET', path: '/products' })
  assert.equal(r.foreign, true)
  assert.equal(picks, 1)
})

test('проверка адреса: отвечает только наш сервер — не страница входа в Wi-Fi и не ошибка', async () => {
  const answer = (status, text) => async () => ({ status, ok: status === 200, headers: { get: () => null }, text: async () => text })
  assert.equal(await healthProbe(answer(200, JSON.stringify({ status: 'ok', service: 'apteka-api' })))(MAIN), true)
  assert.equal(await healthProbe(answer(200, '<html>Вход в сеть</html>'))(MAIN), false)
  assert.equal(await healthProbe(answer(200, JSON.stringify({ status: 'ok' })))(MAIN), false, 'чужой сервер с похожим ответом')
  assert.equal(await healthProbe(answer(502, 'Bad Gateway'))(MAIN), false)
  assert.equal(await healthProbe(async () => Promise.reject(new TypeError('net::ERR_NAME_NOT_RESOLVED')))(MAIN), false)
  // Молчит — не дольше отведённого
  const net = network()
  net.hang.add(MAIN)
  const t0 = Date.now()
  assert.equal(await healthProbe(net.fetchImpl, 100)(MAIN), false)
  assert.ok(Date.now() - t0 < 600)
})

test('без запасного адреса — как прежде: запрос сразу на основной, без проверок', async () => {
  const net = network()
  const remote = createRemote({ apiUrl: MAIN, fetchImpl: net.fetchImpl })
  assert.equal((await remote({ method: 'GET', path: '/products' })).data.from, 'main')
  assert.deepEqual(net.calls, ['main/products'])
  assert.ok(PICK_WAIT_MS >= 1000 && PICK_WAIT_MS <= 5000)
})
