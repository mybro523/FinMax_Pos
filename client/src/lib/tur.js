// ── Туры по программе: состояние ──
//
// Здесь только «какой тур идёт и на каком он шаге» — несколько строк, и лежат они
// в главной сборке намеренно. Сам тур с текстами всех разделов на двух языках
// весит десятки килобайт и грузится отдельно, только когда тур запущен: иначе
// каждая аптека качала бы его при каждом входе ради того, что смотрят раз в месяц.
import { useSyncExternalStore } from 'react'

// Общий тур по программе. Туры разделов называются адресом раздела: '/pos', '/products'…
export const OBSHIY = 'obshiy'

let state = { id: null, index: 0 }
const listeners = new Set()
const emit = () => listeners.forEach((l) => l())

export function startTour(id, index = 0) {
  state = { id, index }
  emit()
}

export function stopTour() {
  state = { id: null, index: 0 }
  emit()
}

export function setTourIndex(index) {
  if (!state.id) return
  state = { ...state, index }
  emit()
}

export function useTourState() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
    () => state,
  )
}

// ── Какие туры человек уже прошёл до конца ──
// Хранится на устройстве, как тема и язык. Кэш нужен не для скорости: подписка
// React требует возвращать тот же самый массив, пока ничего не менялось, иначе
// страница перерисовывалась бы бесконечно.
const DONE = 'apteka_tury_proydeny'
const doneListeners = new Set()
let doneCache = null

function readDone() {
  if (doneCache) return doneCache
  try {
    const v = JSON.parse(localStorage.getItem(DONE) || '[]')
    doneCache = Array.isArray(v) ? v : []
  } catch {
    doneCache = []
  }
  return doneCache
}

export function markTourDone(id) {
  const d = readDone()
  if (d.includes(id)) return
  doneCache = [...d, id]
  try {
    localStorage.setItem(DONE, JSON.stringify(doneCache))
  } catch {
    /* приватный режим: отметка проживёт до перезагрузки */
  }
  doneListeners.forEach((l) => l())
}

export function useToursDone() {
  return useSyncExternalStore(
    (cb) => {
      doneListeners.add(cb)
      return () => doneListeners.delete(cb)
    },
    readDone,
    () => [],
  )
}

// ── Первый вход ──
// Раньше это было окно «Добро пожаловать», теперь сразу общий тур. Ключ оставлен
// прежним: у аптек, которые приветствие уже закрыли, тур сам не выскочит, и
// настройки автоматических проверок продолжают работать без переделки.
const SEEN = 'apteka_obuchenie_videl'

export function obucheniePokazano() {
  try {
    return localStorage.getItem(SEEN) === '1'
  } catch {
    // Приватный режим: лучше не показать ни разу, чем показывать при каждом входе
    return true
  }
}

export function zapomnitObuchenie() {
  try {
    localStorage.setItem(SEEN, '1')
  } catch {
    /* приватный режим */
  }
}

// ── Меню на телефоне ──
// На узком экране меню спрятано за кнопкой ☰, а шаги общего тура показывают
// именно его. Состоянием меню владеет Layout — тур просит его открыться событием,
// а не лезет в чужое состояние напрямую.
export function setTourMenu(open) {
  try {
    window.dispatchEvent(new CustomEvent('tur:menu', { detail: !!open }))
  } catch {
    /* нет окна — нечего открывать */
  }
}

// ── Чек или каталог на кассе ──
// На узком экране касса показывает что-то одно. Шаг тура про каталог просит кассу
// открыть каталог, шаг про корзину — чек. Тем же способом, что и меню: событием,
// а переключает сама касса.
export function setTourPane(pane) {
  try {
    window.dispatchEvent(new CustomEvent('tur:pane', { detail: pane }))
  } catch {
    /* нет окна — нечего переключать */
  }
}

// ── На каком устройстве идёт тур ──
// Шаг про клавиши бессмыслен на телефоне, а шаг про переключатель «Чек | Каталог» —
// на большом экране, где видно и то и другое. Такие шаги помечены в уроке словом
// kogda, и тур их пропускает там, где показывать нечего.
export function sredaTura() {
  try {
    return {
      uzko: window.matchMedia('(max-width: 1279px)').matches,
      klava: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    }
  } catch {
    return null // среда неизвестна — показываем все шаги
  }
}
