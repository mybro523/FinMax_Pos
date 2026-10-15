// ── Внутренние штрихкоды EAN-13: генерация, проверка и отрисовка ──
// Для товаров без заводского штрихкода магазин печатает свой. Берём префикс «2» —
// он зарезервирован под внутреннее использование магазина, поэтому такой код никогда
// не столкнётся с настоящим заводским EAN-13.

export const INTERNAL_PREFIX = '2'

// Контрольная цифра EAN-13: сумма цифр с весами 1 и 3, дополнение до десятка
export function ean13CheckDigit(first12) {
  const d = String(first12).replace(/\D/g, '').slice(0, 12)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d[i] || 0) * (i % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}

export function isValidEan13(code) {
  const s = String(code || '').replace(/\D/g, '')
  return s.length === 13 && ean13CheckDigit(s.slice(0, 12)) === s[12]
}

// Внутренний ли это код (сгенерированный нами), а не заводской
export const isInternalBarcode = (code) => /^\d{13}$/.test(String(code || '')) && String(code)[0] === INTERNAL_PREFIX

// Генерируем уникальный внутренний EAN-13. taken — уже занятые коды (из базы товаров).
export function generateEan13(taken = []) {
  const busy = new Set(Array.from(taken).map((c) => String(c || '').replace(/\D/g, '')))
  for (let attempt = 0; attempt < 5000; attempt++) {
    let body = INTERNAL_PREFIX
    for (let i = 0; i < 11; i++) body += Math.floor(Math.random() * 10)
    const code = body + ean13CheckDigit(body)
    if (!busy.has(code)) return code
  }
  return '' // столько занятых кодов быть не может, но лучше вернуть пусто, чем дубль
}

// ── Отрисовка EAN-13 в SVG ──
// Кодировка цифр: L/G — левая половина (набор зависит от первой цифры), R — правая.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
// Какая половина цифр слева кодируется набором G — определяется первой цифрой кода
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

// Возвращает строку из 95 бит: поля-разделители + 12 закодированных цифр
export function ean13Bits(code) {
  const s = String(code || '').replace(/\D/g, '')
  if (s.length !== 13) return ''
  const parity = PARITY[Number(s[0])]
  let bits = '101' // левый разделитель
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[Number(s[i])]
  bits += '01010' // центральный разделитель
  for (let i = 7; i <= 12; i++) bits += R[Number(s[i])]
  return bits + '101' // правый разделитель
}

// SVG со штрихкодом и подписью цифр. Размеры — в миллиметрах, чтобы печаталось
// одинаково на любом принтере независимо от разрешения экрана.
export function ean13Svg(code, { widthMm = 37, heightMm = 26, showText = true } = {}) {
  const bits = ean13Bits(code)
  if (!bits) return ''
  const s = String(code).replace(/\D/g, '')
  const quiet = 3 // тихая зона слева/справа в модулях — без неё сканер не читает край
  const modules = bits.length + quiet * 2
  const mw = widthMm / modules // ширина одного модуля, мм
  const textH = showText ? 3.2 : 0
  const barH = heightMm - textH - 1
  // Разделители печатаются длиннее — так требует стандарт
  const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92

  let bars = ''
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue
    const x = (quiet + i) * mw
    const h = guard(i) ? barH + textH * 0.55 : barH
    bars += `<rect x="${x.toFixed(3)}" y="0" width="${mw.toFixed(3)}" height="${h.toFixed(2)}" fill="#000"/>`
  }

  let text = ''
  if (showText) {
    const fs = 3
    const y = heightMm - 0.4
    const at = (mod, str) => `<text x="${((quiet + mod) * mw).toFixed(2)}" y="${y}" font-family="monospace" font-size="${fs}" fill="#000">${str}</text>`
    text = at(-2.6, s[0]) + at(4, s.slice(1, 7)) + at(51, s.slice(7)) // 1 + 6 + 6 цифр
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}" shape-rendering="crispEdges">${bars}${text}</svg>`
}
