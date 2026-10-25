// ── Окно экрана покупателя ──
//
// Второй экран моноблока (сторона покупателя). Окно открывается само, если у компьютера
// есть второй экран (в Windows режим экранов — «Расширить»), и закрывается, когда экран
// пропал. Окно кассы присылает корзину и итог готовыми строками ('customer:update'); окно
// покупателя ничего не умеет, кроме показа: моста к базе и серверу у него нет, фокус оно
// не забирает, на экран кассы не встаёт никогда (правила — customer-screen.mjs).
//
// Электрон передаётся снаружи (BrowserWindow, screen, ipcMain) — модуль проверяется
// обычными тестами на заглушках.
import { pickDisplay, sanitizeCustomer, sanitizeScreenState } from './customer-screen.mjs'

export const CUSTOMER_TITLE = 'FinMax POS — экран покупателя'
// Сколько держится проба из «Настроек»
export const TEST_MS = 6000
// Окно кассы переносят — переставляем покупателя, когда перенос закончился
export const MOVE_MS = 300
// Через столько сверяем, встало ли окно покупателя на экран целиком
export const SETTLE_MS = 500

// Совпадают ли границы окна и экрана. Windows при масштабе 125% округляет размер окна на
// точку-две — это то же самое
const near = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2

export function createCustomerScreen({ BrowserWindow, screen, ipcMain, ses, settings, mainWindow, trusted, allowed, activeRole, preload, url, isOurs, dev = false, log, timers = { set: setTimeout, clear: clearTimeout } }) {
  let win = null
  let state = sanitizeScreenState(null)
  let testTimer = null
  let moveTimer = null
  // Экран кассы, каким его видели последний раз. Свёрнутое окно Windows держит за краем
  // экрана — по нему экран кассы не узнать, а покупатель не должен уйти на её место
  let lastMain = null

  const alive = () => !!win && !win.isDestroyed()
  const mainId = () => {
    const m = mainWindow()
    try {
      if (m && !m.isDestroyed() && !m.isMinimized?.()) lastMain = screen.getDisplayMatching(m.getBounds()).id
      return lastMain ?? screen.getPrimaryDisplay().id
    } catch {
      return lastMain
    }
  }
  const displays = () => {
    try {
      return screen.getAllDisplays()
    } catch {
      return []
    }
  }
  const send = (s) => {
    if (alive()) win.webContents.send('customer:state', s)
  }

  function close() {
    if (alive()) win.destroy()
    win = null
  }

  // Окно, переехавшее на экран с другим масштабом Windows, Электрон иногда оставляет не
  // того размера — оно не закрыло бы экран покупателя целиком или вылезло бы на экран
  // кассы. Сверяем один раз чуть позже и, если нужно, ставим заново
  function settle() {
    timers.set(() => {
      if (!alive()) return
      const target = pickDisplay(settings.get().customer, displays(), mainId())
      if (target && !near(win.getBounds(), target.bounds)) win.setBounds(target.bounds)
    }, SETTLE_MS)
  }

  // ── Открыть, переставить или закрыть — по настройке и по тому, какие экраны есть ──
  function place() {
    // Окна кассы нет (программа закрывается) — нет и окна покупателя
    const m = mainWindow()
    if (!m || m.isDestroyed()) {
      close()
      return null
    }
    const target = pickDisplay(settings.get().customer, displays(), mainId())
    if (!target) {
      close()
      return null
    }
    const b = target.bounds
    if (alive()) {
      // Экран сменили (переподключили, поменяли разрешение) — окно встаёт на новый целиком
      if (!near(win.getBounds(), b)) {
        win.setBounds(b)
        settle()
      }
      return target
    }
    win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // Покупатель не должен забрать фокус у кассира: окно не принимает ни мышь в фокус, ни клавиатуру
      focusable: false,
      skipTaskbar: true,
      // Поверх панели задач Windows на втором экране — экран покупателя занят целиком
      alwaysOnTop: true,
      backgroundColor: '#0a1a45',
      title: CUSTOMER_TITLE,
      webPreferences: {
        session: ses,
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: dev,
      },
    })
    const own = win
    own.setAlwaysOnTop(true, 'screen-saver')
    own.once('ready-to-show', () => {
      if (own.isDestroyed()) return
      own.showInactive()
      settle()
    })
    own.on('closed', () => {
      if (win === own) win = null
    })
    // Окно покупателя никуда не уходит со своей страницы и ничего не открывает
    own.webContents.on('will-navigate', (e) => e.preventDefault())
    own.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    own.webContents.on('render-process-gone', (_e, d) => {
      log?.warn?.('экран покупателя закрылся', d?.reason || '')
      if (!own.isDestroyed() && d?.reason !== 'clean-exit') own.reload()
    })
    own.loadURL(url).catch((e) => log?.warn?.('экран покупателя не открылся', e))
    return target
  }

  // Что видно в «Настройках»: экраны Windows, какой у кассы, где сейчас покупатель
  function config() {
    const cfg = sanitizeCustomer(settings.get().customer)
    const main = mainId()
    const list = displays()
    const target = pickDisplay(cfg, list, main)
    return {
      mode: cfg.mode,
      display: cfg.display,
      displays: list.map((d, n) => ({ id: String(d.id), n: n + 1, width: d.size?.width || d.bounds?.width || 0, height: d.size?.height || d.bounds?.height || 0, main: String(d.id) === String(main) })),
      showing: target && alive() ? String(target.id) : '',
    }
  }

  // Своё ли окно: только страница экрана покупателя
  const fromScreen = (event) => alive() && event.sender === win.webContents && isOurs(event.senderFrame?.url || '')

  ipcMain.handle('customer:ready', (event) => (fromScreen(event) ? state : null))
  ipcMain.handle('customer:update', (event, raw) => {
    if (!trusted(event)) return false
    state = sanitizeScreenState(raw)
    // Идёт проба из «Настроек» — она досмотрится, а потом покажется уже это
    if (!testTimer) send(state)
    return true
  })
  ipcMain.handle('customer:config', (event) => (trusted(event) && activeRole() ? config() : null))
  ipcMain.handle('customer:setConfig', (event, cfg) => {
    if (!trusted(event) || !allowed('settings.print')) return null
    settings.set({ customer: sanitizeCustomer(cfg) })
    place()
    return config()
  })
  ipcMain.handle('customer:test', (event, sample) => {
    if (!trusted(event) || !allowed('settings.print') || !alive()) return { ok: false }
    send(sanitizeScreenState({ ...(sample && typeof sample === 'object' ? sample : {}), mode: 'test' }))
    if (testTimer) timers.clear(testTimer)
    testTimer = timers.set(() => {
      testTimer = null
      send(state)
    }, TEST_MS)
    return { ok: true }
  })

  const replace = () => {
    try {
      place()
    } catch (e) {
      log?.warn?.('экран покупателя не переставился', e)
    }
  }
  // Экраны подключили, отключили, поменяли разрешение — окно встаёт куда надо
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, replace)

  // Кассу перенесли на другой экран (Win+Shift+стрелка) — покупатель переходит на
  // свободный. Иначе его окно, которое всегда поверх, закрыло бы кассу целиком
  function mainMoved() {
    if (moveTimer) timers.clear(moveTimer)
    moveTimer = timers.set(() => {
      moveTimer = null
      replace()
    }, MOVE_MS)
  }

  return { place, close, config, mainMoved, window: () => (alive() ? win : null), state: () => state }
}
