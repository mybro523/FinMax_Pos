// ── Облегчённый вид (программа для Windows) ──
//
// На слабом компьютере программа убирает тени, анимации и плавные переходы — на старой
// видеокарте тормозят именно они (класс lite на <html>, правила — в конце index.css;
// графики в этом виде тоже рисуются без анимации). Включён ли вид при запуске, основная
// часть программы сообщает окну сразу (bridge.lite.atStart) — поэтому он действует с
// первого кадра. Решает основная часть (desktop/src/lite.mjs); на сайте вида нет.
import { useSyncExternalStore } from 'react'
import { bridge } from './desktop.js'

let on = !!bridge?.lite?.atStart
const listeners = new Set()

function paint() {
  try {
    document.documentElement.classList.toggle('lite', on)
  } catch {
    /* без страницы — нечего красить */
  }
}
paint()

// Поменять вид сразу, не дожидаясь перезапуска (после выбора в «Настройках»)
export function applyLite(next) {
  const v = !!next
  if (v === on) return
  on = v
  paint()
  listeners.forEach((l) => l())
}

export const liteOn = () => on

// Основная часть узнала о видеокарте позже запуска (или окно перезагрузилось) — вид на ходу
try {
  bridge?.lite?.onChange?.((state) => applyLite(!!state?.active))
} catch {
  /* старый мост без подписки — вид остаётся тем, что был при запуске */
}

// Для графиков: в облегчённом виде они рисуются без анимации
export function useLite() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => on,
    () => false,
  )
}
