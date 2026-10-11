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
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT, DESKTOP, clientBin, loadEnv } from './env.mjs'
import { normalizeApiUrl } from '../src/config.mjs'
import { feedFromRepo, normalizeFeed } from '../src/updater.mjs'
import { createReleases } from './github-release.mjs'

const args = process.argv.slice(2)
const dirOnly = args.includes('--dir')
const publish = args.includes('--publish')

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
if (publish && !env.GH_TOKEN) fail('Для выкладки нужен ключ GitHub в переменной окружения GH_TOKEN.\nВ файлы проекта его не кладите.')

const version = String(env.APTEKA_VERSION || JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version)
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Версия не годится: «${version}». Нужна вида 1.2.3.`)

// ── 1. Интерфейс ──
const vite = clientBin('vite', 'bin', 'vite.js')
if (!existsSync(vite)) fail('Не найден сборщик интерфейса. Выполните «npm install» в папке client.')
run('Интерфейс', process.execPath, [vite, 'build', '--mode', 'desktop'], { cwd: CLIENT })
if (!existsSync(join(DESKTOP, 'renderer', 'index.html'))) fail('Интерфейс собрался, но desktop/renderer/index.html не появился.')

// ── 2. Настройки сборки ──
writeFileSync(
  join(DESKTOP, 'build-config.json'),
  JSON.stringify({ apiUrl, version, builtAt: new Date().toISOString(), ...(feed ? { update: feed } : {}) }, null, 2) + '\n',
  'utf8',
)
console.log(`\nАдрес сервера в сборке: ${apiUrl}`)
console.log(feed ? `Обновления: ${feed.provider === 'github' ? `репозиторий ${feed.owner}/${feed.repo}` : feed.url}` : 'Обновления: выключены (источник не задан)')
console.log(`Версия: ${version}`)

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

// ── 4. Открыть выпуск аптекам ──
if (releases) {
  try {
    const rel = await releases.publish(version)
    console.log(`\nВыпуск ${version} открыт: ${rel.html_url}`)
  } catch (e) {
    fail(e.message)
  }
}

console.log('\nГотово. Результат — в папке desktop/release')
