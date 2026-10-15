// ── Запросы к серверу ──
//
// Окно программы в интернет не ходит: все запросы делает основная часть, а окно
// только просит её об этом через мост. Ключ входа лежит здесь и к окну не попадает.
//
// Здесь две вещи: проверка того, что просит окно, и сам поход на сервер. Откуда
// ответить — с сервера или из локальной базы — решает gateway.mjs.
//
// Модуль не знает про Electron: чем делать запрос, ему передают снаружи. Поэтому
// он проверяется обычными тестами, без запуска программы.

// Пометка «вход выполнен», которую окно получает вместо настоящего ключа.
// То же значение записано в client/src/lib/desktop.js — их сверяет проверка.
export const DESKTOP_TOKEN = 'desktop'

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const MIN_TIMEOUT_MS = 1000
const DEFAULT_TIMEOUT_MS = 15000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
// Заголовки пришли, а тело тянется: большой список по слабой связи. Ждём дольше,
// чем сами заголовки, но не вечно — зависшее соединение не должно держать кассу
const BODY_MIN_TIMEOUT_MS = 60000

const PATH_OK = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/
// «Шаг наверх» в пути — в том числе записанный кодами (%2e%2e). Разборщик адресов
// понимает оба вида, и путь вышел бы из-под /api
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|\?|;|$)/i

// Тот же «шаг наверх» можно записать кодами (..%2f) и кодами кодов (%252e%252e).
// Кто-нибудь по дороге к серверу может оказаться услужливее нас и раскрыть их.
// Поэтому раскрываем сами, слой за слоем, и проверяем каждый вид. В путях нашего API
// кодов нет вовсе: всё, что не раскрывается или закодировано слишком глубоко, — не к нам
function climbsUp(pathOnly) {
  let cur = pathOnly
  for (let n = 0; n < 4; n++) {
    if (DOT_SEGMENT.test(cur) || cur.includes('\\')) return true
    let next
    try {
      next = decodeURIComponent(cur)
    } catch {
      return true
    }
    if (next === cur) return false
    cur = next
  }
  return true
}

// ── Проверка того, что просит окно ──
// Окно — это веб-страница, и доверять ей полностью нельзя: ошибка в интерфейсе или
// подменённый сценарий не должны превратить основную часть программы в исполнителя
// чужих запросов с ключом магазина. Поэтому путь обязан быть путём внутри нашего API,
// а не адресом целиком: уйти с ключом на посторонний сервер отсюда нельзя.
export function checkRequest(raw) {
  const method = String(raw?.method || '').toUpperCase()
  if (!METHODS.has(method)) throw new Error('Недопустимый метод запроса')

  const path = raw?.path
  if (typeof path !== 'string' || path.length > 2000 || !PATH_OK.test(path)) throw new Error('Недопустимый адрес запроса')
  if (path.startsWith('//') || climbsUp(path.split('?')[0])) {
    throw new Error('Недопустимый адрес запроса')
  }

  const asked = Number(raw?.timeoutMs)
  const timeoutMs = Number.isFinite(asked) && asked > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(asked)))
    : DEFAULT_TIMEOUT_MS

  // Тело бывает только у записи. У чтения и удаления его нет — как и на сайте
  const body = method === 'POST' || method === 'PATCH' ? raw?.body : undefined
  return { method, path, body, timeoutMs }
}

// ── Сходить на сервер ──
// Один запрос с указанным ключом входа. Каким ключом и нужно ли вообще идти на
// сервер — решает тот, кто вызывает (gateway.mjs): он знает, кто сейчас работает
// и что касса умеет ответить сама.
//
// onDate получает время сервера из каждого ответа — по нему сверяются часы программы.
export function createRemote({ apiUrl, fetchImpl, onDate = () => {}, stopwatch = () => performance.now() }) {
  return async function call(req, token = '') {
    if (!apiUrl) {
      return { status: 503, date: null, data: { message: 'В программе не задан адрес сервера. Переустановите программу.' } }
    }

    // Свои заголовки бывают только у запросов самой программы (обмен называет ключ
    // кассы). У запроса окна их нет: checkRequest пропускает метод, путь и тело
    const headers = { ...(req.headers || {}) }
    if (req.body !== undefined && req.body !== null) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = 'Bearer ' + token

    const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS
    const ctrl = new AbortController()
    let timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res
    let data = null
    // Когда пришли заголовки ответа: время сервера в них — на этот момент, а не на
    // тот, когда дочитается тело
    let headersAt = 0
    // Ответил не наш сервер: вместо данных пришла страница (вход в чужой Wi-Fi,
    // заглушка прокси). Для программы это то же самое, что отсутствие связи
    let foreign = false
    try {
      res = await fetchImpl(apiUrl + req.path, {
        method: req.method,
        headers,
        body: req.body !== undefined && req.body !== null ? JSON.stringify(req.body) : undefined,
        signal: ctrl.signal,
      })
      headersAt = stopwatch()
      clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(), Math.max(timeoutMs, BODY_MIN_TIMEOUT_MS))
      if (res.status !== 204) {
        const text = await res.text()
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
          foreign = true
        }
      }
    } catch (e) {
      // status 0 — связи не было вовсе. По нему решают, отвечать ли из локальной базы
      return { status: 0, date: null, data: null, timedOut: e?.name === 'AbortError' }
    } finally {
      clearTimeout(timer)
    }

    const date = res.headers?.get?.('date') || null
    // Часы сверяем только по ответу нашего сервера. Страница входа в гостиничный
    // Wi-Fi или ошибка прокси тоже несут время — но чьё оно, неизвестно, а от этих
    // часов зависят время чека и срок работы без связи
    if (date && res.status < 500 && !foreign) onDate(date, Math.max(0, stopwatch() - headersAt))
    const out = { status: res.status, date, data }
    if (foreign) out.foreign = true
    return out
  }
}

// Ответу можно верить как слову сервера? «Связи нет», пятисотые и чужая страница
// вместо данных — это не его слово, а беда по дороге: оборванный провод, перезапуск,
// прокси, вход в чужую сеть.
export const isLinkFailure = (res) => !res || !res.status || res.status >= 500 || !!res.foreign
