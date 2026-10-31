// ── Надписи на плитках главного меню: один размер на все плитки, слово целиком ──
//
// Просьба владельца (31.10.2026): надписи на плитках — намного крупнее; не влезает строка —
// слово целиком переходит на следующую; у всех плиток размер один; на любом экране меню
// выглядит одинаково (надпись растёт и уменьшается вместе с плиткой); «КАССА» — заглавными
// и в полтора раза крупнее остальных.
//
// Размер упирается в самое длинное слово («Инвентаризация» — 8,2 em шрифта Inter 700, по-таджикски
// «Таъминкунандагон»): оно должно поместиться в ширину плитки. Поэтому размер считается, а не
// задан в CSS: слова меряются тем же шрифтом, что на плитке, и берётся самый крупный размер,
// при котором
//   • каждое слово стоит в строке целиком — в первой строке рядом с цифрой в углу
//     (отложенные штрихкоды, сроки годности) тоже;
//   • название занимает не больше FILL высоты плитки — внизу справа картинка.
// Плитки сетки одинаковые, поэтому размер один на все. Касса — в GOLD раз крупнее, если
// «КАССА» помещается левее тележки. Готовые размеры встают CSS-переменными на сетку (index.css,
// «Главный экран: плитки разделов»); пересчёт — при смене размера окна, языка, цифр в углу и
// после загрузки шрифта (Home.jsx).
//
// 1.5.10 (владелец 31.10: «чуть-чуть меньше, слишком увеличил»): надпись — на 15 % мельче
// самого крупного размера (SCALE), на любом экране одинаково; «КАССА» — по-прежнему в GOLD раз
// крупнее уже уменьшенных. На самых узких экранах (планшет стоя) уменьшение не опускает надпись
// ниже READABLE, если столько помещается.

export const LINE = 1.15 // высота строки надписи — как line-height в index.css
export const FILL = 0.6 // надпись обычной плитки — не выше этой доли её высоты
export const FILL_GOLD = 0.75 // «КАССА» — одна строка, ей можно выше
export const GOLD = 1.5 // «КАССА» крупнее остальных надписей во столько раз
// мельче надпись не бывает даже в крошечном окне; 9 — чтобы и на планшете стоя (плитка ~100 px)
// таджикское «Таъминкунандагон» встало целиком
export const MIN_FS = 9
export const SCALE = 0.85 // доля самого крупного размера (1.5.10: на 15 % мельче)
export const READABLE = 11 // уменьшение не делает надпись мельче этого
const SAFE = 0.99 // запас ширины на расхождение мерки и страницы (canvas и страница сходятся до 0,1 %)
const STEP = 0.5

// Цифра в углу растёт вместе с надписью, но не мельче прежней (24 px, цифры 13 px). Эти же
// числа уходят в CSS-переменные — страница рисует значок ровно таким, каким его считали.
export function badgeGeom(fs) {
  const bh = Math.max(24, Math.round(fs * 0.8))
  return {
    bh,
    bfs: Math.max(13, Math.round(fs * 0.46)),
    pad: Math.round(bh * 0.3),
    // по середине первой строки; значок выше строки — от её верха
    mt: Math.max(0, Math.round((fs * LINE - bh) / 2)),
    gap: Math.max(6, Math.round(fs * 0.25)),
  }
}

// Ширина значка: digitsEm — ширина цифр в em шрифта значка
export function badgeWidth(g, digitsEm) {
  return Math.max(g.bh, Math.ceil(digitsEm * g.bfs) + 2 * g.pad)
}

// Сколько строк займёт надпись размером fs в ширине w (px). Infinity — какое-то слово не
// помещается целиком; в строке рядом со значком — тоже Infinity: браузер опустил бы слово под
// значок, и над надписью осталась бы пустая строка.
// words — ширины слов в em, space — ширина пробела в em, flt — значок { w, bottom } в px.
export function lineCount(words, space, fs, w, flt) {
  const lineH = fs * LINE
  let lines = 0
  let i = 0
  while (i < words.length) {
    const avail = w - (flt && lines * lineH < flt.bottom ? flt.w : 0)
    let used = words[i] * fs
    if (used > avail) return Infinity
    i++
    while (i < words.length && used + (space + words[i]) * fs <= avail) {
      used += (space + words[i]) * fs
      i++
    }
    lines++
  }
  return lines
}

// Размеры для всей сетки.
//   box   — место под надпись в обычной плитке { w, h }, px;
//   tiles — обычные плитки: [{ words, badgeEm }] (badgeEm — ширина цифр значка в em шрифта
//           значка, null — значка нет);
//   space — ширина пробела в em;
//   gold  — касса { w, h, words, space } (w — ширина левее тележки) или null.
// Ответ: { fs, max, gold, badge } — размер надписей, самый крупный возможный (до уменьшения),
// размер «КАССА», значок (badgeGeom).
export function hubSizes({ box, tiles, space, gold }) {
  const w = box.w * SAFE
  const maxH = box.h * FILL
  const longest = Math.max(1e-6, ...tiles.flatMap((t) => t.words))
  const fits = (f) => {
    const g = badgeGeom(f)
    return tiles.every((t) => {
      const flt = t.badgeEm == null ? null : { w: badgeWidth(g, t.badgeEm) + g.gap, bottom: g.mt + g.bh }
      return lineCount(t.words, space, f, w, flt) * f * LINE <= maxH
    })
  }
  let max = Math.floor(w / longest / STEP) * STEP
  while (max > MIN_FS && !fits(max)) max -= STEP
  max = Math.max(MIN_FS, max)
  // На 15 % мельче самого крупного, но не мельче READABLE (если столько помещается). Меньший
  // размер проверяется заново: значок в углу не уменьшается вместе с надписью (не мельче 24 px)
  // и при мелкой надписи обтекается ещё и вторая строка
  let fs = Math.max(Math.floor((max * SCALE) / STEP) * STEP, Math.min(max, READABLE))
  while (fs > MIN_FS && !fits(fs)) fs -= STEP
  fs = Math.max(MIN_FS, fs)

  let gfs = fs
  if (gold) {
    const gw = gold.w * SAFE
    const ok = (f) => lineCount(gold.words, gold.space, f, gw, null) * f * LINE <= gold.h * FILL_GOLD
    gfs = Math.floor((fs * GOLD) / STEP) * STEP
    while (gfs > MIN_FS && !ok(gfs)) gfs -= STEP
    gfs = Math.max(MIN_FS, gfs)
  }
  return { fs, max, gold: gfs, badge: badgeGeom(fs) }
}

// ── Мерки на странице ──
// Ширина текста в em: canvas тем же шрифтом (жирность, семейство, межбуквенный интервал), что
// у надписи на плитке. Мерки копятся; после загрузки шрифта их надо сбросить (resetHubMeasure):
// до загрузки canvas мерил запасным шрифтом.
let canvas = null
let measured = new Map()

export function resetHubMeasure() {
  measured = new Map()
}

function emWidth(text, font, ls) {
  const key = font + '|' + ls + '|' + text
  let v = measured.get(key)
  if (v === undefined) {
    canvas = canvas || document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = font
    if (!ctx.font.includes('100px')) ctx.font = '700 100px sans-serif'
    if ('letterSpacing' in ctx) ctx.letterSpacing = ls * 100 + 'px'
    v = ctx.measureText(text).width / 100
    measured.set(key, v)
  }
  return v
}

const px = (v) => parseFloat(v) || 0
const fontOf = (cs) => `${cs.fontWeight} 100px ${cs.fontFamily}`
const letterEm = (cs) => (cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing) / (px(cs.fontSize) || 1))
const words = (text) => text.split(' ').filter(Boolean)

// Место под текст в плитке: без полей. clientWidth не зависит от нажатия (scale у :active)
function inner(el) {
  const cs = getComputedStyle(el)
  return {
    w: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
    h: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    left: px(cs.paddingLeft),
  }
}

// Посчитать и поставить размеры на сетку .hub-grid
export function fitHub(grid) {
  const all = [...grid.querySelectorAll('.hub-tile')]
  const plain = all.filter((t) => !t.classList.contains('wide'))
  if (!plain.length) return null
  const box = inner(plain[0])
  if (box.w <= 0 || box.h <= 0) return null
  const ncs = getComputedStyle(plain[0].querySelector('.hub-name'))
  const font = fontOf(ncs)
  const ls = letterEm(ncs)
  const tiles = plain.map((t) => {
    const badge = t.querySelector('.hub-badge')
    return {
      words: words(t.querySelector('.hub-label')?.textContent || '').map((x) => emWidth(x, font, ls)),
      badgeEm: badge ? emWidth(badge.textContent, fontOf(getComputedStyle(badge)), 0) : null,
    }
  })

  let gold = null
  const goldTile = all.find((t) => t.classList.contains('gold'))
  if (goldTile) {
    const gb = inner(goldTile)
    const gcs = getComputedStyle(goldTile.querySelector('.hub-name'))
    const gfont = fontOf(gcs)
    const gls = letterEm(gcs)
    const pic = goldTile.querySelector('.hub-pic')
    // левее тележки, с зазором; offsetLeft не зависит от покачивания картинки при наведении
    const right = pic && pic.offsetWidth > 0 ? pic.offsetLeft - 12 : gb.left + gb.w
    let text = goldTile.querySelector('.hub-label')?.textContent || ''
    if (gcs.textTransform === 'uppercase') text = text.toUpperCase()
    gold = { w: right - gb.left, h: gb.h, words: words(text).map((x) => emWidth(x, gfont, gls)), space: emWidth(' ', gfont, gls) }
  }

  const r = hubSizes({ box, tiles, space: emWidth(' ', font, ls), gold })
  const vars = {
    '--hub-fs': r.fs + 'px',
    '--hub-fs-gold': r.gold + 'px',
    '--hub-bh': r.badge.bh + 'px',
    '--hub-bfs': r.badge.bfs + 'px',
    '--hub-bpad': r.badge.pad + 'px',
    '--hub-bmt': r.badge.mt + 'px',
    '--hub-bgap': r.badge.gap + 'px',
    '--hub-lock': Math.max(14, Math.round(r.fs * 0.6)) + 'px',
  }
  for (const [k, v] of Object.entries(vars)) if (grid.style.getPropertyValue(k) !== v) grid.style.setProperty(k, v)
  return r
}
