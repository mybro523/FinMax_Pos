// ── Основная часть программы ──
//
// Программа состоит из двух половин. Окно — это тот же интерфейс, что и на сайте:
// страница, собранная из client/. Основная часть (этот файл) — всё, чего странице
// доверять нельзя: ключ входа, запросы к серверу, файлы на диске.
//
// Окно работает в «песочнице» и разговаривает с основной частью только через
// короткий список функций (preload.cjs). Ни к диску, ни к сети, ни к системе
// у него доступа нет — даже если в интерфейс попадёт чужой сценарий, дальше окна
// он не уйдёт.
import { app, BrowserWindow, dialog, ipcMain, Menu, net, powerMonitor, protocol, safeStorage, session, shell } from 'electron'
import Database from 'better-sqlite3'
import updaterPackage from 'electron-updater'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import nodeNet from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'
import { createBackups, hostFolderOf, openOrRestore } from './backup.mjs'
import { readBuildConfig, resolveApiUrl, resolveUpdateFeed, serverOrigin } from './config.mjs'
import { createGateway } from './gateway.mjs'
import { createClock } from './local/clock.mjs'
import { getMeta, openDb, setMeta } from './local/db.mjs'
import { lastFloor, lastSeen } from './local/licence.mjs'
import { CORE_SCHEMA, PHARMACY_SCHEMA } from './local/schema.mjs'
import { createLog } from './log.mjs'
import { renderTicket } from './print/escpos.mjs'
import { LOGO } from './print/logo.mjs'
import { runPowerShell } from './print/powershell.mjs'
import { checkHost, sendNetwork, sendWindows } from './print/transport.mjs'
import { isAppUrl, registerAppProtocol, registerScheme, START_URL } from './protocol.mjs'
import { createRealtime } from './realtime.mjs'
import { createSessionStore } from './session.mjs'
import { createSettings } from './settings.mjs'
import { createUpdater, feedYaml } from './updater.mjs'
import { createWindowState, MIN_SIZE } from './window-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(ROOT, 'renderer')
const FONTS = join(ROOT, 'assets', 'fonts')
const ICON = join(ROOT, 'assets', 'icon.png')

// ── Запуск из исходников ──
// Собранная программа всегда открывает свои файлы и ходит на зашитый адрес сервера.
// Всё, что ниже, действует только при запуске из исходников — для разработки
// и проверок. У аптеки этих лазеек нет.
const DEV = !app.isPackaged
// Адрес сервера разработки интерфейса (electron:dev). Пусто — открываем сборку
const DEV_URL = DEV ? process.env.APTEKA_DEV_URL || '' : ''
// Отдельная папка данных: проверки не должны трогать настоящий вход и настоящую базу
if (DEV && process.env.APTEKA_USER_DATA) app.setPath('userData', process.env.APTEKA_USER_DATA)

// Свой адрес app:// надо объявить до готовности программы — позже уже поздно
registerScheme(protocol)

// Строка меню «Файл / Правка / Вид» кассе не нужна; копирование и вставка в полях
// работают и без неё
Menu.setApplicationMenu(null)

// Под этим именем Windows знает программу: значок на панели задач, уведомления
app.setAppUserModelId('tj.finmax.pos')

let win = null
let log = { info() {}, warn() {}, error() {} }

const sameOrigin = (url, origin) => {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : ''
// Свои страницы — файлы программы, а при разработке ещё и сервер интерфейса
const isOurs = (url) => isAppUrl(url) || (!!DEV_ORIGIN && sameOrigin(url, DEV_ORIGIN))

// ── Вторую копию не запускаем ──
// Две копии работали бы с одним ключом входа и (дальше) с одной локальной базой,
// каждая со своим представлением о том, что отправлено на сервер. Поэтому повторный
// запуск просто поднимает уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(start).catch((e) => {
    log.error('запуск не удался', e)
    dialog.showErrorBox('FinMax POS', 'Программа не смогла запуститься.\n\n' + (e?.message || e))
    app.quit()
  })
}

app.on('window-all-closed', () => app.quit())

// Страница не должна ни открывать новые окна, ни встраивать чужие
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  // Уйти со своей страницы на чужой адрес окно не может: перезагрузка — да,
  // переход на сайт в интернете — нет
  contents.on('will-navigate', (event, url) => {
    if (!isOurs(url)) event.preventDefault()
  })
})

async function start() {
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })
  log = createLog({ file: join(userData, 'main.log'), fs })
  process.on('uncaughtException', (e) => log.error('необработанная ошибка', e))
  process.on('unhandledRejection', (e) => log.error('необработанный отказ', e))
  log.info(`запуск: версия ${app.getVersion()}, ${DEV ? 'из исходников' : 'собранная программа'}`)

  const built = readBuildConfig(join(ROOT, 'build-config.json'))
  const apiUrl = resolveApiUrl({ packaged: app.isPackaged, env: process.env, built })
  if (!apiUrl) log.error('адрес сервера не задан — запросы к серверу работать не будут')
  const settings = createSettings({ file: join(userData, 'settings.json'), fs })

  // ── Ключи входа ──
  const store = createSessionStore({
    file: join(userData, 'session.json'),
    fs,
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    },
  })
  store.load()

  // ── Локальные базы ──
  // Общая база программы: кто входил на этом компьютере, номер кассы, поправка часов.
  // Базы аптек лежат рядом, по одной на аптеку, и открываются при входе.
  const dataDir = join(userData, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  // ── Резервные копии ──
  // Раз в сутки — копия обеих баз в папку backups (и во вторую папку, если человек
  // её выбрал). Испорченный файл базы при открытии сам поднимается из копии.
  let clock = null
  // Часы программы поднимаются позже — им нужна общая база. А копия перед обновлением
  // и открытие самой общей базы случаются раньше. Часам компьютера в эту минуту верить
  // нельзя (севшая батарейка — и на них 2015 год), поэтому берём не раньше того
  // момента, который программа уже видела: он записан в общей базе, и прочитать его
  // можно, не открывая базу по-настоящему
  const earlySeen = peekSeen(join(dataDir, 'core.db'))
  const appNow = () => (clock ? clock.now() : Math.max(Date.now(), earlySeen))
  const backups = createBackups({ dir: join(userData, 'backups'), fs, Database, now: appNow, log, host: hostFolderOf(os.hostname()) })
  const opening = (name, schema) => (file) =>
    openOrRestore({ file, name, open: (f) => openDb(f, schema), backups, fs, extra: settings.get().backupDir, now: appNow, log })

  // ── Программу обновили ──
  // У новой версии может быть другое устройство баз, и она перестроит их при первом
  // же открытии. Прежде чем это случится, снимаем копию в том виде, в каком базы
  // оставила прежняя версия: если перестройка пойдёт не так, будет к чему вернуться.
  const previous = settings.get().version
  if (previous && previous !== app.getVersion()) {
    const files = fs.readdirSync(dataDir).filter((f) => /^(core|pharmacy-[A-Za-z0-9_-]+)\.db$/.test(f))
    try {
      if (files.length) await backups.run(files.map((name) => ({ name, file: join(dataDir, name) })), { extra: settings.get().backupDir })
      log.info(`программа обновлена: ${previous} → ${app.getVersion()}; копия баз прежней версии снята`)
    } catch (e) {
      log.error('копия баз перед первым запуском новой версии не снята', e)
    }
  }
  if (previous !== app.getVersion()) settings.set({ version: app.getVersion() })

  const coreOpened = opening('core.db', CORE_SCHEMA)(join(dataDir, 'core.db'))
  const core = coreOpened.db

  // ── Часы ──
  // Время чека берётся не с часов компьютера, а отсюда: сверено с сервером и не
  // зависит от перевода часов (см. local/clock.mjs)
  // Сдвиг часов — только для проверок (см. ниже). В обычной работе всегда ноль
  let clockShift = 0
  // Шифрование средствами Windows: им закрыты отпечатки паролей и запись о проверке подписки
  const sealer = {
    seal: (text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null),
    open: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
  }
  clock = createClock({
    mono: () => performance.now() + clockShift,
    load: () => {
      let saved = null
      try {
        saved = JSON.parse(getMeta(core, 'clock') || 'null')
      } catch {
        saved = null
      }
      // Последний увиденный момент записан ещё и в зашифрованной записи о проверке
      // подписки — и для часов, и для срока работы без связи. Строку часов можно
      // стереть, её — нет (см. local/licence.mjs)
      return { ...(saved || {}), seen: Math.max(Number(saved?.seen) || 0, lastFloor(core, sealer)), licSeen: lastSeen(core, sealer) }
    },
    save: (state) => setMeta(core, 'clock', JSON.stringify(state)),
  })
  const clockTimer = setInterval(() => clock.persist(), 30000)

  // ── Постоянное соединение с сервером ──
  // События сервера идут не в окно, а в обмен с сервером: «раздел изменился»
  // означает «забери его в локальную базу», и уже она сообщит окну.
  const realtime = createRealtime({
    io,
    origin: serverOrigin(apiUrl),
    session: store,
    send: (type, payload) => gateway.serverEvent(type, payload),
  })

  // ── Кто отвечает окну: локальная база или сервер ──
  // net.fetch идёт через сетевую часть Chromium: она знает про системный прокси
  // и сертификаты Windows. В аптеке, где интернет раздаётся через прокси, обычный
  // запрос Node просто не дошёл бы до сервера.
  const gateway = createGateway({
    apiUrl,
    fetchImpl: (url, init) => net.fetch(url, init),
    session: store,
    core,
    // Отпечаток пароля для входа без интернета шифруется средствами Windows, как
    // и ключи входа. Шифрования нет — не храним его вовсе: войти без связи будет нельзя
    cipher: sealer,
    clock,
    dataDir,
    appVersion: app.getVersion(),
    log,
    openFile: (file, name) => opening(name, PHARMACY_SCHEMA)(file),
    emit: (type, payload) => toWindow(type, type === 'status' ? fullStatus(payload) : payload),
    onSession: () => realtime.sessionChanged(),
  })
  log.info(`касса ${gateway.deviceId}`)

  const toWindow = (type, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('realtime:event', { type, payload })
  }

  // ── Копия баз ──
  // Что копируем: общую базу, базу открытой аптеки и базы остальных аптек этого
  // компьютера (их файлы сейчас не открыты)
  let backupRunning = null
  // skipped — базы, которые в последнюю копию не попали (файл испорчен или занят)
  let backupNote = { error: '', extraOk: null, skipped: [] }
  function backupNow() {
    if (backupRunning) return backupRunning
    const open = gateway.pharmacyFile()
    const sources = [{ name: 'core.db', db: core }]
    if (open) sources.push(open)
    for (const f of fs.readdirSync(dataDir)) {
      if (/^pharmacy-[A-Za-z0-9_-]+\.db$/.test(f) && f !== open?.name) sources.push({ name: f, file: join(dataDir, f) })
    }
    const extra = settings.get().backupDir
    backupRunning = backups
      .run(sources, { extra })
      .then((r) => {
        backupNote = { error: '', extraOk: r.extra ? r.extra.ok : null, skipped: r.skipped.map((s) => s.name) }
        setMeta(core, 'backupLicAt', String(clock.lic()))
        return true
      })
      .catch((e) => {
        log.error('копия баз не снята', e)
        backupNote = { error: String(e?.message || e), extraOk: null, skipped: [] }
        return false
      })
      .finally(() => {
        backupRunning = null
        pushStatus()
      })
    return backupRunning
  }
  // Проверяем раз в час, не пора ли: программа в аптеке открыта сутками
  // Пора ли: по времени программы — или по времени срока работы без связи. На компьютере
  // со сбитыми часами первое идёт, только пока программа работает, и «раз в сутки» по нему
  // выходило бы раз в два с половиной дня; второе идёт почти как настоящее
  const backupDue = () => backups.due() || clock.lic() - (Number(getMeta(core, 'backupLicAt')) || 0) >= 24 * 3600 * 1000
  const backupTimer = setInterval(() => backupDue() && backupNow(), 60 * 60 * 1000)
  // Первая проверка — через минуту после запуска: не мешаем входу
  const backupFirst = setTimeout(() => backupDue() && backupNow(), 60 * 1000)
  if (coreOpened.restored) log.error('общая база была повреждена — ' + (coreOpened.restored.at ? 'поднята из копии' : 'начата заново'))

  // ── Обновление программы ──
  // Откуда брать — зашито при сборке; при запуске из исходников можно задать
  // переменной окружения (так обновление проверяют)
  const feed = resolveUpdateFeed({ packaged: app.isPackaged, env: process.env, built })
  let autoUpdater = null
  if (feed) {
    try {
      autoUpdater = updaterPackage.autoUpdater
      // Где искать обновления, библиотека читает из файла — пишем его из зашитого
      // при сборке (см. feedYaml)
      const feedFile = join(userData, 'app-update.yml')
      fs.writeFileSync(feedFile, feedYaml(feed), 'utf8')
      autoUpdater.updateConfigPath = feedFile
      if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
    } catch (e) {
      log.warn('обновления недоступны: ' + (e?.message || e))
      autoUpdater = null
    }
  }
  const updater = createUpdater({ autoUpdater, feed, log, onState: () => pushStatus(), beforeInstall: () => backupNow() })
  log.info(feed ? `обновления: ${feed.provider === 'github' ? feed.owner + '/' + feed.repo : feed.url}` : 'обновления выключены: источник не задан при сборке')

  // ── Что показать человеку о состоянии программы ──
  // Связь и очередь — от обмена с сервером; к ним добавляется копия баз и обновление
  function fullStatus(base = gateway.status()) {
    const last = backups.last()
    return {
      ...base,
      version: app.getVersion(),
      update: updater.state(),
      // Часам компьютера сейчас верить нельзя — время в чеках может быть неверным, и
      // человеку надо об этом сказать. А если время идёт по ним, не сверенное с
      // сервером, — показать, какое оно (см. local/clock.mjs)
      clockDoubt: clock.doubtful(),
      clockUnsure: clock.unverified(),
      backup: {
        at: last ? new Date(last.at).toISOString() : null,
        extraDir: settings.get().backupDir,
        extraOk: backupNote.extraOk,
        error: backupNote.error,
        skipped: backupNote.skipped,
        running: !!backupRunning,
      },
    }
  }
  const pushStatus = () => toWindow('status', fullStatus())

  gateway.resume()
  realtime.start()
  updater.start()

  // Раз в минуту: не вышел ли срок работы без связи; заодно окно получает свежий отсчёт
  const tickTimer = setInterval(() => gateway.tick(), 60 * 1000)

  // ── Только для проверок ──
  // Проверке надо «прожить» неделю без связи за секунду. У собранной программы этой
  // лазейки нет: нужен и запуск из исходников, и явная просьба в окружении
  if (DEV && process.env.APTEKA_TEST_HOOKS === '1') {
    globalThis.__aptekaTest = {
      shiftClock(ms) {
        clockShift += Number(ms) || 0
        gateway.tick()
        return clock.now()
      },
    }
  }
  // Компьютер проснулся — за это время могло измениться что угодно, а связь
  // программа считала по состоянию до сна
  powerMonitor.on('resume', () => {
    gateway.tick()
    gateway.syncNow().catch(() => {})
  })

  // Перед выходом: запомнить время и закрыть базы — так на диске не остаётся
  // незавершённой записи
  app.on('before-quit', () => {
    // Закрыли программу — в следующий раз снова нужен пароль. Ключи сотрудников
    // остаются: по ним уходит то, что сделано без связи (см. session.mjs)
    store.deactivate()
    clearInterval(clockTimer)
    clearInterval(tickTimer)
    clearInterval(backupTimer)
    clearTimeout(backupFirst)
    updater.stop()
    clock.persist()
    realtime.stop()
    gateway.close()
    try {
      core.close()
    } catch {
      /* база уже закрыта */
    }
  })

  // ── Мост ──
  // Слушаем только своё окно и только его главную страницу. Запрос от чего угодно
  // ещё — от вложенной рамки, от страницы с чужого адреса — не выполняется.
  const trusted = (event) => {
    const frame = event.senderFrame
    return !!frame && !!win && event.sender === win.webContents && frame === event.sender.mainFrame && isOurs(frame.url)
  }
  const denied = { status: 403, date: null, data: { message: 'Запрос отклонён программой' } }

  ipcMain.handle('api:request', (event, req) => (trusted(event) ? gateway.request(req) : denied))
  ipcMain.handle('session:clear', (event) => {
    if (!trusted(event)) return false
    gateway.logout()
    return true
  })
  ipcMain.handle('realtime:start', (event) => {
    if (trusted(event)) gateway.listen(true)
    return true
  })
  ipcMain.handle('realtime:stop', (event) => {
    if (trusted(event)) gateway.listen(false)
    return true
  })
  ipcMain.handle('app:info', (event) => (trusted(event) ? { version: app.getVersion(), packaged: app.isPackaged } : null))
  // «Закрыть программу» с главного экрана: у кассы не всегда есть мышь с крестиком
  ipcMain.handle('app:quit', (event) => {
    if (!trusted(event)) return false
    app.quit()
    return true
  })

  // ── Состояние программы: связь, очередь, копия, обновление ──
  // Папка копий и печать — по правам из роли, а не по должности
  const allowed = (key) => gateway.activeCan(key)
  ipcMain.handle('sync:status', (event) => (trusted(event) ? fullStatus() : null))
  // «Обменяться сейчас» — и окно само зовёт это, когда система сообщает, что сеть вернулась
  ipcMain.handle('sync:now', async (event) => {
    if (!trusted(event)) return null
    await gateway.syncNow().catch(() => {})
    return fullStatus()
  })
  ipcMain.handle('sync:resync', async (event) => {
    if (!trusted(event)) return null
    await gateway.resync().catch(() => {})
    return fullStatus()
  })
  ipcMain.handle('sync:rejected', (event) => (trusted(event) ? gateway.rejected() : []))
  ipcMain.handle('sync:dismiss', (event, id) => (trusted(event) ? gateway.dismissRejected(id) : false))

  ipcMain.handle('backup:now', async (event) => {
    if (!trusted(event) || !gateway.activeRole()) return null
    await backupNow()
    return fullStatus()
  })
  // Вторая папка для копий. Путь окно передать не может: папку человек выбирает
  // в системном окне, которое открывает основная часть
  ipcMain.handle('backup:folder', async (event) => {
    if (!trusted(event) || !allowed('settings.backup')) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Вторая папка для копий базы',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths?.[0]) return fullStatus()
    settings.set({ backupDir: r.filePaths[0] })
    log.info('вторая папка для копий: ' + r.filePaths[0])
    await backupNow()
    return fullStatus()
  })
  ipcMain.handle('backup:folderClear', (event) => {
    if (!trusted(event) || !allowed('settings.backup')) return null
    settings.set({ backupDir: '' })
    backupNote = { ...backupNote, extraOk: null }
    return fullStatus()
  })
  ipcMain.handle('backup:open', async (event) => {
    if (!trusted(event) || !allowed('settings.backup')) return false
    fs.mkdirSync(backups.dir, { recursive: true })
    return (await shell.openPath(backups.dir)) === ''
  })

  // ── Печать на чековом принтере ──
  // Окно присылает готовые строки чека; здесь они превращаются в команды принтера
  // и уходят по сети или в очередь печати Windows. Принтер не настроен — отвечаем
  // «system», и окно печатает как на сайте, через окно печати.
  let printSeq = 0
  async function printTicket(ticket) {
    const cfg = settings.get().print
    if (cfg.mode === 'system') return { ok: true, mode: 'system' }
    try {
      const bytes = renderTicket(ticket, { ...cfg, logo: cfg.logo === false ? null : LOGO })
      if (cfg.mode === 'network') await sendNetwork({ net: nodeNet, host: cfg.host, port: cfg.port, bytes })
      else {
        await sendWindows({
          run: (script, env) => runPowerShell({ spawn, script, env }),
          fs,
          tmpFile: join(userData, `print-${process.pid}-${++printSeq}.bin`),
          printer: cfg.name,
          bytes,
        })
      }
      return { ok: true, mode: cfg.mode }
    } catch (e) {
      log.warn(`чек не напечатан (${cfg.mode}): ${e?.message || e}`)
      return { ok: false, mode: cfg.mode, error: String(e?.message || e) }
    }
  }
  // Принтеры, заведённые в Windows, — для выбора в настройках
  const printerNames = async () => {
    try {
      return (await win.webContents.getPrintersAsync()).map((p) => p.name).filter(Boolean)
    } catch {
      return []
    }
  }
  ipcMain.handle('print:config', async (event) => (trusted(event) && gateway.activeRole() ? { ...settings.get().print, printers: await printerNames() } : null))
  ipcMain.handle('print:setConfig', (event, cfg) => {
    if (!trusted(event) || !allowed('settings.print')) return null
    // Адрес не из сети аптеки не запоминаем вовсе — и прежнюю настройку не трогаем:
    // окно скажет человеку, что не так, а печать продолжит работать как работала
    if (cfg?.mode === 'network' && String(cfg.host ?? '').trim() && !checkHost(cfg.host)) return { refused: 'host' }
    return settings.set({ print: cfg }).print
  })
  ipcMain.handle('print:ticket', (event, ticket) => (trusted(event) && gateway.activeRole() ? printTicket(ticket) : { ok: false, mode: 'system' }))
  ipcMain.handle('print:test', (event) =>
    trusted(event) && allowed('settings.print')
      ? printTicket({
          head: ['FinMax POS', 'Пробная печать'],
          rows: [{ name: 'Проверка русских букв: АБВГД абвгд ЁЖЗ', sub: '1 шт × 1', value: '1 сомони' }],
          totals: [{ label: 'Итого', value: '1 сомони', big: true }],
          tail: ['Если этот текст читается — принтер настроен верно'],
        })
      : { ok: false, mode: 'system' },
  )

  // ── Свой экран печати ──
  // Окно печати Chromium не умеет предпросмотр, поэтому у программы экран свой:
  // окно показывает чек само, а сюда просит отправить его на принтер или в PDF.
  // Лента (raw) уходит строками ESC/POS на выбранный принтер; лист (page) печатает
  // страницу как она есть (печатным стилям виден только сам чек); pdf кладёт то же
  // самое в файл — отправить в мессенджер или подшить.
  ipcMain.handle('print:raw', async (event, req) => {
    if (!trusted(event) || !gateway.activeRole()) return { ok: false, error: 'Требуется вход в систему' }
    const printer = typeof req?.printer === 'string' ? req.printer.slice(0, 220) : ''
    if (!printer) return { ok: false, error: 'Не удалось отправить задание на принтер.' }
    const cfg = settings.get().print
    const width = [32, 42, 48].includes(Number(req?.width)) ? Number(req.width) : cfg.width
    try {
      const bytes = renderTicket(req?.ticket, { width, codepage: cfg.codepage, cut: cfg.cut, drawer: false, logo: cfg.logo === false ? null : LOGO })
      await sendWindows({
        run: (script, env) => runPowerShell({ spawn, script, env }),
        fs,
        tmpFile: join(userData, `print-${process.pid}-${++printSeq}.bin`),
        printer,
        bytes,
      })
      return { ok: true, mode: 'windows' }
    } catch (e) {
      log.warn(`чек не напечатан (лента, ${printer}): ${e?.message || e}`)
      return { ok: false, error: String(e?.message || e) }
    }
  })
  ipcMain.handle('print:page', async (event, req) => {
    if (!trusted(event) || !gateway.activeRole()) return { ok: false, error: 'Требуется вход в систему' }
    const deviceName = typeof req?.printer === 'string' ? req.printer.slice(0, 220) : ''
    return await new Promise((resolve) => {
      win.webContents.print({ silent: true, deviceName, printBackground: true }, (done, reason) => {
        if (!done) log.warn(`чек не напечатан (лист${deviceName ? ', ' + deviceName : ''}): ${reason || ''}`)
        resolve(done ? { ok: true } : { ok: false, error: 'Не удалось отправить задание на принтер.' })
      })
    })
  })
  ipcMain.handle('print:pdf', async (event) => {
    if (!trusted(event) || !gateway.activeRole()) return { ok: false, error: 'Требуется вход в систему' }
    try {
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      const stamp = new Date().toISOString().slice(0, 10)
      const r = await dialog.showSaveDialog(win, {
        title: 'Сохранить чек в PDF',
        defaultPath: join(app.getPath('documents'), `chek-${stamp}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      fs.writeFileSync(r.filePath, pdf)
      // Показать файл в Проводнике: человек сразу видит, куда лёг чек
      shell.showItemInFolder(r.filePath)
      return { ok: true, path: r.filePath }
    } catch (e) {
      log.warn('PDF не сохранён: ' + (e?.message || e))
      return { ok: false, error: 'Не получилось. Повторите.' }
    }
  })

  ipcMain.handle('update:check', async (event) => {
    if (!trusted(event)) return null
    await updater.check()
    return fullStatus()
  })
  ipcMain.handle('update:install', (event) => (trusted(event) && gateway.activeRole() ? updater.install() : false))

  // ── Окно живёт в своём отделении ──
  // У окна отдельное хранилище и отдельные сетевые правила. Запросы основной части
  // идут мимо них, поэтому окну можно закрыть сеть целиком, не мешая самой программе.
  const ses = session.fromPartition('persist:apteka')

  registerAppProtocol({ protocol: ses.protocol, readFile, root: RENDERER, fonts: FONTS })

  // Окну в интернет незачем: все запросы делает основная часть. Закрываем сеть
  // и здесь, а не только правилами страницы, — двумя замками, а не одним.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
    done({ cancel: !(DEV_ORIGIN && isDevServer(details.url)) })
  })

  // Из разрешений нужна только камера — ею читают штрихкод, когда нет сканера.
  // Микрофон, геолокация, уведомления и прочее программе не нужны и не выдаются.
  ses.setPermissionRequestHandler((contents, permission, done, details) => {
    const ok =
      permission === 'media' &&
      isOurs(details?.requestingUrl || contents?.getURL() || '') &&
      (details?.mediaTypes || []).every((t) => t === 'video')
    done(ok)
  })
  ses.setPermissionCheckHandler((_contents, permission, origin) => permission === 'media' && isOurs(origin || ''))

  if (!DEV_URL && !fs.existsSync(join(RENDERER, 'index.html'))) {
    throw new Error('Интерфейс программы не собран. Выполните «npm run electron:build» в папке desktop.')
  }

  createWindow(ses, userData)
}

// Сервер разработки интерфейса: сама страница и её горячая подмена кода
// Последний момент, который программа уже видела, — из общей базы, не открывая её
// по-настоящему: без перестройки под новую версию и без записи. Не вышло — ноль
function peekSeen(file) {
  let db = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = 'clock'").get()
    const seen = Number(JSON.parse(row?.value || 'null')?.seen)
    return Number.isFinite(seen) && seen > 0 ? seen : 0
  } catch {
    return 0
  } finally {
    try {
      db?.close()
    } catch {
      /* не открылась — закрывать нечего */
    }
  }
}

function isDevServer(url) {
  try {
    const u = new URL(url)
    const d = new URL(DEV_URL)
    return u.hostname === d.hostname && u.port === d.port
  } catch {
    return false
  }
}

function createWindow(ses, userData) {
  const state = createWindowState({ file: join(userData, 'window.json'), fs })
  const saved = state.load()

  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false, // показываем готовым: пустой белый прямоугольник при запуске ни к чему
    backgroundColor: '#f3f5fa',
    title: 'FinMax POS',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      session: ses,
      preload: join(ROOT, 'src', 'preload.cjs'),
      // Три замка окна: своя среда исполнения, песочница, никакого Node на странице
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Инструменты разработчика — только при запуске из исходников
      devTools: DEV,
    },
  })

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => {
    const maximized = win.isMaximized()
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    state.save({ width: bounds.width, height: bounds.height, maximized })
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('окно аварийно закрылось', details?.reason || '')
    // Касса не должна оставаться с мёртвым окном: открываем заново
    if (win && !win.isDestroyed() && details?.reason !== 'clean-exit') win.reload()
  })

  if (DEV) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }

  win.loadURL(DEV_URL || START_URL).catch((e) => log.error('страница не открылась', e))
}
