// ── Принтер этикеток: настройка этого компьютера и задание на печать ──
//
// Наклейки со штрихкодом печатаются на принтере этикеток (Xprinter, TSC, Godex…) через
// его драйвер Windows. Окно рисует наклейки страницами ровно их размера
// (client/src/components/Nakleyka.jsx), а здесь — что запомнить в настройках и с какими
// параметрами отдать страницы движку печати.
//
// Размер наклейки передаётся принтеру явно, в микронах. Без него новый движок печати
// считает страницу листом A4 — и на принтер этикеток ушла бы страница A4 (старый движок
// брал размер из драйвера). Поля — нулевые: наклейка рисуется во всю страницу.
//
// Модуль не зависит от Electron — его можно проверить.

export const LABEL_DEFAULTS = Object.freeze({ printer: '', w: 58, h: 40, dpi: 203, dx: 0, dy: 0, flip: false })
// Пределы — те же, что у окна (client/src/lib/nakleyka.js, SIZE_LIMITS)
export const LABEL_LIMITS = Object.freeze({ wMin: 25, wMax: 110, hMin: 20, hMax: 150, shift: 10 })

const step = (v, s) => Math.round(Math.round(v / s) * s * 100) / 100
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Число из настроек: мусор — значение по умолчанию, остальное — в пределах и с шагом
function number(v, { lo, hi, by, def }) {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(step(n, by), lo, hi) : def
}

// Размер наклейки: ширина и высота, мм, с точностью до полмиллиметра
export function labelSize(v, fallback = LABEL_DEFAULTS) {
  const L = LABEL_LIMITS
  const w = Number(v?.w)
  const h = Number(v?.h)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: fallback.w, h: fallback.h }
  return { w: clamp(step(w, 0.5), L.wMin, L.wMax), h: clamp(step(h, 0.5), L.hMin, L.hMax) }
}

// printer — имя принтера в Windows (пусто — не выбран, наклейки идут через экран печати);
// w, h — размер наклейки, мм; dpi — точек на дюйм у принтера (203 или 300): под него
// подгоняется ширина полосок штрихкода; dx, dy — сдвиг наклейки, мм (вправо и вниз;
// поправить, если принтер кладёт её чуть мимо); flip — перевернуть на 180°
export function sanitizeLabels(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const L = LABEL_LIMITS
  const size = labelSize(v)
  return {
    printer: typeof v.printer === 'string' ? v.printer.slice(0, 220) : '',
    w: size.w,
    h: size.h,
    dpi: Number(v.dpi) === 300 ? 300 : 203,
    dx: number(v.dx, { lo: -L.shift, hi: L.shift, by: 0.1, def: 0 }),
    dy: number(v.dy, { lo: -L.shift, hi: L.shift, by: 0.1, def: 0 }),
    flip: v.flip === true,
  }
}

// Размер страницы для движка печати: микроны, целыми
export const pageMicrons = ({ w, h }) => ({ width: Math.round(w * 1000), height: Math.round(h * 1000) })

// Задание на принтер этикеток: без окна печати Windows, страница — ровно наклейка,
// без полей, фон (чёрная плашка цены) печатается. Одна копия: каждая наклейка — своя
// страница, сколько наклеек — столько страниц
export function labelPrintOptions({ printer, w, h }) {
  return {
    silent: true,
    deviceName: printer,
    printBackground: true,
    landscape: false,
    copies: 1,
    margins: { marginType: 'none' },
    pageSize: pageMicrons({ w, h }),
  }
}
