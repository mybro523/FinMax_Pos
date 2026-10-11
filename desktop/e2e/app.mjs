// Общие действия для проверок программы: запустить, войти, закрыть.
import { _electron as electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP, electronEnv } from '../scripts/env.mjs'

export const USER = process.env.APP_USER || ''
export const PASS = process.env.APP_PASS || ''
export const API = (process.env.API_URL || electronEnv().APTEKA_API_URL || '').replace(/\/$/, '')

// У каждого запуска своя папка данных: проверки не должны видеть ни настоящий вход
// на этом компьютере, ни следы друг друга. Чтобы проверить «закрыли и открыли снова»,
// ту же папку передают во второй запуск.
export const freshUserData = () => mkdtempSync(join(tmpdir(), 'apteka-app-'))

export async function launchApp({ userData = freshUserData(), env = {}, args = [] } = {}) {
  const app = await electron.launch({
    // Подставная камера: настоящей на проверочном компьютере может не быть, а разрешение
    // на неё программа выдаёт сама — его и проверяем
    args: ['.', '--use-fake-device-for-media-stream', ...args],
    cwd: DESKTOP,
    env: electronEnv({ APTEKA_USER_DATA: userData, ...env }),
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}

// Вход с экрана входа. Общий тур, который видит новый человек, закрываем как человек
export async function signIn(page, user = USER, pass = PASS) {
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  await page.locator('#lg-name').fill(user)
  await page.locator('#lg-pw').fill(pass)
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  const tour = page.locator('.tur-card')
  if (await tour.isVisible({ timeout: 4000 }).catch(() => false)) {
    await tour.getByRole('button', { name: 'Пропустить' }).click()
    await expect(page.locator('.tur-root')).toHaveCount(0)
  }
}

export async function goTo(page, label) {
  await page.locator('.sidebar').getByRole('link', { name: label, exact: false }).first().click()
  await expect(page.locator('.topbar h1')).toBeVisible()
}

// Запрос к серверу мимо программы — чтобы подготовить данные и проверить итог
export async function serverLogin(user = USER, pass = PASS) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user, password: pass }),
  })
  if (!res.ok) throw new Error(`вход на сервер не удался: ${res.status} ${await res.text()}`)
  return (await res.json()).token
}

export async function server(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

export const moneyValue = (text) => Number(String(text).replace(/[^\d,.-]/g, '').replace(',', '.')) || 0

// ── Локальная база программы — глазами проверки ──
// Файл базы открывается только на чтение, рядом с работающей программой: журнал WAL
// это позволяет. Так проверяется главное: чек действительно лежит на диске.
export function localDb(userData, code) {
  const file = join(userData, 'data', `pharmacy-${code}.db`)
  if (!existsSync(file)) return null
  return new Database(file, { readonly: true, fileMustExist: true })
}

export function readLocal(userData, code, sql, ...args) {
  const db = localDb(userData, code)
  if (!db) return null
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}

// ── Интернет с выключателем ──
// Между программой и настоящим сервером ставится пересыльщик на этом же компьютере.
// Выключили — и для программы интернета нет: запросы обрываются так же, как при
// выдернутом проводе. Настоящий сервер при этом работает, и проверка может ходить
// на него напрямую — посмотреть, что до него дошло.
export async function startProxy(target = API) {
  const upstream = new URL(target)
  // Рабочий сервер — по https; проверочный, на этом же компьютере, — по http
  const secure = upstream.protocol === 'https:'
  const lib = secure ? https : http
  // lose — «связь оборвалась на ответе»: (запрос) → true. Сервер такой запрос получает
  // и выполняет, а его ответ до программы не доходит. Это самый коварный вид обрыва:
  // программа не знает, принята ли операция
  const state = { online: true, seen: [], lose: null, lost: 0 }
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    state.seen.push({ method: req.method, url: req.url, online: state.online })
    if (!state.online) return req.socket.destroy()
    const drop = !!state.lose?.(req)
    const out = lib.request(
      {
        host: upstream.hostname,
        port: upstream.port || (secure ? 443 : 80),
        method: req.method,
        // Программа обращается к http://127.0.0.1:порт/api/… — путь тот же, что у сервера
        path: req.url,
        headers: { ...req.headers, host: upstream.host },
      },
      (back) => {
        if (drop) {
          // Дожидаемся, пока сервер ответит целиком, — и рвём соединение с программой
          back.resume()
          back.on('end', () => {
            state.lost++
            req.socket.destroy()
          })
          return
        }
        res.writeHead(back.statusCode || 502, back.headers)
        back.pipe(res)
      },
    )
    out.on('error', () => res.socket?.destroy())
    req.pipe(out)
  })
  // Постоянное соединение (WebSocket) — тем же путём: программа узнаёт о вернувшейся
  // связи именно по нему, и без него проверка ждала бы очередного повтора по таймеру
  server.on('upgrade', (req, socket, head) => {
    state.seen.push({ method: req.method, url: req.url, online: state.online })
    if (!state.online) return socket.destroy()
    const port = Number(upstream.port) || (secure ? 443 : 80)
    const up = secure ? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname }) : net.connect({ host: upstream.hostname, port })
    sockets.add(up)
    up.on('close', () => sockets.delete(up))
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    socket.on('close', () => up.destroy())
    up.once(secure ? 'secureConnect' : 'connect', () => {
      const headers = { ...req.headers, host: upstream.host }
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`))
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    // Адрес для программы: тот же путь /api, но через пересыльщик
    apiUrl: `http://127.0.0.1:${port}${upstream.pathname.replace(/\/$/, '')}`,
    seen: state.seen,
    isOnline: () => state.online,
    // Выдернуть провод: новые запросы не проходят, идущие — обрываются
    offline() {
      state.online = false
      for (const s of sockets) s.destroy()
    },
    online() {
      state.online = true
    },
    // Терять ответы сервера на такие запросы (пусто — перестать). lost() — сколько потеряно
    loseResponses(match) {
      state.lose = match || null
    },
    lost: () => state.lost,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
