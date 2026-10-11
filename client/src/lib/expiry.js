// ── Срок годности товаров ──
import { startOfDay } from './time'

export const EXPIRY_WARN_DAYS = 30 // предупреждаем за 30 дней

// Дней до окончания срока (по таджикскому календарю). null — срок не задан.
export function daysToExpiry(expiryDate) {
  if (!expiryDate) return null
  const exp = startOfDay(expiryDate).getTime()
  const today = startOfDay().getTime()
  return Math.round((exp - today) / 86400000)
}

// Статус: none | ok | soon | expired
export function expiryStatus(p) {
  const days = daysToExpiry(p?.expiryDate)
  if (days === null) return { has: false, days: null, level: 'none' }
  if (days < 0) return { has: true, days, level: 'expired' }
  if (days <= EXPIRY_WARN_DAYS) return { has: true, days, level: 'soon' }
  return { has: true, days, level: 'ok' }
}

// Товары с истекающим/истёкшим сроком (для страницы и уведомлений), от ближайших
export function expiringProducts(products) {
  return (products || [])
    .map((p) => ({ p, s: expiryStatus(p) }))
    .filter((x) => x.s.level === 'expired' || x.s.level === 'soon')
    .sort((a, b) => a.s.days - b.s.days)
}

export function expiryLabel(days) {
  if (days === null) return ''
  if (days < 0) return `просрочен ${-days} дн.`
  if (days === 0) return 'истекает сегодня'
  if (days === 1) return 'остался 1 день'
  return `${days} дн.`
}
