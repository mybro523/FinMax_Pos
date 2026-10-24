// ── Экран покупателя (программа для Windows) ──
//
// Второй экран моноблока — сторона покупателя: товары в корзине и итог, после оплаты —
// «Спасибо за покупку!» и сдача. Касса шлёт сюда готовые строки (с переводом и деньгами —
// как на чеке), программа показывает их на втором экране (desktop/src/customer-window.mjs).
// На сайте экрана покупателя нет — вызов ничего не делает.
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { bridge } from './desktop.js'

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
