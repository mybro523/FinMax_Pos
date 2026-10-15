// ── Тема оформления (светлая / тёмная) ──
//
// Настроек тут две, не одна: у панели владельца сервиса своя, у магазина своя.
// Раньше ключ был общий, и владелец, открыв панель в том же браузере, где до
// этого смотрел магазин, получал его тему — а сменить её из панели было нечем.
// Теперь у каждой стороны своя память на этом устройстве.
//
// Когда владелец входит В магазин («войти как магазин»), действует его
// настройка: он смотрит на программу глазами клиента, и подменять ему вид
// было бы враньём о том, что клиент видит.
import { useSyncExternalStore } from 'react'

const KEYS = { apteka: 'apteka_theme', admin: 'apteka_admin_theme' }

function read(sc) {
  try {
    const v = localStorage.getItem(KEYS[sc])
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null // приватный режим
  }
}

let scope = 'apteka'
let theme = read(scope) || 'light'

function applyTheme(t) {
  try {
    document.documentElement.setAttribute('data-theme', t)
  } catch {
    /* ssr/no-dom */
  }
}
applyTheme(theme) // применяем сразу при загрузке модуля

const listeners = new Set()
const emit = () => listeners.forEach((l) => l())

// Переключить сторону. Вызывается один раз при входе, когда уже известна роль
export function setThemeScope(sc) {
  const next = sc === 'admin' ? 'admin' : 'apteka'
  if (next === scope) return
  scope = next
  theme = read(scope) || 'light'
  applyTheme(theme)
  emit()
}

export function getTheme() {
  return theme
}
export function setTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light'
  try {
    localStorage.setItem(KEYS[scope], theme)
  } catch {
    /* ignore */
  }
  applyTheme(theme)
  emit()
}
export function toggleTheme() {
  setTheme(theme === 'dark' ? 'light' : 'dark')
}
export function useTheme() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => theme,
    () => 'light',
  )
}
