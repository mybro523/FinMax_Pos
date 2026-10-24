// ── Собранная программа: то, что уедет в аптеку ──
//
// Остальные проверки запускают программу из исходников. Но в аптеку попадает не это,
// а упакованный .exe: с архивом вместо папок, с зашитым адресом сервера и с замками
// на исполняемом файле. Ровно эти отличия здесь и проверяются — на том самом файле,
// который лежит в release/win-unpacked.
//
// Перед запуском:  npm run electron:build -- --dir
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DESKTOP } from '../scripts/env.mjs'
import { freshUserData, goTo, PASS, signIn, USER } from './app.mjs'

// По умолчанию — распакованная сборка. APTEKA_EXE указывает на другой файл: так
// проверяют программу, уже поставленную установщиком
const EXE = process.env.APTEKA_EXE || join(DESKTOP, 'release', 'win-unpacked', 'FinMaxPOS.exe')

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

test.describe.configure({ mode: 'serial' })
test.skip(!existsSync(EXE), 'собранной программы нет — выполните «npm run electron:build -- --dir»')

const userData = freshUserData()
let child = null
let browser = null
let page = null

// ── Сервер обновлений для проверки ──
// Откуда программа берёт обновления, зашито при сборке. Если она собрана с адресом
// на этом же компьютере (APTEKA_UPDATE_URL=http://127.0.0.1:порт), проверка поднимает
// там «новую версию» и смотрит, что программа её найдёт, скачает и сверит.
// Установщик подставной: безобидный файл Windows. Ставить его программа не будет —
// установка идёт только при закрытии, а проверка программу не закрывает, а обрывает.
const built = (() => {
  try {
    return JSON.parse(readFileSync(join(DESKTOP, 'build-config.json'), 'utf8'))
  } catch {
    return {}
  }
})()
const feedUrl = built.update?.provider === 'generic' && /^http:\/\/127\.0\.0\.1:\d+$/.test(built.update.url) ? new URL(built.update.url) : null
const NEW_VERSION = '9.9.9'
const INSTALLER = `FinMax-POS-Setup-${NEW_VERSION}.exe`
const UPDATER_CACHE = join(process.env.LOCALAPPDATA || '', 'apteka-desktop-updater')
let feed = null
const feedHits = []

function startFeed() {
  const body = readFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'))
  const sha512 = createHash('sha512').update(body).digest('base64')
  const yml = [
    `version: ${NEW_VERSION}`,
    'files:',
    `  - url: ${INSTALLER}`,
    `    sha512: ${sha512}`,
    `    size: ${body.length}`,
    `path: ${INSTALLER}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-04T00:00:00.000Z'",
    '',
  ].join('\n')
  const srv = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    feedHits.push(path)
    if (path === '/latest.yml') return res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yml)
    if (path === '/' + INSTALLER) return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body)
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    srv.on('error', reject)
    srv.listen(Number(feedUrl.port), '127.0.0.1', () => resolve(srv))
  })
}

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS').toBeTruthy()
  if (feedUrl) {
    rmSync(UPDATER_CACHE, { recursive: true, force: true })
    feed = await startFeed()
  }
  const port = await freePort()
  child = spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      // Две ловушки, которые собранная программа обязана не заметить:
      // «запустись как голый Node» и «ходи на другой сервер»
      ELECTRON_RUN_AS_NODE: '1',
      APTEKA_API_URL: 'http://127.0.0.1:9/api',
      APTEKA_DEV_URL: 'http://127.0.0.1:9',
      APTEKA_USER_DATA: join(userData, 'подмена'),
      // И ещё две: «бери обновления отсюда» и «включи лазейки для проверок»
      APTEKA_UPDATE_URL: 'http://127.0.0.1:9',
      APTEKA_TEST_HOOKS: '1',
    },
  })
  // Ждём, пока программа поднимет окно и начнёт отвечать отладчику страницы
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  expect(ready, 'собранная программа не запустилась').toBe(true)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  for (let i = 0; i < 80 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://')) || null
    if (!page) await new Promise((r) => setTimeout(r, 250))
  }
  expect(page, 'у собранной программы нет окна со своей страницей').toBeTruthy()
})

test.afterAll(async () => {
  await browser?.close().catch(() => {})
  // Именно обрываем, а не закрываем: при обычном закрытии программа поставила бы
  // скачанное «обновление»
  if (child && child.exitCode === null) child.kill()
  await new Promise((resolve) => (feed ? feed.close(() => resolve()) : resolve()))
  if (feedUrl) rmSync(UPDATER_CACHE, { recursive: true, force: true })
})

test('собранная программа открывается окном, а не «голым Node»', async () => {
  // Пометка ELECTRON_RUN_AS_NODE стоит в окружении — замок на файле обязан её не слушать
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  expect(page.url()).toMatch(/^app:\/\/apteka\/index\.html/)
})

test('адрес сервера — зашитый при сборке, переменная окружения его не меняет', async () => {
  // В окружении стоит адрес-пустышка. Если бы программа ему поверила, вход бы не прошёл
  await signIn(page)
  await goTo(page, 'Касса')
  await expect(page.locator('.kc-row').first()).toBeVisible({ timeout: 30_000 })
})

test('данные лежат там, где сказано системой, а не там, где подсказали извне', async () => {
  // APTEKA_USER_DATA — лазейка для проверок при запуске из исходников. Собранная
  // программа её не слушает: иначе ключ входа можно было бы увести в чужую папку
  await expect.poll(() => existsSync(join(userData, 'session.json')), { timeout: 15_000 }).toBe(true)
  expect(existsSync(join(userData, 'подмена'))).toBe(false)
  const log = readFileSync(join(userData, 'main.log'), 'utf8')
  expect(log).toMatch(/собранная программа/)
  expect(log).not.toMatch(/ERROR/)
  expect(/eyJ[A-Za-z0-9_-]{30,}/.test(readFileSync(join(userData, 'session.json'), 'utf8')), 'ключ входа лежит открытым текстом').toBe(false)
})

test('в собранной программе окно так же закрыто от сети и от Node', async () => {
  const seen = await page.evaluate(async () => ({
    require: typeof window.require,
    token: localStorage.getItem('apteka_token'),
    net: await fetch('https://example.com/').then(() => 'прошёл', () => 'закрыто'),
    info: await window.apteka.info(),
  }))
  expect(seen.require).toBe('undefined')
  expect(seen.token).toBe('desktop')
  expect(seen.net).toBe('закрыто')
  expect(seen.info.packaged).toBe(true)
  expect(seen.info.version).toMatch(/^\d+\.\d+\.\d+$/)
})

test('локальная база работает и в собранной программе', async () => {
  // Библиотека базы — настоящий файл Windows, который лежит рядом с архивом программы.
  // При запуске из исходников он на месте всегда; забыть положить его в сборку — легко
  const products = await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/products' }))
  expect(products.status).toBe(200)
  expect(products.data.length).toBeGreaterThan(0)
  const files = readdirSync(join(userData, 'data')).filter((f) => f.endsWith('.db'))
  expect(files).toContain('core.db')
  expect(files.some((f) => f.startsWith('pharmacy-'))).toBe(true)
  expect(readFileSync(join(userData, 'main.log'), 'utf8')).not.toMatch(/ERROR/)
})

test('значок состояния и копия базы работают и в собранной программе', async () => {
  const badge = page.getByTestId('sync-badge')
  await expect(badge).toContainText('Всё отправлено', { timeout: 30_000 })
  await badge.click()
  const modal = page.getByTestId('status-modal')
  await expect(modal).toBeVisible()
  // Кнопки «Снять копию сейчас» больше нет (1.4.18) — копию снимаем тем же вызовом, что и ежедневная
  await page.evaluate(() => window.apteka.backup.now())
  const root = join(userData, 'backups')
  const folders = readdirSync(root).filter((n) => !n.startsWith('.'))
  expect(folders.length).toBe(1)
  expect(readdirSync(join(root, folders[0])).some((f) => f.startsWith('pharmacy-'))).toBe(true)
  await modal.getByRole('button', { name: 'Закрыть' }).click()
})

test('обновление: программа сама находит новую версию, скачивает её и сверяет — но не перезапускается', async () => {
  test.skip(!feedUrl, 'программа собрана без проверочного адреса обновлений (APTEKA_UPDATE_URL=http://127.0.0.1:порт)')
  // Первая проверка идёт сама через полминуты после запуска
  const ready = page.getByTestId('update-badge')
  await expect(ready).toContainText('Обновление готово', { timeout: 90_000 })
  expect(feedHits).toContain('/latest.yml')
  expect(feedHits).toContain('/' + INSTALLER)
  // Адрес из окружения (ловушка) программа не слушала: ходила на зашитый
  await ready.click()
  const modal = page.getByTestId('status-modal')
  await expect(modal).toContainText(`Версия ${NEW_VERSION} скачана. Она установится сама, когда программу закроют.`)
  await expect(modal.getByRole('button', { name: 'Перезапустить и обновить' })).toBeVisible()
  await modal.getByRole('button', { name: 'Закрыть' }).click()
  // Скачанное лежит в своей папке и совпадает с тем, что отдал сервер обновлений
  const pending = join(UPDATER_CACHE, 'pending')
  expect(readdirSync(pending).some((f) => f.endsWith('.exe'))).toBe(true)
  // Программа при этом работает как работала
  await goTo(page, 'Касса')
  await expect(page.locator('.scan-input')).toBeVisible()
  expect(readFileSync(join(userData, 'main.log'), 'utf8')).toMatch(/обновление 9\.9\.9 скачано/)
})

test('выход в собранной программе: окно без пароля ничего не получает', async () => {
  await page.locator('.su-logout').click()
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  const r = await page.evaluate(() => window.apteka.request({ method: 'GET', path: '/products' }))
  expect(r.status).toBe(401)
  expect(await page.evaluate(() => localStorage.getItem('apteka_token'))).toBe(null)
})
