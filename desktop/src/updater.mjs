// ── Обновление программы ──
//
// Программа сама проверяет, не вышла ли новая версия, сама её скачивает и ставит
// при закрытии. Кассиру ничего делать не нужно; владельцу сервиса не нужно ездить
// по аптекам с флешкой.
//
// Три правила.
//   1. Посреди работы программа не перезапускается никогда. Скачанное обновление
//      ждёт: оно встанет, когда программу закроют, — или когда человек сам нажмёт
//      «Перезапустить и обновить».
//   2. Откуда брать обновления, зашито при сборке (как и адрес сервера). На компьютере
//      аптеки это не меняется: иначе программу можно было бы одной строкой заставить
//      скачать и поставить чужой установщик.
//   3. Нет интернета, сервер обновлений недоступен — это не ошибка, а обычный день.
//      Проверка просто повторится позже.
//
// Сам механизм (скачать, сверить контрольную сумму, поставить) — библиотека
// electron-updater. Здесь — когда проверять и что показывать человеку. Библиотека
// передаётся снаружи, поэтому модуль проверяется обычными тестами.

// Первая проверка — через полминуты после запуска: не мешаем входу и первой загрузке
const FIRST_CHECK_MS = 30 * 1000
// Дальше — раз в четыре часа: программа в аптеке открыта сутками
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

// ── Откуда брать обновления ──
// Открытый репозиторий GitHub с установщиками: { provider: 'github', owner, repo }.
// Или просто адрес папки с файлами: { provider: 'generic', url } — так проверяют.
// Пусто или не того вида — обновления выключены.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/

export function normalizeFeed(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.provider === 'github') {
    if (!NAME.test(String(raw.owner || '')) || !NAME.test(String(raw.repo || ''))) return null
    return { provider: 'github', owner: raw.owner, repo: raw.repo }
  }
  if (raw.provider === 'generic') {
    let u
    try {
      u = new URL(String(raw.url || ''))
    } catch {
      return null
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    // Только защищённое соединение: по нему приходит программа, которая получит
    // доступ ко всему. Исключение — этот же компьютер, так обновление проверяют
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
    if (u.username || u.password) return null
    return { provider: 'generic', url: u.toString().replace(/\/+$/, '') }
  }
  return null
}

// «владелец/репозиторий» из переменной окружения → описание источника
export function feedFromRepo(text) {
  const m = String(text || '').trim().match(/^([^/\s]+)\/([^/\s]+)$/)
  return m ? normalizeFeed({ provider: 'github', owner: m[1], repo: m[2] }) : null
}

// ── Описание источника в том виде, в каком его читает библиотека обновлений ──
// Она берёт его из файла. Упаковщик кладёт такой файл только в установщик, а в
// распакованную папку — нет; поэтому программа пишет его сама, из зашитого при
// сборке, и ведёт себя одинаково, как бы её ни собрали.
// updaterCacheDirName — папка, куда складывается скачанное обновление
export const UPDATER_CACHE_DIR = 'apteka-desktop-updater'

export function feedYaml(feed) {
  const lines =
    feed.provider === 'github'
      ? ['provider: github', `owner: ${feed.owner}`, `repo: ${feed.repo}`]
      : ['provider: generic', `url: ${JSON.stringify(feed.url)}`]
  return [...lines, `updaterCacheDirName: ${UPDATER_CACHE_DIR}`, ''].join('\n')
}

export function createUpdater({
  autoUpdater,
  feed,
  log = { info() {}, warn() {}, error() {} },
  // Состояние изменилось — показать человеку
  onState = () => {},
  // Перед установкой: снять копию баз (новая версия может менять их устройство)
  beforeInstall = async () => {},
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
}) {
  // state: off — обновления выключены; idle — новой версии нет (или ещё не проверяли);
  // checking — проверяем; downloading — качаем; ready — скачано, встанет при закрытии
  let state = { state: feed && autoUpdater ? 'idle' : 'off', version: '', percent: 0, checkedAt: null }
  let timer = null
  let started = false
  let installing = false

  const set = (next) => {
    const merged = { ...state, ...next }
    if (merged.state === state.state && merged.version === state.version && merged.percent === state.percent && merged.checkedAt === state.checkedAt) return
    state = merged
    onState(state)
  }

  if (state.state === 'off') {
    return { state: () => state, check: async () => false, install: async () => false, start() {}, stop() {} }
  }

  autoUpdater.autoDownload = true
  // Скачанное встаёт само, когда программу закрывают, — без вопросов и без окон установщика
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = { info: (...a) => log.info('обновление:', ...a), warn: (...a) => log.warn('обновление:', ...a), error: (...a) => log.warn('обновление:', ...a), debug() {} }

  autoUpdater.on('checking-for-update', () => {
    if (state.state !== 'ready') set({ state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: String(info?.version || ''), percent: 0 }))
  autoUpdater.on('update-not-available', () => {
    if (state.state !== 'ready') set({ state: 'idle', percent: 0 })
  })
  autoUpdater.on('download-progress', (p) => {
    if (state.state === 'downloading') set({ percent: Math.max(0, Math.min(99, Math.round(Number(p?.percent) || 0))) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`обновление ${info?.version || ''} скачано — встанет при закрытии программы`)
    set({ state: 'ready', version: String(info?.version || state.version), percent: 100 })
  })
  // Нет интернета, сервер обновлений недоступен, оборвалась закачка — не беда:
  // проверка повторится. Уже скачанное обновление от этого никуда не девается
  autoUpdater.on('error', (e) => {
    log.warn('обновление: ' + (e?.message || e))
    if (state.state !== 'ready') set({ state: 'idle', percent: 0 })
  })

  async function check() {
    if (installing || state.state === 'checking' || state.state === 'downloading') return false
    try {
      await autoUpdater.checkForUpdates()
      set({ checkedAt: Date.now() })
      return true
    } catch (e) {
      log.warn('обновление: проверка не удалась: ' + (e?.message || e))
      if (state.state !== 'ready') set({ state: 'idle', percent: 0 })
      return false
    }
  }

  function plan(ms) {
    if (timer) timers.clear(timer)
    timer = null
    if (!started) return
    timer = timers.set(async () => {
      timer = null
      await check()
      plan(CHECK_EVERY_MS)
    }, ms)
  }

  return {
    state: () => state,
    check,

    // Человек нажал «Перезапустить и обновить». Ставится только то, что уже скачано
    async install() {
      if (state.state !== 'ready' || installing) return false
      installing = true
      try {
        await beforeInstall()
      } catch (e) {
        // Копию снять не удалось — обновление не отменяем: оно само по себе данные
        // не трогает, а копия — страховка, а не условие
        log.warn('копия перед обновлением не снята: ' + (e?.message || e))
      }
      // Тихо (без окон установщика) и с запуском программы после установки
      autoUpdater.quitAndInstall(true, true)
      return true
    },

    start() {
      started = true
      plan(FIRST_CHECK_MS)
    },
    stop() {
      started = false
      if (timer) timers.clear(timer)
      timer = null
    },
  }
}
