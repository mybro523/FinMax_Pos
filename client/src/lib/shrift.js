// ── Размер шрифта (1.7.7) ──
// «Настройки → Шрифт»: размер всей системы (текст, кнопки, таблицы — как Ctrl и «плюс») и
// отдельно надписей на плитках главного меню. Помнится на этом компьютере (у каждого
// моноблока свой экран), работает и без интернета. Система — масштабом страницы (zoom у
// <html>: раскладка подстраивается, прокрутки вбок нет), меню — множителем к размеру
// надписей, который считает lib/hubFont.js.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { useSyncExternalStore } from 'react'

export const SISTEMA = { min: 80, max: 150, step: 10, key: 'finmax_shrift_sistema' }
export const MENU = { min: 70, max: 160, step: 10, key: 'finmax_shrift_menu' }

// Процент из хранилища или поля: в пределах и с шагом; мусор — 100
export function procent(v, lim) {
  const n = Math.round(Number(v) / lim.step) * lim.step
  return Number.isFinite(n) && n > 0 ? Math.min(lim.max, Math.max(lim.min, n)) : 100
}

function read(lim) {
  try {
    const raw = localStorage.getItem(lim.key)
    return raw === null ? 100 : procent(raw, lim)
  } catch {
    return 100
  }
}

let state = { sistema: read(SISTEMA), menu: read(MENU) }
const subs = new Set()

// Масштаб страницы: 100 % — как было (без zoom)
export function primenit() {
  if (typeof document === 'undefined') return
  document.documentElement.style.zoom = state.sistema === 100 ? '' : String(state.sistema / 100)
}

export const shrift = () => state
export function setShrift(patch) {
  const next = {
    sistema: patch.sistema === undefined ? state.sistema : procent(patch.sistema, SISTEMA),
    menu: patch.menu === undefined ? state.menu : procent(patch.menu, MENU),
  }
  if (next.sistema === state.sistema && next.menu === state.menu) return
  state = next
  try {
    localStorage.setItem(SISTEMA.key, String(state.sistema))
    localStorage.setItem(MENU.key, String(state.menu))
  } catch {
    /* не запомнилось — до перезагрузки всё равно действует */
  }
  primenit()
  subs.forEach((f) => f())
}
export function useShrift() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state,
    () => state,
  )
}

// С первого кадра — до того, как нарисуется страница
primenit()
