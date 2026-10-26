// ── Наклейка со штрихкодом для принтера этикеток ──
//
// Принтер этикеток печатает на рулоне наклеек одного размера: 58×40, 40×30, 30×20 мм…
// Одна наклейка — одна страница ровно её размера: тогда драйвер принтера кладёт каждую
// страницу на свою наклейку, без сдвигов и пустых наклеек между ними.
//
// На наклейке — название (до двух строк, на низкой — одна), штрихкод с цифрами и цена
// на чёрной плашке. Раскладка считается здесь, от размера наклейки: шрифт названия и цены
// уменьшается, пока текст не поместится, полоскам достаётся всё остальное место.
// Ширина модуля штрихкода — целое число точек принтера (lib/barcode.js, moduleFor).
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { barcodeModel, modulesOf, moduleFor } from './barcode.js'
import { isDrobnyy, uppOf } from './units.js'

// Ходовые размеры рулонов: ширина × высота, мм (ширина — поперёк принтера)
export const NAKLEYKA_SIZES = [
  { id: '58x40', w: 58, h: 40 },
  { id: '58x30', w: 58, h: 30 },
  { id: '40x30', w: 40, h: 30 },
  { id: '30x20', w: 30, h: 20 },
]
export const DEFAULT_SIZE = { w: 58, h: 40 }
// Свой размер: принтеры этикеток берут рулоны шириной до 108 мм. Уже 25 и ниже 20 мм
// штрихкод с названием и ценой не помещается
export const SIZE_LIMITS = { wMin: 25, wMax: 110, hMin: 20, hMax: 150 }

const num = (v) => Number(String(v ?? '').replace(',', '.'))
const halfMm = (v) => Math.round(v * 2) / 2

// Размер из настроек или поля ввода — в разумных пределах, с точностью до полмиллиметра.
// Мусор — размер по умолчанию
export function sizeOf(v) {
  const w = num(v?.w)
  const h = num(v?.h)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { ...DEFAULT_SIZE }
  const L = SIZE_LIMITS
  return { w: Math.min(L.wMax, Math.max(L.wMin, halfMm(w))), h: Math.min(L.hMax, Math.max(L.hMin, halfMm(h))) }
}

// Какой из ходовых размеров выбран ('custom' — свой)
export const sizeId = (s) => NAKLEYKA_SIZES.find((x) => x.w === Number(s?.w) && x.h === Number(s?.h))?.id || 'custom'

// «58×40 мм»
export const sizeText = (s) => `${String(s.w).replace('.', ',')}×${String(s.h).replace('.', ',')} мм`

// Строка названия на наклейке: название и, если есть, дозировка/объём («Нурофен 200 мг»)
export function nakleykaName(p) {
  return [p?.name, p?.dosage].map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
}

// ── Ширина текста ──
// В окне программы текст меряется по-настоящему (canvas, components/Nakleyka.jsx), в
// проверках — приблизительно: средняя буква жирного Arial ≈ 0,6 кегля
export const MM_PER_PT = 25.4 / 72
export const approxMeasure = (text, pt, bold = true) => String(text).length * pt * MM_PER_PT * (bold ? 0.6 : 0.55)

// Строки текста шириной widthMm: перенос по пробелам, слово длиннее строки — по буквам.
// Не больше maxLines строк: что не влезло — в последнюю, с многоточием (cut: true)
export function wrapLines(text, { pt, widthMm, maxLines = Infinity, measure = approxMeasure }) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { lines: [], cut: false }
  const fits = (x) => measure(x, pt, true) <= widthMm
  const lines = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? line + ' ' + word : word
    if (fits(next)) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = word
    while (line.length > 1 && !fits(line)) {
      let k = line.length - 1
      while (k > 1 && !fits(line.slice(0, k))) k--
      lines.push(line.slice(0, k))
      line = line.slice(k)
    }
  }
  if (line) lines.push(line)
  if (lines.length <= maxLines) return { lines, cut: false }
  const kept = lines.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last.length > 1 && !fits(last + '…')) last = last.slice(0, -1).trimEnd()
  kept[maxLines - 1] = last + '…'
  return { lines: kept, cut: true }
}

// Самый крупный кегль от maxPt до minPt (шаг 0,5), при котором текст помещается в lines
// строк. Не помещается и при minPt — minPt, и хвост обрезается многоточием (wrapLines)
export function fitText(text, { widthMm, lines = 1, maxPt, minPt, measure = approxMeasure }) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { pt: maxPt, lines: 0, rows: [], cut: false }
  // Запас 2%: шрифт на бумаге и на экране чуть различается
  const width = widthMm * 0.98
  for (let pt = maxPt; pt >= minPt - 1e-9; pt = Math.round((pt - 0.5) * 10) / 10) {
    const r = wrapLines(s, { pt, widthMm: width, measure })
    if (r.lines.length <= lines) return { pt, lines: r.lines.length, rows: r.lines, cut: false }
  }
  const r = wrapLines(s, { pt: minPt, widthMm: width, maxLines: lines, measure })
  return { pt: minPt, lines: r.lines.length, rows: r.lines, cut: true }
}

// ── Раскладка наклейки ──
// size — { w, h } мм; name, price — строки; code — штрихкод товара; dpi — точек на дюйм у
// принтера (203 у большинства); dx, dy — сдвиг из настройки принтера, мм (вправо и вниз);
// flip — наклейка перевёрнута на 180°. Возвращает, где что стоит (мм от верхнего левого угла
// наклейки, до сдвига и поворота); problem — почему наклейку не напечатать: 'nocode' — у
// товара нет кода, 'badcode' — в коде знаки, которых нет в штрихкодах (русские буквы),
// 'toolong' — код не помещается по ширине наклейки, 'toolow' — по высоте
const PX_PER_MM = 96 / 25.4
export function nakleykaPlan(size, { name = '', price = '', code = '', dpi = 203, measure = approxMeasure, dx = 0, dy = 0, flip = false } = {}) {
  const { w, h } = sizeOf(size)
  const big = h >= 35
  const mid = h >= 25
  const gap = mid ? 0.7 : 0.5
  const dot = 25.4 / (Number(dpi) > 0 ? Number(dpi) : 203)

  // Блок наклейки на странице — на 0,6 мм уже и ниже страницы. Движок печати округляет
  // размер страницы (до пункта, до точки экрана, до точки принтера — старый движок Windows
  // 7/8 теряет так до 0,4 мм), и наклейка ровно в страницу переносилась бы на вторую, оставляя
  // пустую наклейку. Рисунок наклейки (components/Nakleyka.jsx) — целое число точек экрана,
  // его край ещё до 0,26 мм ближе
  const boxW = Math.floor((w - 0.6) / dot) * dot
  const boxH = h - 0.6
  const vbW = Math.floor(boxW * PX_PER_MM) / PX_PER_MM
  const vbH = Math.floor(boxH * PX_PER_MM) / PX_PER_MM
  // Сдвиг — целыми точками принтера. Поворот — вокруг середины наклейки, взятой так, что её
  // удвоенная координата — целые точки: перевёрнутые полосы тоже ложатся на точки
  const sx = Math.round((Number(dx) || 0) / dot) * dot
  const sy = Math.round((Number(dy) || 0) / dot) * dot
  const cx = (Math.round(w / dot) * dot) / 2
  const cy = h / 2
  // Где содержимое после сдвига и поворота остаётся внутри рисунка. С той стороны, куда сдвиг
  // уводит содержимое, поля шире: иначе край цены или кода срезало бы
  const safe = flip
    ? { x0: 2 * cx + sx - vbW, x1: 2 * cx + sx, y0: 2 * cy + sy - vbH, y1: 2 * cy + sy }
    : { x0: -sx, x1: vbW - sx, y0: -sy, y1: vbH - sy }
  const KEEP = 0.3 // не ближе к краю рисунка
  const baseX = w >= 50 ? 2 : 1.4
  const baseY = big ? 1.5 : 1.1
  const padL = Math.max(baseX, safe.x0 + KEEP)
  const padR = Math.max(baseX, w - safe.x1 + KEEP)
  const padT = Math.max(baseY, safe.y0 + KEEP)
  const padB = Math.max(baseY, h - safe.y1 + KEEP)
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(0, h - padT - padB)
  const xc = (padL + w - padR) / 2

  const nameFit = fitText(name, { widthMm: innerW, lines: mid ? 2 : 1, maxPt: big ? 10 : mid ? 8.5 : 7.5, minPt: mid ? 6.5 : 6, measure })
  const nameH = nameFit.lines * nameFit.pt * MM_PER_PT * 1.12
  // Плашка цены: поля 1,5 мм по бокам и 0,4 мм сверху и снизу
  const priceFit = fitText(price, { widthMm: innerW - 3, lines: 1, maxPt: big ? 14 : mid ? 11.5 : 9.5, minPt: 6.5, measure })
  const priceH = price ? priceFit.pt * MM_PER_PT * 1.2 + 0.8 : 0
  const priceText = priceFit.cut ? wrapLines(price, { pt: priceFit.pt, widthMm: (innerW - 3) * 0.98, maxLines: 1, measure }).lines[0] || '' : String(price ?? '').replace(/\s+/g, ' ').trim()

  const trimmed = String(code ?? '').trim()
  // Белое поле кода может заходить в поля наклейки — до 0,8 мм от края. По стандарту поле
  // Code 128 — 10 модулей с каждой стороны, EAN-13 — 11 и 7, EAN-8 — 7 и 7. На узкой наклейке,
  // где так не помещается, поле уже — как в программах для этикеток (сканерам хватает и
  // пяти-шести модулей), а если и так тесно — доходит до 0,4 мм от края (подложка вокруг
  // наклейки тоже светлая). Иначе на 30×20 у принтера 300 dpi (модуль там не тоньше 3 точек)
  // не встали бы ни EAN-13, ни короткий Code 128
  let model = barcodeModel(trimmed)
  let module = model ? moduleFor(modulesOf(model), w - 1.6, dpi) : 0
  const TIGHT = { code128: [6, 6], ean13: [9, 7], ean8: [5, 5] }
  if (model && !module && TIGHT[model.kind]) {
    const [quietL, quietR] = TIGHT[model.kind]
    const tight = { ...model, quietL, quietR }
    for (const area of [w - 1.6, w - 0.8]) {
      const m = moduleFor(modulesOf(tight), area, dpi)
      if (m) {
        model = tight
        module = m
        break
      }
    }
  }
  const fontMm = module ? Math.min(3, Math.max(1.9, module * 8.5)) : 0
  const textH = fontMm ? 0.25 + fontMm * 0.95 : 0
  const free = innerH - nameH - priceH - textH - (nameH ? gap : 0) - (priceH ? gap : 0)
  const barMm = Math.max(0, Math.min(big ? 18 : 14, free))

  // Код — посередине, левый край ровно на точке принтера: страница начинается с точки 0,
  // модуль — целое число точек, значит и каждая полоса ложится на точки целиком, без
  // «полуточек», которые термоголовка печатала бы то толще, то тоньше. Белое поле может уйти
  // за край, сами полосы — нет: при сдвиге код подвигается внутрь
  const width = model && module ? modulesOf(model) * module : 0
  let left = 0
  let fits = !!width
  if (width) {
    const qL = model.quietL * module
    const qR = model.quietR * module
    const minLeft = safe.x0 + KEEP - qL
    const maxLeft = safe.x1 - KEEP - (width - qR)
    left = Math.round((xc - width / 2) / dot) * dot
    if (left < minLeft) left = Math.ceil(minLeft / dot - 1e-9) * dot
    if (left > maxLeft) left = Math.floor(maxLeft / dot + 1e-9) * dot
    fits = left >= minLeft - 1e-9 && left <= maxLeft + 1e-9
  }

  // Название сверху, цена снизу, код — посередине между ними
  const nameTop = padT
  const priceTop = h - padB - priceH
  const zoneTop = padT + nameH + (nameH ? gap : 0)
  const zoneBottom = priceTop - (priceH ? gap : 0)
  const bcTop = zoneTop + Math.max(0, (zoneBottom - zoneTop - barMm - textH) / 2)

  let problem = ''
  if (!trimmed) problem = 'nocode'
  else if (!model) problem = 'badcode'
  else if (!module || !fits) problem = 'toolong'
  else if (barMm < 4) problem = 'toolow'

  return {
    w,
    h,
    // Поля (с учётом сдвига), середина по ширине, блок и рисунок, сдвиг и поворот
    pad: { l: padL, r: padR, t: padT, b: padB },
    xc,
    boxW,
    boxH,
    vbW,
    vbH,
    dot,
    sx,
    sy,
    flip: !!flip,
    cx,
    cy,
    // rows — строки названия, как их напечатать; text — цена (не влезла и при самом мелком
    // кегле — с многоточием); plateW — ширина чёрной плашки
    name: { pt: nameFit.pt, lines: Math.max(1, nameFit.lines), rows: nameFit.rows, cut: nameFit.cut, top: nameTop, height: nameH },
    price: { pt: priceFit.pt, top: priceTop, height: priceH, text: priceText, plateW: priceText ? measure(priceText, priceFit.pt, true) + 3 : 0 },
    barcode: { model, module, barMm, fontMm, width, left, top: bcTop, height: barMm + textH },
    problem,
  }
}

// Почему наклейку не напечатать — словами для человека (переводится в окне)
export const PROBLEM_TEXT = {
  nocode: 'У товара нет штрихкода.',
  badcode: 'В штрихкоде есть русские буквы или другие знаки, которые полоской не напечатать.',
  toolong: 'Штрихкод слишком длинный для наклейки этой ширины — выберите наклейку шире.',
  toolow: 'Наклейка слишком низкая для штрихкода — выберите наклейку выше.',
}

// ── Сколько наклеек ──
export const MAX_COPIES = 999 // на один товар за раз
export const MAX_TOTAL = 2000 // всего за одну печать

export function copiesOf(v) {
  const n = Math.trunc(Number(v) || 0)
  return Math.min(MAX_COPIES, Math.max(0, n))
}

// Наклейки на строку прихода: сколько пришло упаковок, неполная упаковка — тоже наклейка
// («2 уп + 5 шт» — 3). Весовой и дробный товар (кг, л, м) — одна, на ящик или полку
export function nakleekNaStroku(item, product) {
  if (!product) return 0
  if (isDrobnyy(product)) return 1
  const qty = Math.max(0, Math.trunc(Number(item?.qty) || 0))
  const pieces = Math.max(0, Number(item?.pieces) || 0)
  const packs = qty + (pieces > 0 && uppOf(product) > 1 ? Math.ceil(pieces / uppOf(product)) : 0)
  return copiesOf(packs)
}

// Наклейки подряд: строки { key, name, code, price, count } → по одной на каждую копию.
// Больше MAX_TOTAL за раз не печатаем — длинный рулон лучше делить
export function razvernut(rows, max = MAX_TOTAL) {
  const out = []
  for (const r of rows) {
    const n = copiesOf(r?.count)
    for (let k = 0; k < n && out.length < max; k++) out.push({ ...r, key: `${r.key}:${k}` })
  }
  return out
}

export const totalOf = (rows) => rows.reduce((s, r) => s + copiesOf(r?.count), 0)

// Настройка «размер наклейки» на сайте (и в программе, пока принтер этикеток не выбран)
// помнится в этом браузере: это удобство, а не данные магазина
const SIZE_KEY = 'apteka_nakleyka_razmer'
export function savedSize() {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    return raw ? sizeOf(JSON.parse(raw)) : { ...DEFAULT_SIZE }
  } catch {
    return { ...DEFAULT_SIZE }
  }
}
export function saveSize(s) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(sizeOf(s)))
  } catch {
    /* не запомнилось — не страшно */
  }
}
