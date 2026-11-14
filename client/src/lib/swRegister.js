// ── Подключить service worker сайта (14.11.2026) ──
// Только собранный сайт (в разработке файлы отдаются по одному и кэшировать нечего), не
// программа для Windows (её файлы и так на компьютере) и только там, где браузер его
// разрешает: https или сам компьютер (localhost / 127.0.0.1 — для проверок).
// Что он делает — lib/sw-worker.js.
import { isDesktop } from './desktop.js'

const UPDATE_MS = 30 * 60 * 1000

export function swAllowed({ prod, mode, desktop, hasSW, protocol, hostname }) {
  if (!prod || mode === 'desktop' || desktop || !hasSW) return false
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1'
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  const ok = swAllowed({
    prod: !!import.meta.env?.PROD,
    mode: import.meta.env?.MODE,
    desktop: isDesktop,
    hasSW: 'serviceWorker' in navigator,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
  })
  if (!ok) return
  const go = () => {
    // updateViaCache 'none': новый sw.js браузер берёт мимо своего кэша — выкладка доходит сразу
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        // Касса открыта сутками: раз в полчаса спросить, нет ли новой версии
        setInterval(() => reg.update().catch(() => {}), UPDATE_MS)
      })
      .catch(() => {
        // Не вышло (браузер запретил, приватный режим) — сайт работает как раньше, только с интернетом
      })
  }
  // После загрузки страницы: установка качает файлы и не должна мешать первому экрану
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
}
