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
//
// 1.6.4 (владелец 01.11: «сделай шрифт ещё меньше», кнопкой — 16,5 px): SCALE 0,65 — на его
// экране 1536×864 надписи 16,5 px вместо 21,5, «КАССА» 24,5 вместо 32; на других экранах — так же
// на четверть мельче прежнего (1366×768 — 14, 1920×1080 — 21, 1024×768 — 11).
//
// 17.11.2026 (владелец: «сайт — точь-в-точь как программа: без прокрутки, шрифт такой же
// большой»). Программа открыта на весь экран, а у сайта высоту окна забирают вкладки и адресная
// строка браузера, панель задач Windows и полосы над шапкой («чужой магазин», «нет связи»):
// плитки на сайте ниже, и надпись, посчитанная от высоты плитки, выходила мельче (на экране
// 1536×864 — 12 px вместо 17). Теперь размер считается от плитки, какой она была бы в программе
// на весь экран этого монитора при «Размере шрифта системы» 100 % (box), а в настоящей плитке
// (real) надпись проверяется заново: не выше FILL её высоты. «Размер шрифта системы» (zoom)
// увеличивает такую надпись вместе со всем остальным — пока она встаёт в плитку. Картинка — как
// в программе, если встаёт рядом с надписью и цифрой в углу, иначе сколько встаёт, но не меньше
// прежней (половина плитки). В программе на весь экран при 100 % box и real совпадают — там всё
// как было.

import { shrift } from './shrift.js'

export const LINE = 1.15 // высота строки надписи — как line-height в index.css
export const FILL = 0.6 // надпись обычной плитки — не выше этой доли её высоты
export const FILL_GOLD = 0.75 // «КАССА» — одна строка, ей можно выше
export const GOLD = 1.5 // «КАССА» крупнее остальных надписей во столько раз
// мельче надпись не бывает даже в крошечном окне; 9 — чтобы и на планшете стоя (плитка ~100 px)
// таджикское «Таъминкунандагон» встало целиком
export const MIN_FS = 9
export const SCALE = 0.65 // доля самого крупного размера (1.5.10: 0,85; 1.6.4: 0,65 — ещё на четверть мельче)
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
  const lines = lineWidths(words, space, fs, w, flt)
  return lines ? lines.length : Infinity
}

// То же разбиение по строкам, но ответ — ширина каждой строки в px (null — слово не встаёт).
// По ширинам видно, доходит ли строка до картинки в правом нижнем углу
export function lineWidths(words, space, fs, w, flt) {
  const lineH = fs * LINE
  const out = []
  let i = 0
  while (i < words.length) {
    const avail = w - (flt && out.length * lineH < flt.bottom ? flt.w : 0)
    let used = words[i] * fs
    if (used > avail) return null
    i++
    while (i < words.length && used + (space + words[i]) * fs <= avail) {
      used += (space + words[i]) * fs
      i++
    }
    out.push(used)
  }
  return out
}

// ── Картинка плитки рядом с надписью ──
// Картинка стоит в правом нижнем углу (index.css: right 5 %, bottom 5 % от плитки без рамки).
// Она не должна заходить на строку надписи или на цифру в углу: зазор PIC_GAP. Строка левее
// картинки ей не мешает, даже если она ниже верха картинки.
const PIC_EDGE = 0.05
const PIC_GAP = 4
//   g — плитка: { cw, ch } (без рамки), { pt, px } — поля, w — ширина под надпись;
//   badges — false: цифру в углу не проверять (только строки надписи)
export function picClear(tiles, space, fs, w, g, p, badges = true) {
  const right = g.cw * (1 - PIC_EDGE)
  const left = right - p - PIC_GAP
  const top = g.ch * (1 - PIC_EDGE) - p - PIC_GAP
  const lineH = fs * LINE
  const bg = badgeGeom(fs)
  return tiles.every((t) => {
    const bw = t.badgeEm == null ? 0 : badgeWidth(bg, t.badgeEm)
    // цифра в углу — у правого края первой строки
    if (badges && bw && g.pt + bg.mt + bg.bh > top && g.px + g.w > left && g.px + g.w - bw < right + PIC_GAP) return false
    const flt = bw ? { w: bw + bg.gap, bottom: bg.mt + bg.bh } : null
    const lines = lineWidths(t.words, space, fs, w, flt)
    if (!lines) return false
    return lines.every((lw, i) => g.pt + (i + 1) * lineH <= top || g.px + lw <= left)
  })
}

// Самая крупная картинка от pic.max вниз до pic.min, которая не задевает надписи; null — не
// встаёт даже самая маленькая
function bestPic(tiles, space, fs, w, pic, badges = true) {
  for (let p = Math.floor(pic.max); p >= pic.min; p--) if (picClear(tiles, space, fs, w, pic, p, badges)) return p
  return picClear(tiles, space, fs, w, pic, pic.min, badges) ? pic.min : null
}

// Размеры для всей сетки.
//   box   — место под надпись в обычной плитке { w, h }, px;
//   tiles — обычные плитки: [{ words, badgeEm }] (badgeEm — ширина цифр значка в em шрифта
//           значка, null — значка нет);
//   space — ширина пробела в em;
//   gold  — касса { w, h, words, space } (w — ширина левее тележки) или null.
// Ответ: { fs, max, gold, badge } — размер надписей, самый крупный возможный (до уменьшения),
// размер «КАССА», значок (badgeGeom).
// menu — множитель из «Настройки → Шрифт» (1.7.7): 1 — как было; крупнее не выйдет за плитку —
// размер всё равно проверяется (fits)
// real — место под надпись в настоящей плитке, если она не такая, какой была бы в программе на
// весь экран при 100 % (сайт в окне браузера — ниже; «Размер шрифта системы» — меньше или больше):
// размер считается по box, а надпись проверяется по real.
// pic — картинка плитки на сайте (fitHub, только когда real ниже box): { cw, ch, pt, px, w,
// max, min } — плитка без рамки, поля, ширина под надпись, картинка как в программе и
// прежняя. Ответ тогда — ещё и pic, px: самая крупная картинка, что не задевает надписи
export function hubSizes({ box, real = box, tiles, space, gold, menu = 1, pic = null }) {
  const w = box.w * SAFE
  const wr = real.w * SAFE
  const longest = Math.max(1e-6, ...tiles.flatMap((t) => t.words))
  const fitsIn = (bw, h) => (f) => {
    const g = badgeGeom(f)
    return tiles.every((t) => {
      const flt = t.badgeEm == null ? null : { w: badgeWidth(g, t.badgeEm) + g.gap, bottom: g.mt + g.bh }
      return lineCount(t.words, space, f, bw, flt) * f * LINE <= h * FILL
    })
  }
  const fits = fitsIn(w, box.h)
  let max = Math.floor(w / longest / STEP) * STEP
  while (max > MIN_FS && !fits(max)) max -= STEP
  max = Math.max(MIN_FS, max)
  // Доля SCALE от самого крупного, но не мельче READABLE (если столько помещается). Меньший
  // размер проверяется заново: значок в углу не уменьшается вместе с надписью (не мельче 24 px)
  // и при мелкой надписи обтекается ещё и вторая строка
  const want = Math.floor((max * Math.min(1, SCALE * (Number(menu) > 0 ? Number(menu) : 1))) / STEP) * STEP
  let fs = menu < 1 ? Math.max(want, MIN_FS) : Math.max(want, Math.min(max, READABLE))
  // Настоящая плитка другая: надпись должна встать и в неё
  const fitsReal = real.h !== box.h || real.w !== box.w ? fitsIn(wr, real.h) : fits
  while (fs > MIN_FS && !fitsReal(fs)) fs -= STEP
  fs = Math.max(MIN_FS, fs)

  // Картинка как в программе встаёт рядом с надписью? Нет — картинка меньше, но не меньше
  // прежней; не встаёт и прежняя — мельче надпись, но не мельче той, что была бы без расчёта
  // «на весь экран» (по одной настоящей плитке): хуже, чем было, не становится. Цифра в углу
  // (не мельче 24 px при любой надписи) мешает прежней картинке и при мелкой надписи — из-за
  // неё надпись не уменьшается: картинка остаётся прежней, как было до 17.11
  let picPx = null
  if (pic && real.h < box.h) {
    const floor = Math.min(fs, hubSizes({ box: real, tiles, space, gold: null, menu }).fs)
    for (;;) {
      picPx = bestPic(tiles, space, fs, wr, pic)
      if (picPx == null && picClear(tiles, space, fs, wr, pic, pic.min, false)) picPx = pic.min
      if (picPx != null || fs - STEP < floor) break
      fs -= STEP
    }
    if (picPx == null) picPx = pic.min
  }

  let gfs = fs
  if (gold) {
    const gw = gold.w * SAFE
    const ok = (f) => lineCount(gold.words, gold.space, f, gw, null) * f * LINE <= gold.h * FILL_GOLD
    gfs = Math.floor((fs * GOLD) / STEP) * STEP
    while (gfs > MIN_FS && !ok(gfs)) gfs -= STEP
    gfs = Math.max(MIN_FS, gfs)
  }
  return { fs, max, gold: gfs, badge: badgeGeom(fs), pic: picPx }
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

// Место под текст в плитке: без полей. clientWidth не зависит от нажатия (scale у :active).
// cw, ch — вся плитка без рамки (от неё считаются проценты картинки), top — верхнее поле
function inner(el) {
  const cs = getComputedStyle(el)
  return {
    w: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
    h: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    left: px(cs.paddingLeft),
    top: px(cs.paddingTop),
    cw: el.clientWidth,
    ch: el.clientHeight,
  }
}

// Плитка без рамки — точно, с долями пикселя (clientWidth/clientHeight округляют). Плитка —
// border-box (index.css), нажатие (scale) на computed width/height не влияет. Рамка — какой она
// была бы при 100 %: под zoom браузер подгоняет её к точкам экрана (1 px при 120 % — 0,83)
function exactClient(el) {
  const cs = getComputedStyle(el)
  const zoom = zoomOf()
  const b = (v) => (px(v) > 0 ? Math.max(1, Math.round(px(v) * zoom)) : 0)
  const w = px(cs.width) - b(cs.borderLeftWidth) - b(cs.borderRightWidth)
  const h = px(cs.height) - b(cs.borderTopWidth) - b(cs.borderBottomWidth)
  return { w: w > 0 ? w : el.clientWidth, h: h > 0 ? h : el.clientHeight }
}

// Картинки плиток — те же числа, что в index.css («Главный экран: плитки разделов»): обычная —
// половина плитки, не больше 108 px; у кассы — 76 %, не больше 132 px, 6 % от низа
const PIC = 0.5
const PIC_MAX = 108
const GOLD_PIC = 0.76
const GOLD_PIC_MAX = 132
const GOLD_PIC_EDGE = 0.06

// ── Чем окно отличается от программы на весь экран при 100 % ──
// Программа открыта на весь экран; сайт — в окне браузера, и вкладки, адресная строка, панель
// задач Windows забирают у него высоту. Полосы над шапкой («чужой магазин», «нет связи») — тоже
// не высота меню: в программе их нет. «Настройки → Шрифт → Размер шрифта системы» — zoom у
// <html>: при 120 % в окно входит на шестую часть меньше px страницы, при 80 % — больше.
// Ответ — { h, w } в px страницы: на сколько окно на весь экран при 100 % выше и шире нынешнего
// (при 80 % — меньше нуля). Ряды тянутся под окно только на экране шире телефона и выше 520 px
// (index.css) — иначе ноль. Меньше SCREEN_SLACK — ноль: программа на весь экран при 100 %
// (расхождение в пиксель от округления не трогает её вида)
const SCREEN_SLACK = 4
const zoomOf = () => Number(document.documentElement.style.zoom) || 1
export function screenGap(grid) {
  const none = { h: 0, w: 0 }
  if (typeof window === 'undefined' || !window.screen) return none
  if (!window.matchMedia?.('(min-width: 601px) and (min-height: 521px)').matches) return none
  const s = window.screen
  // планшет повернули: у некоторых браузеров screen не поворачивается вместе с окном
  const sh = (window.innerWidth >= window.innerHeight) === (s.width >= s.height) ? s.height : s.width
  const zoom = zoomOf()
  // окно ниже экрана (браузер) — недостающее; выше не бывает
  let h = Math.max(0, sh - window.innerHeight) + window.innerHeight * (1 - 1 / zoom)
  const top = grid.closest('.main')?.querySelector(':scope > .topbar')
  for (let el = top?.previousElementSibling; el; el = el.previousElementSibling) h += el.offsetHeight
  const w = window.innerWidth * (1 - 1 / zoom)
  return { h: Math.abs(h) >= SCREEN_SLACK ? h : 0, w: Math.abs(w) >= SCREEN_SLACK ? w : 0 }
}

const setVar = (el, k, v) => {
  if (v == null) {
    if (el.style.getPropertyValue(k)) el.style.removeProperty(k)
  } else if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v)
}

// Посчитать и поставить размеры на сетку .hub-grid
export function fitHub(grid) {
  const all = [...grid.querySelectorAll('.hub-tile')]
  const plain = all.filter((t) => !t.classList.contains('wide'))
  if (!plain.length) return null
  const box = inner(plain[0])
  if (box.w <= 0 || box.h <= 0) return null
  // Плитка программы на весь экран при 100 % — выше (шире) настоящей на долю разницы: ряды и
  // колонки сетки делят её поровну (1fr), шапка, полоса внизу, поля и зазоры — те же px
  // страницы. clientHeight — целое: программа видит свою плитку округлённой, поэтому и здесь
  // округляется точный размер плитки вместе с добавкой — иначе расхождение в долю пикселя меняло
  // бы размер надписи на полшага
  const gridCs = getComputedStyle(grid)
  const rows = gridCs.gridTemplateRows.split(' ').filter(Boolean).length || 1
  const cols = gridCs.gridTemplateColumns.split(' ').filter(Boolean).length || 1
  const gap = screenGap(grid)
  const extra = gap.h / rows
  const extraW = gap.w / cols
  const exact = exactClient(plain[0])
  const ch = exact.h
  const full = {
    w: extraW ? Math.round(exact.w + extraW) - (box.cw - box.w) : box.w,
    h: extra ? Math.round(ch + extra) - (box.ch - box.h) : box.h,
  }
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
    // Тележка на сайте — как в программе (76 % плитки на весь экран, не больше 132 px), если
    // встаёт ниже верхнего поля; не меньше прежней. Ставится до мерки: «КАССА» стоит левее неё
    let gp = null
    if (extra > 0) {
      const gch = exactClient(goldTile).h
      const was = Math.min(GOLD_PIC * gch, GOLD_PIC_MAX)
      const app = Math.min(GOLD_PIC * (gch + extra), GOLD_PIC_MAX)
      gp = Math.floor(Math.max(was, Math.min(app, gch * (1 - GOLD_PIC_EDGE) - gb.top))) + 'px'
    }
    setVar(grid, '--hub-pic-gold', gp)
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

  // Картинка обычной плитки: на весь экран — половина плитки, не больше 108 px (index.css)
  const picBox = extra > 0
    ? {
        cw: box.cw,
        ch,
        pt: box.top,
        px: box.left,
        w: box.w,
        max: Math.min(PIC * (ch + extra), PIC_MAX),
        min: Math.min(PIC * ch, PIC_MAX),
      }
    : null
  const r = hubSizes({ box: full, real: box, tiles, space: emWidth(' ', font, ls), gold, menu: shrift().menu / 100, pic: picBox })
  setVar(grid, '--hub-pic', r.pic == null ? null : r.pic + 'px')
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
