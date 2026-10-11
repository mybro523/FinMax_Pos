// ── Сквозная проверка работающей системы через её же API ──
// Тесты в репозитории проверяют куски по отдельности. Здесь проверяется вся
// цепочка целиком, на настоящей базе: заводим товар, принимаем поставку, продаём,
// возвращаем, списываем, закрываем смену — и сверяем деньги и остатки.
//
// Каждый прогон работает на своих данных с меткой E2E-<метка> и в конце убирает
// за собой всё, что создал. Документы (чеки, возвраты, списания) удалить через API
// нельзя — это история, и правильно, что нельзя. Поэтому прогон рассчитан на
// пустую или тестовую базу.
//
// Запуск:  node e2e/run.mjs [адрес API] [логин] [пароль]

const args = process.argv.slice(2)
export const API = (args[0] || process.env.E2E_API || 'http://localhost:3000/api').replace(/\/$/, '')
const NAME = args[1] || process.env.E2E_USER || 'admin'
const PASS = args[2] || process.env.E2E_PASS || 'admin'

let token = ''
// Заведение аптеки — это своя схема, миграции и настройка: около пятнадцати секунд,
// а на занятом сервере и больше. Тридцати секунд не хватало, и прогон обрывался
// на первом же шаге. Здесь предел щедрый намеренно: это проверочный код, ему важнее
// дождаться ответа, чем быстро сдаться.
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180000)

// Часть проверок ходит не нашим токеном (чужая сессия, отозванный доступ),
// поэтому его можно передать явно
export async function api(method, path, body, asToken) {
  const use = asToken === undefined ? token : asToken
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(use ? { Authorization: 'Bearer ' + use } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // Сверяем часы по каждому ответу: наши и серверные расходятся, и на живом
  // прогоне это уже стоило трёх ложных провалов
  noteServerTime(res.headers.get('date'))
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg = data && data.message ? (Array.isArray(data.message) ? data.message.join(', ') : data.message) : text
    const err = new Error(`${method} ${path} → ${res.status}: ${msg}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data
}

export const get = (p, t) => api('GET', p, undefined, t)
export const post = (p, b, t) => api('POST', p, b, t)
export const patch = (p, b, t) => api('PATCH', p, b, t)
export const del = (p, t) => api('DELETE', p, undefined, t)

// Вход под другим сотрудником — возвращает его токен, наш не трогает
export async function loginAs(name, password) {
  const r = await post('/auth/login', { name, password }, '')
  return r.token
}

export async function login() {
  const r = await post('/auth/login', { name: NAME, password: PASS })
  token = r.token
  return r.user
}

// Сменить того, от чьего имени идут запросы. Нужно прогону: он входит владельцем
// сервиса, заводит временную аптеку и дальше работает уже её владельцем.
export function setToken(t) {
  token = t
}
export function getToken() {
  return token
}

// Ждём, пока запрос вернёт то, чего мы ждём: некоторые вещи (пересчёт просрочки,
// оповещения) происходят не мгновенно
export async function until(label, fn, { tries = 20, delay = 500 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (e) {
      last = e.message
    }
    await new Promise((r) => setTimeout(r, delay))
  }
  throw new Error(`не дождались: ${label} (последнее: ${JSON.stringify(last)})`)
}

// ── Учёт результатов ──
const results = []
let currentGroup = ''

export function group(name) {
  currentGroup = name
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`)
}

export async function check(name, fn) {
  try {
    await fn()
    results.push({ group: currentGroup, name, ok: true })
    console.log(`  \x1b[32m✔\x1b[0m ${name}`)
  } catch (e) {
    results.push({ group: currentGroup, name, ok: false, error: e.message })
    console.log(`  \x1b[31m✖\x1b[0m ${name}`)
    console.log(`      \x1b[31m${e.message}\x1b[0m`)
  }
}

export function summary() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n\x1b[1m${'═'.repeat(60)}\x1b[0m`)
  console.log(`Проверок: ${results.length} · успешно: ${results.length - failed.length} · провалено: ${failed.length}`)
  if (failed.length) {
    console.log('\n\x1b[31mПровалились:\x1b[0m')
    failed.forEach((f) => console.log(`  · [${f.group}] ${f.name}\n    ${f.error}`))
  }
  return failed.length
}

// ── Помощники ──
export const money = (n) => Math.round(Number(n) * 100) / 100
export const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
export function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: ожидали ${expected}, получили ${actual}`)
}
export function eqMoney(actual, expected, msg) {
  if (!near(actual, expected)) throw new Error(`${msg}: ожидали ${expected}, получили ${actual}`)
}
export async function rejects(fn, re, msg) {
  try {
    await fn()
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg}: не тот текст отказа — «${e.message}»`)
    return e
  }
  throw new Error(`${msg}: операция прошла, хотя должна была быть отклонена`)
}

// ── Постоянное соединение ──
// Проверяем сырым протоколом опроса, чтобы не тянуть в проверки библиотеку клиента.
//
// Обрыв приходит пакетом «41», но не всегда в первом же ответе. Негодный токен
// сервер отвергает сразу, ещё до подтверждения, и «41» едет вместе с ним. А вот
// доступ действующего токена сверяется с базой — это занимает время, и обрыв
// приходит уже следующим опросом. Поэтому спрашиваем дважды: если второй опрос
// не ответил за отведённое время, значит сервер держит соединение открытым.
//
// Ещё одна ловушка: у оборванного соединения сеанс опроса какое-то время
// продолжает отвечать «ok» на служебные пакеты, так что «жив ли сеанс» —
// негодный признак. Смотреть надо именно на «41».
const ORIGIN = API.replace(/\/api$/, '')
const LATE_DROP_MS = 4000

export async function socketAccepted(token) {
  const url = (extra) => `${ORIGIN}/socket.io/?EIO=4&transport=polling${extra}`

  const hand = await fetch(url(`&token=${encodeURIComponent(token)}`), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const handText = await hand.text()
  if (!hand.ok || handText[0] !== '0') throw new Error(`рукопожатие не удалось: ${hand.status} ${handText.slice(0, 80)}`)
  const sid = JSON.parse(handText.slice(1)).sid

  // Подключение к пространству имён — здесь сервер и решает, пускать ли
  await fetch(url(`&sid=${sid}`), { method: 'POST', body: '40', signal: AbortSignal.timeout(TIMEOUT_MS) })

  const first = await (await fetch(url(`&sid=${sid}`), { signal: AbortSignal.timeout(TIMEOUT_MS) })).text()
  if (!first.includes('40{')) return false
  if (/41/.test(first.replace(/^40\{[^}]*\}/, ''))) return false // оборвали сразу

  // Отложенный обрыв: ждём недолго. Молчание означает, что соединение живо.
  try {
    const late = await (await fetch(url(`&sid=${sid}`), { signal: AbortSignal.timeout(LATE_DROP_MS) })).text()
    if (/41/.test(late)) return false
  } catch {
    // тайм-аут — сервер ничего не прислал, соединение открыто
  }
  return true
}

// Дата в прошлом/будущем как ISO-дата (только день)
const DAY = 86400000
export const daysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10)

// ── Часы сервера ──
// Часы рабочей машины и сервера расходятся: на живом прогоне нашлось три минуты.
// Пока срок подписки мерился сутками, это было незаметно. Теперь он мерится часами,
// и «минуту назад» по своим часам оказывается полутора минутами в БУДУЩЕМ для сервера —
// проверка отключения проваливалась, хотя отключение работало верно.
let skewMs = 0
export function noteServerTime(dateHeader) {
  const t = Date.parse(dateHeader || '')
  if (!Number.isNaN(t)) skewMs = t - Date.now()
}
export const serverNow = () => new Date(Date.now() + skewMs)
export const serverSkewMs = () => skewMs
