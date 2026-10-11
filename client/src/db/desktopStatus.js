// ── Состояние программы для Windows ──
//
// Есть ли связь с сервером, сколько чеков ждёт отправки, когда снята копия базы,
// готово ли обновление. Всё это знает основная часть программы; сюда оно приходит
// событием «status» и по просьбе. На сайте ничего этого нет — там и хранилище пустое.
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { useSyncExternalStore } from 'react'
import { bridge } from '../lib/desktop.js'

let status = null
const listeners = new Set()

export function setDesktopStatus(next) {
  status = next && typeof next === 'object' ? next : null
  listeners.forEach((l) => l())
}

export function useDesktopStatus() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => status,
    () => null,
  )
}

// Спросить состояние сейчас (при входе и при открытии окна «Состояние программы»)
export async function refreshDesktopStatus() {
  if (!bridge?.sync) return null
  try {
    setDesktopStatus(await bridge.sync.status())
  } catch {
    /* основная часть не ответила — оставляем прежнее */
  }
  return status
}

// Действие над программой (обменяться, снять копию, проверить обновление): основная
// часть отвечает новым состоянием — сразу его и показываем
export async function desktopAction(fn) {
  try {
    const next = await fn()
    if (next && typeof next === 'object' && 'online' in next) setDesktopStatus(next)
    return next
  } catch {
    return null
  }
}
