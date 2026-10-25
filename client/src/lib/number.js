// ── Фильтр числового ввода ──
// Обычное поле type="number" пропускает минус, «e» и вставку из буфера — так в
// карточку товара попадали значения вроде «−12 упаковок» и «−1 вскрытая».
// Оставляем только допустимые символы. Минус не «запрещаем», а вырезаем:
// отрицательного количества или цены в магазине не бывает.
export function sanitizeNumber(raw, integer = false) {
  // Типографский минус и запятая приходят при вставке из буфера и с телефона
  let s = String(raw ?? '').replace(/,/g, '.')
  s = integer ? s.replace(/[^\d]/g, '') : s.replace(/[^\d.]/g, '')
  if (!integer) {
    // Точка только одна: «12.3.4» — не число
    const dot = s.indexOf('.')
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '')
  }
  return s
}

// ── Подписи шкалы слева на графиках ──
// Шкала узкая: «14000» и «1250000» в неё не влезают и обрезаются слева — «14000»
// читалось как «4000». Крупные числа сокращаем: «10,5 тыс.», «140 тыс.», «1,3 млн».
// Перевод передаётся снаружи (t) — файл ни от чего не зависит
export function axisNumber(v, t = (s) => s) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  const a = Math.abs(n)
  const short = (x, digits) => String(+x.toFixed(digits)).replace('.', ',')
  if (a >= 1e6) return `${short(n / 1e6, a >= 1e7 ? 0 : 1)} ${t('млн')}`
  if (a >= 1e4) return `${short(n / 1e3, a >= 1e5 ? 0 : 1)} ${t('тыс.')}`
  return String(Math.round(n))
}
