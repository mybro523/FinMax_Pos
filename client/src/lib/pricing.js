// ── Проверка цен ──
// Продавать дешевле, чем купил, иногда нужно: распродажа перед сроком годности,
// уценка помятой упаковки. Поэтому не запрещаем, а спрашиваем — так опечатка
// вроде «закупка 200, продажа 20» ловится сразу, а осознанная скидка проходит.
export const sellsBelowCost = (cost, price) => {
  const c = Number(cost) || 0
  const p = Number(price) || 0
  return c > 0 && p > 0 && p < c
}

// ── Наценка ──
// Цену продажи назначают процентом к закупочной: закуп 100, наценка 25% — цена 125.
// Считаем до дирама, как и всё в кассе. Без закупочной цены процент не от чего
// считать — тогда цена остаётся как была (null).
const chislo = (v) => Number(String(v ?? '').trim().replace(',', '.'))

export function priceFromMarkup(cost, pct) {
  const c = chislo(cost)
  const m = chislo(pct)
  if (!(c > 0) || !Number.isFinite(m) || String(pct ?? '').trim() === '') return null
  // Хвост двоичной арифметики (16,71249…) отбрасываем до округления: половина — вверх
  const v = c * (1 + m / 100)
  return Math.max(0, Math.round(Number((v * 100).toPrecision(12))) / 100)
}

// Наценка в процентах по закупочной и цене продажи: 100 → 125 = 25. До сотых
// процента. Нет закупки или цены — пусто: показывать «0%» было бы неправдой
export function markupOf(cost, price) {
  const c = chislo(cost)
  const p = chislo(price)
  if (!(c > 0) || !(p > 0)) return ''
  return String(Math.round((p / c - 1) * 10000) / 100)
}
