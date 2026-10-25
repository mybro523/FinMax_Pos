// ── Обновление программы ──
//
// Сам механизм скачивания и установки — чужая библиотека, её здесь нет. Проверяется
// наше: откуда разрешено брать обновления, когда проверять, что показывать человеку
// и что программа никогда не перезапускается сама посреди работы.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUpdater, dropOldUpdaterCache, feedFromRepo, feedYaml, normalizeFeed, OLD_UPDATER_CACHE_DIR, UPDATER_CACHE_DIR } from '../src/updater.mjs'
import { manualTimers } from '../test-support/server.mjs'

const FEED = { provider: 'github', owner: 'mybro523', repo: 'apteka-ustanovka' }

// Библиотека обновлений — заглушкой: помнит, о чём её просили, и сообщает то, что велят
function fakeLibrary() {
  const lib = new EventEmitter()
  lib.checks = 0
  lib.installed = []
  // Что случится при проверке: функция, которая шлёт события
  lib.onCheck = () => lib.emit('update-not-available', {})
  lib.checkForUpdates = async () => {
    lib.checks++
    lib.emit('checking-for-update')
    await lib.onCheck()
  }
  lib.quitAndInstall = (silent, runAfter) => lib.installed.push({ silent, runAfter })
  return lib
}

function setup(over = {}) {
  const lib = fakeLibrary()
  const timers = manualTimers()
  const states = []
  const updater = createUpdater({ autoUpdater: lib, feed: FEED, timers, onState: (s) => states.push({ ...s }), ...over })
  // Сработать ближайшему таймеру
  const fire = async () => {
    const [next] = [...timers.pending].sort((a, b) => a.ms - b.ms)
    timers.pending.delete(next)
    await next.fn()
    return next.ms
  }
  return { lib, timers, states, updater, fire }
}

test('откуда брать обновления: открытый репозиторий или защищённый адрес — и ничего другого', () => {
  assert.deepEqual(normalizeFeed(FEED), FEED)
  assert.deepEqual(feedFromRepo('mybro523/apteka-ustanovka'), FEED)
  assert.deepEqual(feedFromRepo('  mybro523/apteka-ustanovka '), FEED)
  assert.equal(feedFromRepo('просто-имя'), null)
  assert.equal(feedFromRepo('a/b/c'), null)
  assert.equal(feedFromRepo(''), null)
  assert.equal(normalizeFeed({ provider: 'github', owner: '../..', repo: 'x' }), null)
  assert.equal(normalizeFeed({ provider: 'github', owner: 'ok', repo: 'bad name' }), null)

  assert.deepEqual(normalizeFeed({ provider: 'generic', url: 'https://example.com/apteka/' }), { provider: 'generic', url: 'https://example.com/apteka' })
  assert.deepEqual(normalizeFeed({ provider: 'generic', url: 'http://127.0.0.1:8123/' }), { provider: 'generic', url: 'http://127.0.0.1:8123' })
  // По открытому соединению программу не качаем: её подменил бы любой по дороге
  assert.equal(normalizeFeed({ provider: 'generic', url: 'http://example.com/apteka' }), null)
  assert.equal(normalizeFeed({ provider: 'generic', url: 'https://user:pass@example.com/' }), null)
  assert.equal(normalizeFeed({ provider: 'generic', url: 'не адрес' }), null)
  assert.equal(normalizeFeed({ provider: 's3', bucket: 'x' }), null)
  assert.equal(normalizeFeed(null), null)
  assert.equal(normalizeFeed('mybro523/apteka'), null)
})

test('источник не задан — обновления выключены и ничего не делают', async () => {
  const lib = fakeLibrary()
  const timers = manualTimers()
  const u = createUpdater({ autoUpdater: lib, feed: null, timers })
  assert.equal(u.state().state, 'off')
  u.start()
  assert.equal(timers.pending.size, 0, 'выключенное обновление не должно ничего планировать')
  assert.equal(await u.check(), false)
  assert.equal(await u.install(), false)
  assert.equal(lib.checks, 0)
})

test('первая проверка — через полминуты после запуска, дальше раз в четыре часа', async () => {
  const t = setup()
  assert.equal(t.updater.state().state, 'idle')
  t.updater.start()
  assert.equal(await t.fire(), 30000)
  assert.equal(t.lib.checks, 1)
  assert.equal(await t.fire(), 4 * 3600 * 1000)
  assert.equal(t.lib.checks, 2)
  assert.equal(t.updater.state().state, 'idle', 'новой версии нет — и показывать нечего')
  assert.ok(t.updater.state().checkedAt)
  t.updater.stop()
  assert.equal(t.timers.pending.size, 0)
})

test('новая версия: качается сама, человек видит ход и готовность — но программа не перезапускается', async () => {
  const t = setup()
  t.lib.onCheck = () => {
    t.lib.emit('update-available', { version: '1.2.0' })
    t.lib.emit('download-progress', { percent: 41.7 })
    t.lib.emit('download-progress', { percent: 100 })
    t.lib.emit('update-downloaded', { version: '1.2.0' })
  }
  await t.updater.check()
  assert.deepEqual(
    t.states.map((s) => `${s.state}:${s.percent}`),
    ['checking:0', 'downloading:0', 'downloading:42', 'downloading:99', 'ready:100', 'ready:100'],
    'ход закачки: сто процентов показываем, только когда файл скачан и сверен',
  )
  assert.equal(t.updater.state().version, '1.2.0')
  assert.deepEqual(t.lib.installed, [], 'обновление поставилось само, посреди работы')
  // Библиотеке велено ставить скачанное при закрытии программы — и ни о чём не спрашивать
  assert.equal(t.lib.autoInstallOnAppQuit, true)
  assert.equal(t.lib.autoDownload, true)
  assert.equal(t.lib.allowDowngrade, false)
})

test('«Перезапустить и обновить»: сначала копия баз, потом тихая установка с запуском', async () => {
  const order = []
  const t = setup({ beforeInstall: async () => order.push('копия') })
  t.lib.quitAndInstall = (silent, runAfter) => order.push(`установка silent=${silent} run=${runAfter}`)
  assert.equal(await t.updater.install(), false, 'ставить нечего — ничего и не происходит')
  assert.deepEqual(order, [])

  t.lib.onCheck = () => {
    t.lib.emit('update-available', { version: '1.2.0' })
    t.lib.emit('update-downloaded', { version: '1.2.0' })
  }
  await t.updater.check()
  assert.equal(await t.updater.install(), true)
  assert.deepEqual(order, ['копия', 'установка silent=true run=true'])
  assert.equal(await t.updater.install(), false, 'второе нажатие не запускает установку ещё раз')
})

test('копию перед обновлением снять не удалось — обновление всё равно ставится', async () => {
  const warns = []
  const t = setup({
    beforeInstall: async () => {
      throw new Error('диск полон')
    },
    log: { info() {}, warn: (m) => warns.push(m), error() {} },
  })
  t.lib.onCheck = () => t.lib.emit('update-downloaded', { version: '1.2.0' })
  await t.updater.check()
  assert.equal(await t.updater.install(), true)
  assert.equal(t.lib.installed.length, 1)
  assert.ok(warns.some((w) => /копия перед обновлением не снята/.test(w)))
})

test('нет интернета — это не ошибка: тихо, и проверка повторится', async () => {
  const t = setup()
  t.lib.onCheck = () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED')
  }
  t.updater.start()
  await t.fire()
  assert.equal(t.updater.state().state, 'idle')
  assert.equal(t.timers.pending.size, 1, 'следующая проверка должна быть запланирована')
  // Ошибка, пришедшая событием (оборвалась закачка), тоже не роняет и не пугает
  t.lib.onCheck = () => {
    t.lib.emit('update-available', { version: '1.2.0' })
    t.lib.emit('error', new Error('sha512 checksum mismatch'))
  }
  await t.fire()
  assert.equal(t.updater.state().state, 'idle', 'несверенный файл не должен считаться готовым обновлением')
  t.updater.stop()
})

test('скачанное обновление не «забывается» от следующей проверки или сбоя связи', async () => {
  const t = setup()
  t.lib.onCheck = () => {
    t.lib.emit('update-available', { version: '1.2.0' })
    t.lib.emit('update-downloaded', { version: '1.2.0' })
  }
  await t.updater.check()
  t.lib.onCheck = () => t.lib.emit('error', new Error('нет связи'))
  await t.updater.check()
  assert.equal(t.updater.state().state, 'ready')
  t.lib.onCheck = () => t.lib.emit('update-not-available', {})
  await t.updater.check()
  assert.deepEqual([t.updater.state().state, t.updater.state().version], ['ready', '1.2.0'])
})

test('описание источника для библиотеки: тот же источник, своя папка для скачанного', () => {
  assert.equal(feedYaml(FEED), 'provider: github\nowner: mybro523\nrepo: apteka-ustanovka\nupdaterCacheDirName: finmax-pos-desktop-updater\n')
  assert.equal(
    feedYaml({ provider: 'generic', url: 'http://127.0.0.1:8123' }),
    'provider: generic\nurl: "http://127.0.0.1:8123"\nupdaterCacheDirName: finmax-pos-desktop-updater\n',
  )
})

test('папка скачанных обновлений — та же, куда установщик кладёт копию себя: тогда качаются только изменения', () => {
  // Установщик называет папку по имени пакета (electron-builder: имя + «-updater»)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(UPDATER_CACHE_DIR, pkg.name + '-updater')
  assert.notEqual(UPDATER_CACHE_DIR, OLD_UPDATER_CACHE_DIR)
})

test('прежняя папка обновлений убирается; нет её или занята — запуск не ломается', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-old-'))
  const old = path.join(base, OLD_UPDATER_CACHE_DIR)
  fs.mkdirSync(path.join(old, 'pending'), { recursive: true })
  fs.writeFileSync(path.join(old, 'installer.exe'), 'старый установщик')
  fs.writeFileSync(path.join(old, 'pending', 'FinMax-POS-Setup-1.4.8.exe'), 'докачанное')
  const keep = path.join(base, UPDATER_CACHE_DIR)
  fs.mkdirSync(keep)
  fs.writeFileSync(path.join(keep, 'installer.exe'), 'нынешний установщик')
  const said = []
  const log = { info: (m) => said.push(m), warn: (m) => said.push(m) }
  assert.equal(dropOldUpdaterCache({ fs, join: path.join, localAppData: base, log }), true)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.readFileSync(path.join(keep, 'installer.exe'), 'utf8'), 'нынешний установщик', 'новую папку не трогаем')
  // Второй раз — убирать нечего
  assert.equal(dropOldUpdaterCache({ fs, join: path.join, localAppData: base, log }), false)
  // Папка не задана — ничего не делаем; ошибка файловой системы — только запись в журнал
  assert.equal(dropOldUpdaterCache({ fs, join: path.join, localAppData: '', log }), false)
  const busy = { existsSync: () => true, rmSync: () => { throw new Error('EBUSY') } }
  assert.equal(dropOldUpdaterCache({ fs: busy, join: path.join, localAppData: base, log }), false)
  assert.ok(said.some((m) => /EBUSY/.test(m)))
  fs.rmSync(base, { recursive: true, force: true })
})

test('канал Windows 7/8: только «legacy», в описании источника — строка channel; обычная сборка без неё', () => {
  const legacy = normalizeFeed({ ...FEED, channel: 'legacy' })
  assert.deepEqual(legacy, { ...FEED, channel: 'legacy' })
  // Других каналов нет: всё, что не «legacy», — обычный канал
  assert.deepEqual(normalizeFeed({ ...FEED, channel: 'beta' }), FEED)
  assert.deepEqual(normalizeFeed({ ...FEED, channel: '../latest' }), FEED)
  assert.deepEqual(normalizeFeed({ provider: 'generic', url: 'http://127.0.0.1:8123/', channel: 'legacy' }), { provider: 'generic', url: 'http://127.0.0.1:8123', channel: 'legacy' })
  const yamlLegacy = feedYaml(legacy)
  assert.match(yamlLegacy, /^channel: legacy$/m)
  assert.match(yamlLegacy, /^provider: github$/m)
  assert.match(yamlLegacy, new RegExp(`^updaterCacheDirName: ${UPDATER_CACHE_DIR}$`, 'm'))
  assert.doesNotMatch(feedYaml(FEED), /channel/, 'обычная сборка читает latest.yml, как раньше')
})
