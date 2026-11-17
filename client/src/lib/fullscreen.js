// ── «Во весь экран» на сайте (17.11.2026) ──
// Программа для Windows всегда открыта на весь экран. Сайт — в окне браузера, и вкладки с
// адресной строкой забирают у него высоту. Кнопка в шапке главного меню убирает их: сайт
// выглядит ровно как программа. Выход — та же кнопка («Обычный экран») или Esc.
//
// Браузер, который уже на весь экран сам (F11), не даёт выйти из этого из страницы: кнопку
// тогда не показываем — человек и так видит сайт на весь экран и знает про F11. Браузер
// без такой возможности (iPhone) — кнопки нет.
import { useSyncExternalStore } from 'react'

const doc = () => (typeof document === 'undefined' ? null : document)

export function canFullscreen() {
  const d = doc()
  return !!d && !!(d.fullscreenEnabled || d.webkitFullscreenEnabled)
}

const fsElement = () => {
  const d = doc()
  return d ? d.fullscreenElement || d.webkitFullscreenElement || null : null
}

// Браузер на весь экран сам (F11): окно во весь экран, а страница его не просила
function browserFull() {
  if (typeof window === 'undefined' || !window.screen) return false
  return window.innerWidth >= window.screen.width - 2 && window.innerHeight >= window.screen.height - 2
}

// 'page' — на весь экран по кнопке, 'browser' — по F11, '' — обычное окно
export function fullscreenState() {
  if (fsElement()) return 'page'
  return browserFull() ? 'browser' : ''
}

function subscribe(cb) {
  const d = doc()
  if (!d) return () => {}
  d.addEventListener('fullscreenchange', cb)
  d.addEventListener('webkitfullscreenchange', cb)
  window.addEventListener('resize', cb)
  return () => {
    d.removeEventListener('fullscreenchange', cb)
    d.removeEventListener('webkitfullscreenchange', cb)
    window.removeEventListener('resize', cb)
  }
}

export function useFullscreen() {
  return useSyncExternalStore(subscribe, fullscreenState, () => '')
}

// Нажатие кнопки: войти или выйти. Браузер может отказать (настройки, рамка) — тогда
// просто ничего не меняется, F11 остаётся
export function toggleFullscreen() {
  const d = doc()
  if (!d) return
  try {
    if (fsElement()) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen
      const p = exit?.call(d)
      p?.catch?.(() => {})
      return
    }
    const el = d.documentElement
    const go = el.requestFullscreen || el.webkitRequestFullscreen
    const p = go?.call(el, { navigationUI: 'hide' })
    p?.catch?.(() => {})
  } catch {
    /* браузер не дал — остаётся F11 */
  }
}
