// ── Штрихкоды: EAN-13, EAN-8 и Code 128 — выбор, проверка и отрисовка ──
//
// Для товаров без заводского штрихкода магазин печатает свой EAN-13. Берём префикс «2» —
// он зарезервирован под внутреннее использование магазина, поэтому такой код никогда
// не столкнётся с настоящим заводским EAN-13.
//
// Напечатать можно любой код товара: 13 цифр с верной контрольной — EAN-13, 8 цифр —
// EAN-8, всё остальное («123», код с буквами, 12 цифр) — Code 128. Сканер читает ровно
// то, что напечатано, поэтому код с наклейки совпадает с записанным у товара знак в знак.

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

// Контрольная цифра EAN-8: веса 3 и 1 (с первой цифры), дополнение до десятка
export function ean8CheckDigit(first7) {
  const d = String(first7).replace(/\D/g, '').slice(0, 7)
  let sum = 0
  for (let i = 0; i < 7; i++) sum += Number(d[i] || 0) * (i % 2 === 0 ? 3 : 1)
  return String((10 - (sum % 10)) % 10)
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

// ── Каким видом печатать код ──
// Строго: EAN — только когда код состоит из одних цифр нужной длины с верной контрольной.
// «4600-0000-0000-1» — не EAN-13: сканер выдал бы цифры без чёрточек, и товар не нашёлся
// бы. Такой код печатается как есть — Code 128.
// Code 128 знает только латиницу, цифры и знаки (коды 32–126); русские буквы в нём не
// закодировать — тогда '' («этот код полоской не напечатать»).
const strictEan13 = (s) => /^\d{13}$/.test(s) && ean13CheckDigit(s.slice(0, 12)) === s[12]
const strictEan8 = (s) => /^\d{8}$/.test(s) && ean8CheckDigit(s.slice(0, 7)) === s[7]

export function barcodeKind(code) {
  const s = String(code ?? '').trim()
  if (!s) return ''
  if (strictEan13(s)) return 'ean13'
  if (strictEan8(s)) return 'ean8'
  return /^[\x20-\x7e]+$/.test(s) ? 'code128' : ''
}

// ── EAN-13 и EAN-8 ──
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

// EAN-8: 67 бит — четыре цифры набором L слева, четыре набором R справа
export function ean8Bits(code) {
  const s = String(code || '')
  if (!/^\d{8}$/.test(s)) return ''
  let bits = '101'
  for (let i = 0; i < 4; i++) bits += L[Number(s[i])]
  bits += '01010'
  for (let i = 4; i < 8; i++) bits += R[Number(s[i])]
  return bits + '101'
}

// ── Code 128 ──
// Каждый знак — шесть полос (чёрная, белая, …) общей шириной 11 модулей, «стоп» — семь
// полос на 13 модулей. Номер в таблице — значение знака.
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
export const CODE128_PATTERNS = C128
const START_B = 104
const START_C = 105
const TO_B = 100 // переход на набор B из набора C
const TO_C = 99 // переход на набор C из набора B
const STOP = 106

const isDigit = (s, i) => {
  const c = s.charCodeAt(i)
  return c >= 48 && c <= 57
}
const digitsFrom = (s, i) => {
  let n = 0
  while (i + n < s.length && isDigit(s, i + n)) n++
  return n
}

// Значения знаков: набор B — буквы, цифры и знаки по одному; набор C — цифры парами
// (код вдвое короче). На C переходим, когда цифр подряд хватает, чтобы это окупилось:
// четыре и больше в начале или в конце, шесть и больше в середине. Последний знак —
// контрольный: сумма значений с весами по месту, остаток от деления на 103
export function code128Values(text) {
  const s = String(text ?? '')
  if (!s || !/^[\x20-\x7e]+$/.test(s)) return null
  const vals = []
  const lead = digitsFrom(s, 0)
  let set
  if ((lead === s.length && lead >= 2 && lead % 2 === 0) || lead >= 4) {
    set = 'C'
    vals.push(START_C)
  } else {
    set = 'B'
    vals.push(START_B)
  }
  let i = 0
  while (i < s.length) {
    if (set === 'C') {
      if (digitsFrom(s, i) >= 2) {
        vals.push(Number(s.slice(i, i + 2)))
        i += 2
      } else {
        vals.push(TO_B)
        set = 'B'
      }
      continue
    }
    const run = digitsFrom(s, i)
    if ((run >= 4 && i + run === s.length) || run >= 6) {
      // Нечётную цифру — ещё в наборе B, остальные парами
      if (run % 2 === 1) {
        vals.push(s.charCodeAt(i) - 32)
        i++
      }
      vals.push(TO_C)
      set = 'C'
      continue
    }
    vals.push(s.charCodeAt(i) - 32)
    i++
  }
  let sum = vals[0]
  for (let k = 1; k < vals.length; k++) sum += vals[k] * k
  vals.push(sum % 103, STOP)
  return vals
}

export function code128Bits(text) {
  const vals = code128Values(text)
  if (!vals) return ''
  let bits = ''
  for (const v of vals) {
    const p = C128[v]
    for (let j = 0; j < p.length; j++) bits += (j % 2 === 0 ? '1' : '0').repeat(Number(p[j]))
  }
  return bits
}

// ── Модель полоски: что рисовать ──
// bits — модули (1 — чёрный), quietL/quietR — белое поле слева и справа в модулях (без
// него сканер не находит край кода; EAN требует 11 слева и 7 справа, Code 128 — 10),
// text — подпись под полосками
export function barcodeModel(code) {
  const kind = barcodeKind(code)
  const s = String(code ?? '').trim()
  if (kind === 'ean13') return { kind, bits: ean13Bits(s), quietL: 11, quietR: 7, text: s }
  if (kind === 'ean8') return { kind, bits: ean8Bits(s), quietL: 7, quietR: 7, text: s }
  if (kind === 'code128') return { kind, bits: code128Bits(s), quietL: 10, quietR: 10, text: s }
  return null
}

// Ширина кода в модулях вместе с белыми полями
export const modulesOf = (model) => (model ? model.bits.length + model.quietL + model.quietR : 0)

// ── Ширина модуля под точки принтера ──
// Термопринтер этикеток печатает точками: 203 точки на дюйм (у большинства) — точка
// 0,125 мм. Если ширина модуля — не целое число точек, полоски выходят то в две точки,
// то в три, и сканер спотыкается. Поэтому модуль — ровно 2 или 3 точки (0,25 или 0,375 мм;
// у 300 dpi — 3 или 4 точки). Берём самый широкий, который помещается; не помещается
// даже самый узкий — 0 (код слишком длинный для этой ширины)
export const MODULE_MIN_MM = 0.25
export const MODULE_MAX_MM = 0.4

export function moduleFor(totalModules, widthMm, dpi = 203) {
  const dot = 25.4 / (Number(dpi) > 0 ? Number(dpi) : 203)
  const maxK = Math.floor(MODULE_MAX_MM / dot + 1e-9)
  const minK = Math.max(1, Math.ceil(MODULE_MIN_MM / dot - 0.06))
  for (let k = maxK; k >= minK; k--) {
    if (totalModules * k * dot <= widthMm + 1e-9) return k * dot
  }
  return 0
}

// ── Отрисовка в SVG ──
// Размеры — в миллиметрах, поэтому на бумаге ширина модуля точная на любом принтере.
// Соседние чёрные модули сливаются в одну полосу: иначе на стыках бывают волоски.
// module — ширина модуля (мм), barMm — высота полос, fontMm — размер цифр подписи
// (0 — без подписи). У EAN разделители длиннее полос и уходят в подпись, как в стандарте
const GUARDS = {
  ean13: new Set([0, 2, 46, 48, 92, 94]),
  ean8: new Set([0, 2, 32, 34, 64, 66]),
}
const mm = (v) => String(Math.round(v * 1000) / 1000)

// Полосы и подпись — содержимое SVG в миллиметрах, начало — левый верхний угол кода
// (вместе с белым полем). w, h — его размер
export function barcodeInner(model, { module, barMm, fontMm = 0 }) {
  if (!model || !model.bits || !(module > 0) || !(barMm > 0)) return null
  const { kind, bits, quietL, text } = model
  const w = modulesOf(model) * module
  const withText = fontMm > 0
  const textTop = barMm + 0.25
  const h = withText ? textTop + fontMm * 0.95 : barMm
  const guards = GUARDS[kind]
  const guardH = withText && guards ? barMm + fontMm * 0.55 : barMm
  let rects = ''
  for (let i = 0; i < bits.length; ) {
    if (bits[i] !== '1') {
      i++
      continue
    }
    let j = i
    while (j < bits.length && bits[j] === '1') j++
    const bh = guards && guards.has(i) ? guardH : barMm
    rects += `<rect x="${mm((quietL + i) * module)}" y="0" width="${mm((j - i) * module)}" height="${mm(bh)}"/>`
    i = j
  }

  let texts = ''
  if (withText) {
    const y = mm(textTop + fontMm * 0.76)
    const at = (centerModule, str, spanModules) => {
      const x = mm((quietL + centerModule) * module)
      const span = spanModules ? ` textLength="${mm(spanModules * module)}" lengthAdjust="spacing"` : ''
      return `<text x="${x}" y="${y}" text-anchor="middle"${span}>${str}</text>`
    }
    if (kind === 'ean13') {
      // Первая цифра — слева от кода, на белом поле; дальше две группы по шесть
      texts = at(-4, text[0]) + at(24, text.slice(1, 7), 36) + at(71, text.slice(7), 36)
    } else if (kind === 'ean8') {
      texts = at(17, text.slice(0, 4), 22) + at(50, text.slice(4), 22)
    } else {
      // Code 128: подпись по центру; длинная не вылезет за полоски — шрифт уменьшится
      const fit = Math.min(fontMm, (bits.length * module) / Math.max(1, text.length * 0.62))
      const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      texts = `<text x="${mm((quietL + bits.length / 2) * module)}" y="${y}" text-anchor="middle" font-size="${mm(fit)}">${esc}</text>`
    }
    texts = `<g font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${mm(fontMm)}" fill="#000">${texts}</g>`
  }
  return { inner: `<g fill="#000">${rects}</g>${texts}`, w, h }
}

export function barcodeSvg(model, opts) {
  const b = barcodeInner(model, opts)
  if (!b) return ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(b.w)}mm" height="${mm(b.h)}mm" viewBox="0 0 ${mm(b.w)} ${mm(b.h)}" shape-rendering="crispEdges">${b.inner}</svg>`
}
