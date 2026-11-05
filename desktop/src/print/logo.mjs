// ── Логотип магазина на чековой ленте (1.6.4) ──
//
// Логотип ставит владелец сервиса (панель → «Новый магазин» / «Изменить магазин»). На экране,
// на листе и в PDF он печатается картинкой как есть. Чековый принтер цвета не знает: ему
// нужна картинка из чёрных точек во всю ширину ленты, и шлётся она командой «растр» (GS v 0).
//
// Здесь — только расчёты, без Electron: размер логотипа на ленте, перевод в чёрно-белый
// и байты команды. Картинку раскрывает и уменьшает основная часть программы (main.mjs,
// nativeImage) — проверки этого модуля обходятся без неё.

// Что вообще годится в логотип: картинка data URL тех видов, что принимает сервер
// (server/src/admin/logo.ts), и не тяжелее 300 КБ. Иное — как «логотипа нет».
// Только PNG и JPEG: WebP Electron (nativeImage) не раскрывает ни в 44-й, ни в 22-й версии —
// такой логотип молча не попал бы на ленту. Панель переводит любой выбранный файл в PNG или JPG
export const LOGO_MAX_CHARS = Math.ceil((300 * 1024) / 3) * 4 + 64
const DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

export function cleanLogo(v) {
  return typeof v === 'string' && v.length <= LOGO_MAX_CHARS && DATA_URL.test(v) ? v : ''
}

// Ширина ленты в точках: принтер печатает знак шрифтом 12 точек шириной, поэтому
// 32 знака (58 мм) — 384 точки, 42 — 504, 48 (80 мм) — 576
export function paperDots(width) {
  const w = Math.round(Number(width)) || 32
  return Math.max(8, Math.min(48, w)) * 12
}

// Логотип на ленте: не шире трёх четвертей ленты и не выше 160 точек (2 см при 203 точках
// на дюйм) — чек не должен начинаться с огромной картинки. Мелкий — увеличивается не больше
// чем вдвое: дальше он рассыпался бы на квадраты
export const LOGO_MAX_H = 160
export function logoTarget(width, height, dots) {
  const w = Math.max(1, Math.round(width) || 1)
  const h = Math.max(1, Math.round(height) || 1)
  const k = Math.min(Math.floor(dots * 0.75) / w, LOGO_MAX_H / h, 2)
  return { width: Math.max(1, Math.min(dots, Math.round(w * k))), height: Math.max(1, Math.min(LOGO_MAX_H, Math.round(h * k))) }
}

// Плотность середины (1 — как есть, больше — темнее). 2,2 подобрана по снимкам ленты: при 1
// золотое кольцо эмблемы и жёлтое слово на прозрачном выходили редкой бледной сеткой
export const LOGO_GAMMA = 2.2

// ── Цветная картинка → чёрные точки ──
// px — точки подряд по четыре байта, width×height. order — порядок цветов: Electron отдаёт BGRA,
// браузер — RGBA. premultiplied — цвет уже умножен на прозрачность: так отдаёт nativeImage.toBitmap()
// (проверено в 44 и 22: белая точка с прозрачностью 128 приходит как 128,128,128,128), а canvas
// браузера — нет. Прозрачное — бумага (белое). Бледный логотип (жёлтый, светло-голубой) вытягивается по
// яркости: самое тёмное в нём печатается чёрным, иначе он вышел бы едва заметной сеткой.
// Полутона — рассеиванием ошибки (способ Аткинсона): буквы и тонкие линии остаются чёткими,
// плавные переходы — сеткой точек. Логотип встаёт по центру полосы шириной dots.
// Ответ: { width: dots, height, bytesPerRow, bits } — строки по bytesPerRow байт, бит 1 —
// чёрная точка, старший бит — левая
export function toMono(px, width, height, dots, { order = 'bgra', premultiplied = false, gamma = LOGO_GAMMA } = {}) {
  const n = width * height
  const lum = new Float32Array(n)
  const [ri, gi, bi] = order === 'rgba' ? [0, 1, 2] : [2, 1, 0]
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const A = px[o + 3] ?? 255
    // На белую бумагу: прозрачное — белое, полупрозрачное — светлее. Умноженный цвет уже несёт
    // долю прозрачности — к нему добавляется только бумага (255 − A)
    const paper = (c) => (premultiplied ? Math.min(255, c + (255 - A)) : 255 - (A / 255) * (255 - c))
    lum[i] = 0.299 * paper(px[o + ri]) + 0.587 * paper(px[o + gi]) + 0.114 * paper(px[o + bi])
  }

  // Тёмный край: двухпроцентная доля «чернил» (точек темнее бумаги) — по ней, а не по самой
  // тёмной точке: одна случайная тёмная точка на краю не должна отменять вытягивание
  const ink = []
  for (let i = 0; i < n; i++) if (lum[i] < 250) ink.push(lum[i])
  if (ink.length) {
    ink.sort((a, b) => a - b)
    const lo = ink[Math.floor((ink.length - 1) * 0.02)]
    if (lo > 0 && lo < 250) {
      const k = 255 / (255 - lo)
      for (let i = 0; i < n; i++) lum[i] = lum[i] <= lo ? 0 : Math.min(255, (lum[i] - lo) * k)
    }
  }
  // Середина — плотнее (гамма): светлый цвет логотипа (золото, голубой) на термобумаге иначе
  // выходит редкой бледной сеткой. Чёрное остаётся чёрным, бумага — белой
  if (gamma !== 1) for (let i = 0; i < n; i++) lum[i] = 255 * Math.pow(Math.max(0, Math.min(255, lum[i])) / 255, gamma)

  const bytesPerRow = Math.ceil(dots / 8)
  const bits = new Uint8Array(bytesPerRow * height)
  const x0 = Math.max(0, Math.floor((dots - width) / 2))
  const spread = (x, y, err) => {
    if (x < 0 || x >= width || y >= height) return
    lum[y * width + x] += err
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = lum[i]
      const black = old < 128
      const err = (old - (black ? 0 : 255)) / 8
      if (black) {
        const X = x0 + x
        if (X < dots) bits[y * bytesPerRow + (X >> 3)] |= 0x80 >> (X & 7)
      }
      // Аткинсон: шесть соседей по 1/8 ошибки (2/8 пропадает — светлое остаётся светлым)
      spread(x + 1, y, err)
      spread(x + 2, y, err)
      spread(x - 1, y + 1, err)
      spread(x, y + 1, err)
      spread(x + 1, y + 1, err)
      spread(x, y + 2, err)
    }
  }
  return { width: dots, height, bytesPerRow, bits }
}

// Команда принтеру: растр (GS v 0), обычный размер точки
export function rasterBytes(mono) {
  const head = Buffer.from([0x1d, 0x76, 0x30, 0x00, mono.bytesPerRow & 0xff, mono.bytesPerRow >> 8, mono.height & 0xff, mono.height >> 8])
  return Buffer.concat([head, Buffer.from(mono.bits)])
}

// Та же полоса картинкой (BGRA, чёрное на белом) — для предпросмотра ленты: экран печати
// показывает логотип ровно таким, каким его напечатает принтер
export function monoToBgra(mono) {
  const out = Buffer.alloc(mono.width * mono.height * 4, 0xff)
  for (let y = 0; y < mono.height; y++) {
    for (let x = 0; x < mono.width; x++) {
      if (mono.bits[y * mono.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) {
        const o = (y * mono.width + x) * 4
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
      }
    }
  }
  return out
}
