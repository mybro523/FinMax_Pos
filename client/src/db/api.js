// ── HTTP-клиент к бэкенду NestJS ──
// В деве запросы идут на /api (Vite проксирует на localhost:3000).
// В проде (Vercel) адрес задаётся переменной VITE_API_URL.
import { setServerTime } from '../lib/time.js'
import { bridge } from '../lib/desktop.js'
import { translate } from '../lib/i18n.js'

// import.meta.env есть только при сборке Vite. Проверка нужна, чтобы этот файл
// можно было загрузить и в тестах, где сборщика нет.
const BASE = (import.meta.env?.VITE_API_URL || '/api').replace(/\/$/, '')

// Пятнадцати секунд хватает любой обычной операции: продаже, приходу, списку товаров.
// Если сервер молчит дольше — это не «медленно», а «не отвечает», и кассиру надо
// сказать об этом сразу, а не держать его перед замершим экраном.
const TIMEOUT_MS = 15000

// Но есть две операции, которые честно идут долго: снять резервную копию (вся база
// одним ответом) и восстановить её (сервер переписывает все таблицы). На большой
// аптеке это минуты. С общим таймаутом восстановление обрывалось бы на полпути —
// причём сервер продолжал бы работу, а владелец видел бы «сервер не отвечает».
export const LONG_TIMEOUT_MS = 10 * 60 * 1000

const TOKEN_KEY = 'apteka_token'

// Токен авторизации читаем прямо из localStorage (без импорта auth — избегаем цикла)
function authHeader() {
  try {
    const t = localStorage.getItem(TOKEN_KEY)
    return t ? { Authorization: 'Bearer ' + t } : {}
  } catch {
    return {}
  }
}

// Обработчик «сессия истекла/недействительна» (регистрируется из слоя auth)
let onAuthError = () => {}
export function setAuthErrorHandler(fn) {
  onAuthError = fn
}

// status = 0 — связи не было вовсе. По нему выше решают, повторять ли запрос.
// explain — объяснение точнее общего: программа для Windows знает, что именно
// не получилось («этот раздел работает только с интернетом»), и говорит об этом
function noLink(timedOut, explain) {
  const err = new Error(
    explain ||
      (timedOut
        ? 'Сервер не отвечает. Проверьте подключение и адрес API.'
        : 'Нет связи с сервером. Проверьте интернет/адрес API.'),
  )
  err.status = 0
  return err
}

// ── Две дороги к серверу ──
// Сайт ходит на сервер сам, из окна браузера. Программа для Windows — через свою
// основную часть: ключ входа лежит там, а не в окне (см. lib/desktop.js).
// Обе дороги отдают ответ в одном виде, поэтому всё, что идёт после — сверка часов,
// разбор отказа, выход при недействительной сессии — написано один раз и не может
// разойтись между сайтом и программой.

async function viaFetch(method, path, body, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeader(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw noLink(e.name === 'AbortError')
  }
  clearTimeout(timer)
  return { status: res.status, ok: res.ok, date: res.headers?.get?.('date'), read: () => res.json() }
}

async function viaDesktop(method, path, body, timeoutMs) {
  let r
  try {
    r = await bridge.request({ method, path, body, timeoutMs })
  } catch {
    // Не ответила сама программа — для экрана это та же «нет связи»
    throw noLink(false)
  }
  if (!r || !r.status) {
    const explain = typeof r?.data?.message === 'string' ? translate(r.data.message) : ''
    throw noLink(!!r?.timedOut, explain)
  }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, date: r.date, read: async () => r.data }
}

async function once(method, path, body, timeoutMs = TIMEOUT_MS) {
  const hadToken = !!authHeader().Authorization
  const res = await (bridge ? viaDesktop : viaFetch)(method, path, body, timeoutMs)

  // Сверяем часы по каждому ответу: время в системе — серверное, а не устройства.
  // Заголовка может не быть (прокси, тесты) — тогда просто оставляем прежнее расхождение.
  setServerTime(res.date)

  // Токен есть, но сервер вернул 401 — сессия недействительна: разлогиниваем
  if (res.status === 401 && hadToken && path !== '/auth/login') {
    onAuthError()
  }

  if (!res.ok) {
    let msg = `Ошибка ${res.status}`
    try {
      const data = await res.read()
      if (data?.message) msg = Array.isArray(data.message) ? data.message.join(', ') : data.message
      // В программе для Windows часть отказов пишет она сама, а не сервер, — у них
      // есть перевод. Незнакомый текст translate вернёт как есть.
      if (bridge) msg = translate(msg)
    } catch {
      /* ignore */
    }
    // Код ответа нужен, чтобы отличать «сервер занят» (можно повторить)
    // от отказа по существу («нет на складе») — такой повторять бессмысленно
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  if (res.status === 204) return null
  return res.read()
}

async function request(method, path, body, opts = {}) {
  const timeout = opts.timeout || TIMEOUT_MS
  // GET идемпотентен — одна авто-повторная попытка при сетевом сбое
  if (method === 'GET') {
    try {
      return await once(method, path, body, timeout)
    } catch (e) {
      await new Promise((r) => setTimeout(r, 600))
      return once(method, path, body, timeout)
    }
  }
  return once(method, path, body, timeout)
}

// opts.timeout — для операций, которые честно идут долго (см. LONG_TIMEOUT_MS).
// Остальным вызовам он не нужен: у них короткий таймаут не случайно.
export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
}
