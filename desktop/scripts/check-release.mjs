// ── Проверка выложенного установщика: скачать, как скачает аптека, поставить, войти ──
//
// Выложить установщик мало — надо убедиться, что аптека получит именно его и он
// работает. Сценарий идёт путём аптеки, без ключа GitHub:
//   1) берёт описание последней версии (latest.yml) из открытого репозитория;
//   2) скачивает установщик по общедоступной ссылке и сверяет его с описанием
//      (размер и отпечаток sha512) — тот ли это файл, целиком ли дошёл;
//   3) ставит программу, запускает, входит проверочной аптекой;
//   4) убеждается, что запущена та самая версия, что программа сама сходила за
//      обновлениями в тот же репозиторий и ответ её устроил, что в журнале нет ошибок;
//   5) удаляет программу и её данные.
//
// ВНИМАНИЕ: сценарий по-настоящему ставит программу в профиль текущего пользователя
// Windows и в конце удаляет её вместе с данными. Если на этом компьютере «Аптека» уже
// установлена или остались её данные, сценарий ничего не делает: чужое не трогаем.
//
// Запуск:  APP_USER=<владелец проверочной аптеки> APP_PASS=… npm run test:release
import { chromium } from '@playwright/test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { loadEnv } from './env.mjs'

const env = loadEnv()
const USER = env.APP_USER || ''
const PASS = env.APP_PASS || ''
const REPO = env.APTEKA_UPDATE_REPO || ''
// Имена папок — как у настоящей программы (electron-builder.yml)
const userData = join(env.APPDATA || '', 'Apteka')
const updaterCache = join(env.LOCALAPPDATA || '', 'apteka-desktop-updater')
const installDir = join(env.LOCALAPPDATA || '', 'Programs', 'apteka-desktop')
const exe = join(installDir, 'Apteka.exe')

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
const shortcuts = () =>
  [join(homedir(), 'Desktop', 'Аптека.lnk'), join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Аптека.lnk')].filter((f) => existsSync(f))

let failed = null
let installed = false
const out = mkdtempSync(join(tmpdir(), 'apteka-release-'))

async function cleanup() {
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
      // Удаление программы её данные не стирает (так задумано: там неотправленные
      // чеки). Здесь данные создала сама проверка — она их и убирает
      for (const dir of [userData, updaterCache, installDir]) rmSync(dir, { recursive: true, force: true })
      say(
        'убрано: программа',
        existsSync(installDir) ? 'ОСТАЛАСЬ' : 'удалена',
        '· данные',
        existsSync(userData) ? 'ОСТАЛИСЬ' : 'удалены',
        '· ярлыки',
        shortcuts().length ? 'ОСТАЛИСЬ' : 'удалены',
      )
    }
    rmSync(out, { recursive: true, force: true })
  } catch (e) {
    say('уборка:', e.message)
  }
}

try {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error('не задан репозиторий установщиков (APTEKA_UPDATE_REPO=владелец/репозиторий в desktop/.env)')
  if (!USER || !PASS) throw new Error('нужны APP_USER и APP_PASS — логин и пароль владельца проверочной аптеки')
  // Чужое не трогаем: ни установленную программу, ни её данные
  if (existsSync(installDir)) throw new Error(`на этом компьютере уже установлена программа (${installDir}) — проверка её задела бы`)
  if (existsSync(userData)) throw new Error(`папка ${userData} уже есть — не трогаю`)

  // ── 1. Описание последней версии — как его видит программа в аптеке ──
  const feed = `https://github.com/${REPO}/releases/latest/download`
  const ymlRes = await fetch(`${feed}/latest.yml`, { redirect: 'follow' })
  if (!ymlRes.ok) throw new Error(`описание версии недоступно без ключа: ${feed}/latest.yml → ${ymlRes.status}`)
  const yml = await ymlRes.text()
  const pick = (name) => (yml.match(new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm')) || [])[1] || ''
  const version = pick('version')
  const file = pick('path')
  const sha512 = pick('sha512')
  const size = Number((yml.match(/^\s+size:\s*(\d+)\s*$/m) || [])[1] || 0)
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[\w.-]+\.exe$/.test(file) || !sha512) throw new Error('описание версии не разобрано:\n' + yml)
  say(`последняя версия в ${REPO}: ${version}, файл ${file}, ${Math.round(size / 1048576)} МБ`)

  // ── 2. Установщик по общедоступной ссылке ──
  const installer = join(out, file)
  const url = `https://github.com/${REPO}/releases/download/v${version}/${file}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`установщик недоступен без ключа: ${url} → ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(installer))
  const got = createHash('sha512').update(readFileSync(installer)).digest('base64')
  if (size && statSync(installer).size !== size) throw new Error(`размер установщика ${statSync(installer).size}, а в описании ${size}`)
  if (got !== sha512) throw new Error('отпечаток установщика не совпал с описанием версии — файл не тот или повреждён')
  say('установщик скачан без ключа, размер и отпечаток совпали с описанием')

  // ── 3. Установка, запуск, вход ──
  say(`ставлю ${version}…`)
  installed = true
  const r = spawnSync(installer, ['/S'], { stdio: 'ignore' })
  if (r.status !== 0) throw new Error('установщик вернул ' + r.status)
  for (let i = 0; i < 120 && !existsSync(exe); i++) await sleep(500)
  if (!existsSync(exe)) throw new Error('программа не установилась')
  if (shortcuts().length < 2) throw new Error('ярлыки «Аптека» на рабочем столе и в меню «Пуск» не появились')

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

  // ── 4. Та ли версия, туда ли ходит за обновлениями ──
  const info = await page.evaluate(() => globalThis.apteka.info())
  if (info.version !== version) throw new Error(`ожидалась версия ${version}, а запущена ${info.version}`)
  const products = (await page.evaluate(() => globalThis.apteka.request({ method: 'GET', path: '/products' }))).data
  if (!Array.isArray(products)) throw new Error('после входа программа не отдала список товаров')
  say(`установлена и запущена версия ${info.version}, вход выполнен, товаров в локальной базе: ${products.length}`)

  // Программа сама проверяет обновления вскоре после запуска. Версия последняя —
  // значит, ответ «новее нет»; главное, что она дошла до репозитория и разобрала ответ
  let checked = ''
  for (let i = 0; i < 240 && !checked; i++) {
    const text = mainLog()
    if (/обновление: проверка не удалась|обновление: .*(Error|ERR_)/.test(text)) throw new Error('программа не смогла проверить обновления:\n' + text.split('\n').filter((l) => /обновление/.test(l)).slice(-6).join('\n'))
    const hit = text.split('\n').find((l) => /обновление:.*(not available|is not available|нет новее)/i.test(l))
    if (hit) checked = hit.trim()
    else await sleep(500)
  }
  if (!checked) throw new Error('за две минуты программа не проверила обновления. Конец журнала:\n' + mainLog().split('\n').slice(-15).join('\n'))
  say('программа сама проверила обновления:', checked.replace(/^.*обновление:\s*/, '').slice(0, 120))
  if (/ERROR/.test(mainLog())) throw new Error('в журнале ошибки:\n' + mainLog().split('\n').filter((l) => /ERROR/.test(l)).join('\n'))
  await browser.close().catch(() => {})
  say(`ИТОГ: выложенный установщик ${version} скачивается без ключа, ставится и работает`)
} catch (e) {
  failed = e
  say('ПРОВАЛ:', e.message)
} finally {
  await cleanup()
}
process.exit(failed ? 1 : 0)
