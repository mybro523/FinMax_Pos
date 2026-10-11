// ── Настоящая проверка обновления: установить, обновить, убедиться, убрать ──
//
// Обычные проверки смотрят, что программа находит и скачивает новую версию. Но
// главное — последний шаг: установщик должен тихо поставить её поверх работающей
// программы, программа должна запуститься сама, а вход, локальная база и чеки —
// остаться на месте. Проверить это можно только по-настоящему, поэтому сценарий:
//
//   1) собирает два установщика — версии 1.0.0 и 1.0.1 — под отдельным именем
//      (AptekaUpdateTest), с источником обновлений на этом же компьютере;
//   2) ставит 1.0.0, запускает, входит, пробивает чек;
//   3) ждёт, пока программа сама скачает 1.0.1, и нажимает «Перезапустить и обновить»;
//   4) убеждается, что запустилась 1.0.1, номер кассы прежний, вход и база на месте,
//      перед установкой снята копия баз, в журнале нет ошибок;
//   5) удаляет программу и её данные.
//
// ВНИМАНИЕ: сценарий по-настоящему ставит программу в профиль текущего пользователя
// Windows (без прав администратора и без ярлыков) и в конце удаляет её. Папка
// установки у проверочной сборки та же, что у настоящей программы, поэтому, если
// на этом компьютере «Аптека» уже установлена, сценарий ничего не делает.
//
// Перед запуском: интерфейс собран («npm run electron:build -- --dir»), сервер из
// зашитого адреса работает, APP_USER/APP_PASS — владелец проверочной аптеки.
// Запуск:  APP_USER=… APP_PASS=… npm run test:update
import { chromium } from '@playwright/test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP, loadEnv } from './env.mjs'

const env = loadEnv()
const USER = env.APP_USER || ''
const PASS = env.APP_PASS || ''
const NAME = 'AptekaUpdateTest'
const FEED_PORT = 47811
const FEED = `http://127.0.0.1:${FEED_PORT}`
const userData = join(env.APPDATA || '', NAME)
const updaterCache = join(env.LOCALAPPDATA || '', 'apteka-desktop-updater')
// Папка установки называется по имени пакета, а не по названию программы
const installDir = join(env.LOCALAPPDATA || '', 'Programs', 'apteka-desktop')
const exe = join(installDir, 'Apteka.exe')
const configFile = join(DESKTOP, 'build-config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const mainLog = () => (existsSync(join(userData, 'main.log')) ? readFileSync(join(userData, 'main.log'), 'utf8') : '')
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
const stopApp = () => ps(`Get-Process | Where-Object { $_.Path -like '${installDir}\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`)
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

// ── Сборка двух установщиков ──
// Адрес сервера — тот же, что в нынешней сборке; источник обновлений — этот компьютер.
// Настройки сборки на это время подменяются и потом возвращаются как были.
function buildInstallers(out) {
  const builder = join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js')
  const before = readFileSync(configFile, 'utf8')
  const config = JSON.parse(before)
  if (!config.apiUrl) throw new Error('в build-config.json нет адреса сервера — сначала «npm run electron:build -- --dir»')
  writeFileSync(configFile, JSON.stringify({ ...config, update: { provider: 'generic', url: FEED } }, null, 2) + '\n', 'utf8')
  const buildEnv = { ...process.env }
  delete buildEnv.ELECTRON_RUN_AS_NODE
  try {
    for (const version of ['1.0.0', '1.0.1']) {
      say(`собираю установщик ${version}…`)
      const r = spawnSync(
        process.execPath,
        [
          builder, '--win', 'nsis', '--x64', '--publish', 'never',
          `-c.productName=${NAME}`, `-c.extraMetadata.productName=${NAME}`, '-c.appId=tj.apteka.updatetest',
          '-c.publish.provider=generic', `-c.publish.url=${FEED}`,
          // Ни ярлыков, ни запуска после установки: это проверка, а не установка для работы
          '-c.nsis.createDesktopShortcut=false', '-c.nsis.createStartMenuShortcut=false', '-c.nsis.runAfterFinish=false',
          `-c.extraMetadata.version=${version}`, `-c.directories.output=${join(out, version)}`,
        ],
        { cwd: DESKTOP, env: buildEnv, stdio: 'ignore' },
      )
      if (r.status !== 0 || !existsSync(join(out, version, `Apteka-Setup-${version}.exe`))) throw new Error(`установщик ${version} не собрался`)
    }
  } finally {
    writeFileSync(configFile, before, 'utf8')
  }
}

let feed = null
let failed = null
let installed = false

async function cleanup(out) {
  try {
    if (installed) {
      stopApp()
      await sleep(1500)
      const un = existsSync(installDir) ? readdirSync(installDir).find((f) => /^Uninstall .*\.exe$/i.test(f)) : null
      if (un) {
        spawnSync(join(installDir, un), ['/S'], { stdio: 'ignore' })
        for (let i = 0; i < 60 && existsSync(exe); i++) await sleep(500)
      }
      await sleep(1500)
      for (const dir of [userData, updaterCache, installDir]) rmSync(dir, { recursive: true, force: true })
      say('убрано: программа', existsSync(installDir) ? 'ОСТАЛАСЬ' : 'удалена', '· данные', existsSync(userData) ? 'ОСТАЛИСЬ' : 'удалены')
    }
    rmSync(out, { recursive: true, force: true })
  } catch (e) {
    say('уборка:', e.message)
  }
  await new Promise((r) => (feed ? feed.close(() => r()) : r()))
}

const out = mkdtempSync(join(tmpdir(), 'apteka-update-'))
try {
  if (!USER || !PASS) throw new Error('нужны APP_USER и APP_PASS — логин и пароль владельца проверочной аптеки')
  // Чужое не трогаем: ни настоящую установленную программу, ни её данные
  if (existsSync(installDir)) throw new Error(`на этом компьютере уже установлена программа (${installDir}) — проверка её задела бы`)
  if (existsSync(userData)) throw new Error(`папка ${userData} уже есть — не трогаю`)

  buildInstallers(out)

  // ── «Сервер обновлений»: отдаёт версию 1.0.1 ──
  const hits = []
  feed = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0].slice(1))
    hits.push(name)
    const file = join(out, '1.0.1', name)
    if (!/^[\w.-]+$/.test(name) || !existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(res)
  })
  await new Promise((resolve, reject) => feed.on('error', reject).listen(FEED_PORT, '127.0.0.1', resolve))

  // ── Установка 1.0.0 ──
  say('ставлю 1.0.0…')
  installed = true
  const r = spawnSync(join(out, '1.0.0', 'Apteka-Setup-1.0.0.exe'), ['/S'], { stdio: 'ignore' })
  if (r.status !== 0) throw new Error('установщик вернул ' + r.status)
  for (let i = 0; i < 120 && !existsSync(exe); i++) await sleep(500)
  if (!existsSync(exe)) throw new Error('программа не установилась')

  // ── Запуск и вход ──
  const port = await freePort()
  spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore', detached: true }).unref()
  let ready = false
  for (let i = 0; i < 160 && !ready; i++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      await sleep(250)
    }
  }
  if (!ready) throw new Error('установленная программа не запустилась')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://')) || null
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('у программы нет окна')
  await page.locator('.login-card').waitFor({ timeout: 30000 })
  await page.locator('#lg-name').fill(USER)
  await page.locator('#lg-pw').fill(PASS)
  await page.locator('.login-card button.btn.block').click()
  await page.locator('.sidebar').waitFor({ timeout: 60000 })
  const tour = page.locator('.tur-card')
  if (await tour.isVisible({ timeout: 4000 }).catch(() => false)) await tour.getByRole('button', { name: 'Пропустить' }).click()
  const info = await page.evaluate(() => globalThis.apteka.info())
  if (info.version !== '1.0.0') throw new Error('ожидалась версия 1.0.0, а запущена ' + info.version)
  say('установлена и запущена версия 1.0.0, вход выполнен')

  // Чек до обновления: он обязан пережить его
  const products = (await page.evaluate(() => globalThis.apteka.request({ method: 'GET', path: '/products' }))).data
  const product = products.find((p) => p.stock >= 3 && p.unitsPerPack === 1 && !p.expiredUnits)
  if (!product) throw new Error('в проверочной аптеке нет товара с остатком')
  const sale = await page.evaluate((id) => globalThis.apteka.request({ method: 'POST', path: '/sales', body: { payment: 'cash', items: [{ productId: id, qty: 1 }] } }), product.id)
  if (sale.status !== 201) throw new Error('продажа не прошла: ' + JSON.stringify(sale.data))

  // ── Обновление ──
  await page.getByTestId('update-badge').waitFor({ timeout: 180000 })
  say('программа сама скачала 1.0.1; запрашивала:', [...new Set(hits)].join(', '))
  await page.getByTestId('update-badge').click()
  const modal = page.getByTestId('status-modal')
  await modal.getByText('Версия 1.0.1 скачана').waitFor({ timeout: 15000 })
  const device = (mainLog().match(/касса ([0-9a-f-]{36})/) || [])[1]
  say('нажимаю «Перезапустить и обновить»…')
  await modal.getByRole('button', { name: 'Перезапустить и обновить' }).click().catch(() => {})
  await browser.close().catch(() => {})

  // Программа закрывается, ставит новую версию и запускается сама
  let relaunched = false
  for (let i = 0; i < 360 && !relaunched; i++) {
    relaunched = /запуск: версия 1\.0\.1/.test(mainLog())
    if (!relaunched) await sleep(500)
  }
  if (!relaunched) throw new Error('новая версия не запустилась. Конец журнала:\n' + mainLog().split('\n').slice(-25).join('\n'))
  await sleep(4000)

  const text = mainLog()
  const starts = [...text.matchAll(/запуск: версия (\S+),/g)].map((m) => m[1])
  const devices = [...text.matchAll(/касса ([0-9a-f-]{36})/g)].map((m) => m[1])
  if (starts.join() !== '1.0.0,1.0.1') throw new Error('ожидались запуски 1.0.0 → 1.0.1, а в журнале: ' + starts.join(' → '))
  if (new Set(devices).size !== 1 || devices[0] !== device) throw new Error('номер кассы изменился — данные программы потеряны')
  if (/ERROR/.test(text)) throw new Error('в журнале ошибки:\n' + text.split('\n').filter((l) => /ERROR/.test(l)).join('\n'))
  if (!/копия баз снята/.test(text)) throw new Error('перед обновлением не снята копия баз')
  const onDisk = ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`)
  if (!onDisk.startsWith('1.0.1')) throw new Error('на диске не 1.0.1, а ' + onDisk)
  for (const f of ['session.json', join('data', 'core.db')]) if (!existsSync(join(userData, f))) throw new Error('после обновления нет ' + f)
  say('запуски по журналу:', starts.join(' → '), '· файл на диске:', onDisk, '· номер кассы прежний · вход и база на месте')
  say('ИТОГ: обновление 1.0.0 → 1.0.1 прошло, данные целы')
} catch (e) {
  failed = e
  say('ПРОВАЛ:', e.message)
} finally {
  await cleanup(out)
}
process.exit(failed ? 1 : 0)
