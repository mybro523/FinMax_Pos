// ── Сборка программы для Windows ──
//
// Три шага:
//   1) собрать интерфейс из client/ в режиме desktop → desktop/renderer;
//   2) записать адрес сервера в build-config.json — он кладётся внутрь программы;
//   3) упаковать всё в установщик (electron-builder, NSIS) → desktop/release.
//
// Запуск:  npm run electron:build            — установщик .exe
//          npm run electron:build -- --dir   — только распакованная папка, без
//                                              установщика (быстрее, для проверок)
//          npm run electron:publish          — установщик + выкладка в репозиторий
//                                              обновлений (нужен ключ GH_TOKEN)
//
// Адрес сервера берётся из переменной окружения APTEKA_API_URL (или привычной по
// сайту VITE_API_URL), а если её нет — из файла desktop/.env.
//
// Обновления. Откуда программа будет их брать, тоже зашивается при сборке:
//   APTEKA_UPDATE_REPO=владелец/репозиторий — открытый репозиторий GitHub, в который
//                                             выкладываются установщики;
//   APTEKA_UPDATE_URL=https://…             — или просто адрес папки с файлами.
// Не задано ни то, ни другое — программа соберётся без автообновления.
// APTEKA_VERSION=1.2.0 задаёт версию сборки, не трогая package.json.
//
// Windows 7 и 8:  npm run electron:build -- --legacy
//   та же программа на старом движке (Electron 22) — один установщик для 32- и 64-разрядной
//   Windows → desktop/release-legacy. Обновляется своим каналом (legacy.yml), см. legacy.mjs.
//   Выпуск несёт оба установщика: сначала --legacy, потом обычная выкладка (--publish) —
//   она кладёт установщик для Windows 7 и 8 в тот же выпуск и без него выпуск не открывает.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT, DESKTOP, clientBin, loadEnv } from './env.mjs'
import { normalizeApiUrl } from '../src/config.mjs'
import { feedFromRepo, normalizeFeed } from '../src/updater.mjs'
import { checkFeedFile, createReleases, legacyAssets, modernAssets } from './github-release.mjs'
import { prepareLegacy } from './legacy.mjs'
import { scanBuild } from './compat-scan.mjs'

const args = process.argv.slice(2)
const dirOnly = args.includes('--dir')
const publish = args.includes('--publish')
// Сборка для Windows 7 и 8 (старый движок Electron 22)
const legacy = args.includes('--legacy')
const LEGACY_DIR = join(DESKTOP, 'legacy')

function fail(msg) {
  console.error('\n' + '='.repeat(70) + '\n' + msg + '\n' + '='.repeat(70) + '\n')
  process.exit(1)
}

function run(title, cmd, cmdArgs, opts) {
  console.log(`\n── ${title} ──`)
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (r.status !== 0) fail(`Шаг «${title}» не удался (код ${r.status ?? 'нет'}).`)
}

// ── Адрес сервера ──
const env = loadEnv()
const asked = env.APTEKA_API_URL || env.VITE_API_URL || ''
const apiUrl = normalizeApiUrl(asked)
if (!apiUrl) {
  fail(
    asked
      ? `Адрес сервера не годится: «${asked}».\nНужен адрес вида https://…/api (только защищённое соединение).`
      : 'Не задан адрес сервера.\nУкажите его переменной окружения APTEKA_API_URL или в файле desktop/.env\n(образец — desktop/.env.example). Пример: https://example.up.railway.app/api',
  )
}

// ── Источник обновлений и версия ──
const askedFeed = env.APTEKA_UPDATE_REPO || env.APTEKA_UPDATE_URL || ''
const feed = feedFromRepo(env.APTEKA_UPDATE_REPO) || (env.APTEKA_UPDATE_URL ? normalizeFeed({ provider: 'generic', url: env.APTEKA_UPDATE_URL }) : null)
if (askedFeed && !feed) {
  fail(`Источник обновлений не годится: «${askedFeed}».\nНужно «владелец/репозиторий» (APTEKA_UPDATE_REPO) или адрес https://… (APTEKA_UPDATE_URL).`)
}
if (publish && feed?.provider !== 'github') fail('Выкладывать обновление можно только в репозиторий GitHub: задайте APTEKA_UPDATE_REPO=владелец/репозиторий.')
if (publish && legacy) fail('Установщик для Windows 7 и 8 выкладывается вместе с обычным, отдельным шагом выпуска.\nСоберите его без --publish.')
if (publish && !env.GH_TOKEN) fail('Для выкладки нужен ключ GitHub в переменной окружения GH_TOKEN.\nВ файлы проекта его не кладите.')

const version = String(env.APTEKA_VERSION || JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version)
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Версия не годится: «${version}». Нужна вида 1.2.3.`)

// ── 1. Интерфейс ──
const vite = clientBin('vite', 'bin', 'vite.js')
if (!existsSync(vite)) fail('Не найден сборщик интерфейса. Выполните «npm install» в папке client.')
run('Интерфейс', process.execPath, [vite, 'build', '--mode', 'desktop'], { cwd: CLIENT })
if (!existsSync(join(DESKTOP, 'renderer', 'index.html'))) fail('Интерфейс собрался, но desktop/renderer/index.html не появился.')

// ── 2. Настройки сборки ──
// У сборки для Windows 7 и 8 свой канал обновлений: она берёт legacy.yml, а не latest.yml.
// Её настройки лежат в её папке (desktop/legacy) — настройки обычной сборки не трогаем
const buildConfig = { apiUrl, version, builtAt: new Date().toISOString(), ...(feed ? { update: legacy ? { ...feed, channel: 'legacy' } : feed } : {}) }
if (!legacy) writeFileSync(join(DESKTOP, 'build-config.json'), JSON.stringify(buildConfig, null, 2) + '\n', 'utf8')
console.log(`\nАдрес сервера в сборке: ${apiUrl}`)
console.log(feed ? `Обновления: ${feed.provider === 'github' ? `репозиторий ${feed.owner}/${feed.repo}` : feed.url}` : 'Обновления: выключены (источник не задан)')
console.log(`Версия: ${version}`)
if (legacy) console.log('Сборка: для Windows 7 и 8 (Electron 22, 32 и 64 бита), канал обновлений legacy')

// ── 3. Упаковка ──
const builder = join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js')
if (!existsSync(builder)) fail('Не найден electron-builder. Выполните «npm install» в папке desktop.')

// Выпуск на GitHub заводится заранее и черновиком — почему, см. github-release.mjs.
// Делается до упаковки: откажи GitHub (ключ не тот, версия уже выложена) — узнаем это
// сразу, а не после пяти минут сборки
const releases = publish && !dirOnly ? createReleases({ owner: feed.owner, repo: feed.repo, token: env.GH_TOKEN }) : null
if (releases) {
  try {
    await releases.prepare(version)
    console.log(`\nВыпуск ${version} заведён черновиком в ${feed.owner}/${feed.repo} — аптеки его пока не видят`)
  } catch (e) {
    fail(e.message)
  }
}
// Пометку редактора VS Code снимаем и здесь: упаковщик запускает Electron сам
const buildEnv = { ...process.env }
delete buildEnv.ELECTRON_RUN_AS_NODE
// Источник обновлений упаковщику нужен, чтобы положить рядом с установщиком описание
// версии (latest.yml), а внутрь программы — где его искать (app-update.yml)
const feedArgs = !feed
  ? []
  : feed.provider === 'github'
    ? // Упаковщик кладёт файлы в черновик, заведённый выше; открывает его этот
      // сценарий — в самом конце, когда в выпуске всё на месте
      ['-c.publish.provider=github', `-c.publish.owner=${feed.owner}`, `-c.publish.repo=${feed.repo}`, '-c.publish.releaseType=draft']
    : ['-c.publish.provider=generic', `-c.publish.url=${feed.url}`]
if (legacy) {
  // ── 3а. Windows 7 и 8: папка старой сборки и один установщик на 32 и 64 бита ──
  if (!existsSync(join(LEGACY_DIR, 'node_modules', 'better-sqlite3'))) fail('Не установлены пакеты сборки для Windows 7 и 8.\nВыполните «npm install --ignore-scripts» в папке desktop/legacy.')
  console.log('\n── Папка сборки для Windows 7 и 8 ──')
  await prepareLegacy({ desktop: DESKTOP, client: CLIENT, legacy: LEGACY_DIR, buildConfig })
  // Ничего новее старого движка: Chrome 108 в окне, Node 16 в основной части
  const found = scanBuild({ readdirSync, readFileSync, join }, LEGACY_DIR)
  if (found.length) fail('В сборке для Windows 7 и 8 есть то, чего нет в старом движке:\n' + found.map((f) => `  ${f.file}: ${f.what} … ${f.at}`).join('\n'))
  console.log('Проверка старого движка: ничего новее Chrome 108 и Node 16 нет')
  run(
    dirOnly ? 'Упаковка для Windows 7 и 8 (папки, без установщика)' : 'Упаковка для Windows 7 и 8 (установщик)',
    process.execPath,
    [
      builder,
      '--projectDir',
      LEGACY_DIR,
      '--win',
      ...(dirOnly ? ['--dir'] : ['nsis']),
      '--x64',
      '--ia32',
      `-c.extraMetadata.version=${version}`,
      ...feedArgs,
      // Описание версии — в legacy.yml: его читает только программа для Windows 7 и 8
      ...(feed ? ['-c.publish.channel=legacy'] : []),
      '--publish',
      'never',
    ],
    { cwd: LEGACY_DIR, env: buildEnv },
  )
} else {
  run(
    dirOnly ? 'Упаковка (папка, без установщика)' : publish ? 'Упаковка и выкладка обновления' : 'Упаковка (установщик)',
    process.execPath,
    [
      builder,
      '--win',
      ...(dirOnly ? ['--dir'] : ['nsis']),
      '--x64',
      `-c.extraMetadata.version=${version}`,
      ...feedArgs,
      '--publish',
      publish && !dirOnly ? 'always' : 'never',
    ],
    { cwd: DESKTOP, env: buildEnv },
  )
}

// ── 4. Установщик для Windows 7 и 8 — в тот же черновик ──
// Он собирается отдельно и раньше (npm run electron:build -- --legacy). Без него выпуск не
// открывается: программы на Windows 7 и 8 читают только legacy.yml и иначе перестали бы
// обновляться. Описания версий сверяются, чтобы не отправить программам чужой установщик
if (releases) {
  try {
    const legacyDir = join(DESKTOP, 'release-legacy')
    const names = legacyAssets(version)
    const missing = names.filter((n) => !existsSync(join(legacyDir, n)))
    if (missing.length) {
      throw new Error(`Нет установщика для Windows 7 и 8 версии ${version}: ${missing.join(', ')}.\nСоберите его (npm run electron:build -- --legacy) и повторите выкладку. Выпуск остался черновиком — магазины его не видят.`)
    }
    const badLegacy = checkFeedFile(readFileSync(join(legacyDir, 'legacy.yml'), 'utf8'), { version, installer: names[0] })
    if (badLegacy) throw new Error(`legacy.yml не подходит: ${badLegacy}.`)
    const badModern = checkFeedFile(readFileSync(join(DESKTOP, 'release', 'latest.yml'), 'utf8'), { version, installer: modernAssets(version)[0] })
    if (badModern) throw new Error(`latest.yml не подходит: ${badModern}.`)
    for (const n of names) {
      console.log(`Кладу в выпуск: ${n}`)
      await releases.upload(version, n, readFileSync(join(legacyDir, n)), n.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream')
    }
  } catch (e) {
    fail(e.message)
  }
}

// ── 5. Открыть выпуск магазинам ──
if (releases) {
  try {
    const rel = await releases.publish(version)
    console.log(`\nВыпуск ${version} открыт: ${rel.html_url}`)
  } catch (e) {
    fail(e.message)
  }
}

console.log(`\nГотово. Результат — в папке desktop/${legacy ? 'release-legacy' : 'release'}`)
