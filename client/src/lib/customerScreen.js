// ── Экран покупателя (программа для Windows) ──
//
// Второй экран моноблока — сторона покупателя: товары в корзине и итог, после оплаты —
// «Спасибо за покупку!» и сдача. Касса шлёт сюда готовые строки (с переводом и деньгами —
// как на чеке), программа показывает их на втором экране (desktop/src/customer-window.mjs).
// На сайте (1.7.5) — окно покупателя, которое касса открывает на втором экране из «Настройки →
// Кассы и устройства» (public/pokupatel): вкладки одного сайта говорят через BroadcastChannel.
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { bridge } from './desktop.js'
import { tabloOut } from './tabloPort.js'

// ── Сайт: окно покупателя ──
const CHANNEL = 'finmax-pokupatel'
let channel = null
let current = null // что показывать сейчас (окно покупателя открылось позже — получит это)
let logoNow = '' // логотип магазина (data URL) — программа добавляет его сама, сайт — здесь
let aliveAt = 0
const aliveSubs = new Set()
const withLogo = (s) => (s && logoNow && s.logo === undefined ? { ...s, logo: logoNow } : s)
function web() {
  // Только в браузере: у проверок (Node) BroadcastChannel тоже есть, но окна покупателя нет
  if (bridge || typeof window === 'undefined' || typeof BroadcastChannel !== 'function') return null
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (e) => {
      const m = e?.data
      if (m?.type === 'ready' && current) channel.postMessage({ type: 'state', state: withLogo(current) })
      if (m?.type === 'ready' || m?.type === 'alive') aliveAt = Date.now()
      if (m?.type === 'closed') aliveAt = 0
      if (m?.type) aliveSubs.forEach((f) => f())
    }
  }
  return channel
}
web()
// Открыто ли окно покупателя (оно отзывается раз в 2 секунды)
export const pokupatelOtkryt = () => Date.now() - aliveAt < 5000
export function onPokupatel(cb) {
  aliveSubs.add(cb)
  return () => aliveSubs.delete(cb)
}
// Что показано сейчас (настройки открывают окно и без кассы — с приветствием)
export const customerNow = () => current
export function setCustomerLogo(v) {
  const next = typeof v === 'string' && /^data:image\/(?:png|jpeg);base64,/.test(v) ? v : ''
  if (next === logoNow) return
  logoNow = next
  const ch = web()
  if (ch && current) ch.postMessage({ type: 'state', state: { ...current, logo: logoNow } })
}

// Подписи экрана покупателя — на языке программы
export const customerLabels = (t) => ({
  welcome: t('Добро пожаловать'),
  total: t('Итого'),
  discount: t('Скидка'),
  thanks: t('Спасибо за покупку!'),
  change: t('Сдача'),
  test: t('Проверка экрана покупателя'),
})

// То же самое второй раз не шлём: касса перерисовывается часто, а покупателю это не нужно
let last = ''
export function showCustomer(state) {
  // Маленькое табло на COM-порту (1.7.6) — то же: сумма и сдача
  try {
    tabloOut(state)
  } catch {
    /* табло не важнее кассы */
  }
  const ch = web()
  if (ch) {
    current = state
    try {
      ch.postMessage({ type: 'state', state: withLogo(state) })
    } catch {
      /* не важнее кассы */
    }
    return
  }
  if (!bridge?.customer?.update) return
  let s = ''
  try {
    s = JSON.stringify(state)
  } catch {
    return
  }
  if (s === last) return
  last = s
  try {
    bridge.customer.update(state)
  } catch {
    /* экран покупателя не важнее кассы: не вышло — касса работает дальше */
  }
}

// Корзина кассы → строки для экрана покупателя. line — как кассир видит строку чека:
// название, «сколько × почём» (qtyPriceText из lib/ticket.js) и сумма строки
export function cartScreen({ cart, total, discountTotal, shop, lang, t, money, sub, sum }) {
  return {
    mode: 'cart',
    lang,
    shop,
    labels: customerLabels(t),
    items: cart.map((i) => ({ name: String(i.name || ''), sub: sub(i), sum: sum(i) })),
    discount: discountTotal > 0 ? '−' + money(discountTotal) : '',
    total: money(total),
  }
}
