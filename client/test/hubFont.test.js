// ── Надписи на плитках главного меню (31.10.2026) ──
//
// Владелец: надписи как можно крупнее, слово целиком (не влезает — переходит на следующую
// строку), у всех плиток один размер, растут вместе с экраном; «КАССА» — в полтора раза
// крупнее; цифра в углу на надпись не налезает. 1.5.10: «чуть-чуть меньше» — на 15 % мельче
// самого крупного размера, но не мельче 11 px, если столько помещается. Ширины слов — в em
// шрифта Inter 700 с интервалом −0,02 em, мерены на странице (canvas и страница сходятся до 0,1 %).
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { hubSizes, lineCount, badgeGeom, badgeWidth, LINE, FILL, GOLD, MIN_FS, SCALE, READABLE } from '../src/lib/hubFont.js'

const SAFE = 0.99 // как в hubFont.js
const SPACE = 0.217
const INV = 8.18 // «Инвентаризация» — самое длинное русское слово
const tile = (words, badgeEm = null) => ({ words, badgeEm })
const RU = [
  tile([3.62, 5.83]), // Панель управления
  tile([3.25, 3.05]), // Смена кассы
  tile([3.07, 4.54]), // Долги клиентов
  tile([4.14, 3.51]), // История скидок
  tile([6.35, 5.67], 0.43), // Отложенные штрихкоды + значок «1»
  tile([2.89, 4.44]), // Отчёт продажи
  tile([INV]), // Инвентаризация
  tile([2.49, 4.51], 0.65), // Срок годности + значок «3»
  tile([2.89, 6.51]), // Отчёт поставщиков
  tile([5.33]), // Настройки
]
const KASSA = (w, h) => ({ w, h, words: [3.6], space: SPACE })
// Плитка на экране владельца (окно 1526 px): 238×146, поля 14/12/12 и рамка → место 212×120
const BOX = { w: 212, h: 120 }
const fltFor = (t, fs) => {
  const g = badgeGeom(fs)
  return t.badgeEm == null ? null : { w: badgeWidth(g, t.badgeEm) + g.gap, bottom: g.mt + g.bh }
}
// 1.5.10: на 15 % мельче самого крупного, шагом 0,5 px, но не мельче 11 px, если столько помещается
const smaller = (max) => Math.max(Math.floor((max * 0.85) / 0.5) * 0.5, Math.min(max, 11))

test('самый крупный размер: самое длинное слово («Инвентаризация») во всю ширину плитки', () => {
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: null })
  assert.ok(INV * r.max <= BOX.w, `слово ${INV * r.max} px шире плитки ${BOX.w} px`)
  assert.ok(INV * (r.max + 0.5) > BOX.w * SAFE, 'размер не самый крупный из возможных')
  assert.ok(r.max >= 25 && r.max <= 26, `самый крупный на экране владельца — около 25,5 px (как в 1.5.9), а не ${r.max}`)
})

test('1.5.10: надпись на 15 % мельче самого крупного — на экране владельца около 21,5 px', () => {
  assert.equal(SCALE, 0.85)
  assert.equal(READABLE, 11)
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: KASSA(300, 120) })
  assert.equal(r.fs, smaller(r.max))
  assert.equal(r.fs, 21.5, `на экране владельца ${r.fs} px вместо 21,5`)
  const share = (INV * r.fs) / BOX.w
  assert.ok(share > 0.8 && share <= 0.85, `«Инвентаризация» занимает ${share.toFixed(3)} ширины, а не ~0,84`)
  for (const t of RU) assert.notEqual(lineCount(t.words, SPACE, r.fs, BOX.w * SAFE, fltFor(t, r.fs)), Infinity, 'какое-то слово рвётся')
  // «КАССА» уменьшилась вместе со всеми и осталась в 1,5 раза крупнее: 32 px вместо 38
  assert.equal(r.gold, Math.floor((r.fs * GOLD) / 0.5) * 0.5)
  assert.equal(r.gold, 32)
})

test('длинное название уходит на вторую строку целыми словами и не выше доли плитки', () => {
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: null })
  for (const t of RU) {
    const n = lineCount(t.words, SPACE, r.fs, BOX.w * SAFE, fltFor(t, r.fs))
    assert.ok(n >= 1 && n <= 2, `строк ${n}`)
    assert.ok(n * r.fs * LINE <= BOX.h * FILL + 1e-9, 'надпись выше допустимого')
  }
  // «Отложенные штрихкоды» в одну строку не влезает → две строки; «Панель управления» при
  // уменьшенном на 15 % размере (1.5.10) встаёт в одну
  assert.equal(lineCount([6.35, 5.67], SPACE, r.fs, BOX.w * SAFE, null), 2)
  assert.equal(lineCount([3.62, 5.83], SPACE, r.fs, BOX.w * SAFE, null), 1)
})

test('надпись растёт и уменьшается вместе с плиткой — на любом экране та же пропорция', () => {
  const sizes = [
    { w: 128, h: 116 }, // 1024×768
    { w: 185, h: 116 }, // 1366×768
    { w: 212, h: 120 }, // 1526 (владелец)
    { w: 275, h: 195 }, // 1920×1080
  ].map((box) => ({ box, ...hubSizes({ box, tiles: RU, space: SPACE, gold: null }) }))
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i].fs > sizes[i - 1].fs, 'на большем экране надпись не крупнее')
  for (const s of sizes) {
    // самый крупный — во всю ширину; надпись — на 15 % мельче (шаг 0,5 px чуть сдвигает долю)
    const most = (INV * s.max) / s.box.w
    assert.ok(most > 0.95 && most <= 1, `самый крупный: доля ${most.toFixed(3)} при ${s.box.w} px`)
    assert.equal(s.fs, smaller(s.max), `при ${s.box.w} px надпись ${s.fs} px, а самый крупный ${s.max}`)
    const share = (INV * s.fs) / s.box.w
    assert.ok(share > 0.77 && share <= 0.85, `пропорция ${share.toFixed(3)} при ${s.box.w} px`)
  }
})

test('узкий экран (планшет стоя): уменьшение не делает надпись мельче 11 px', () => {
  // место 102,7 px, как на экране 800×1280: самый крупный 11 px (рядом с цифрой) — его и оставляем
  const narrow = hubSizes({ box: { w: 102.7, h: 256 }, tiles: RU, space: SPACE, gold: null })
  assert.equal(narrow.max, 11)
  assert.equal(narrow.fs, 11)
  // самый крупный 12 px: на 15 % мельче было бы 10 px — встаёт 11
  const tiles = [tile([INV])]
  const w12 = hubSizes({ box: { w: (INV * 12.2) / 0.99, h: 256 }, tiles, space: SPACE, gold: null })
  assert.equal(w12.max, 12)
  assert.equal(w12.fs, READABLE)
  // самый крупный и так меньше 11 px — не уменьшаем вовсе
  const w10 = hubSizes({ box: { w: (INV * 10.2) / 0.99, h: 256 }, tiles, space: SPACE, gold: null })
  assert.equal(w10.max, 10)
  assert.equal(w10.fs, 10)
})

test('«КАССА» — в полтора раза крупнее остальных, если помещается левее тележки', () => {
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: KASSA(300, 120) })
  assert.equal(r.gold, Math.floor((r.fs * GOLD) / 0.5) * 0.5)
  // тесно (узкое окно): «КАССА» меньше, но целиком левее тележки
  const tight = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: KASSA(110, 120) })
  assert.ok(tight.gold < tight.fs * GOLD)
  assert.ok(3.6 * tight.gold <= 110, '«КАССА» налезла на тележку')
})

test('цифра в углу не налезает на надпись: первое слово стоит рядом с ней целиком', () => {
  // Широкое первое слово + трёхзначное число: при самом крупном размере не влезло бы рядом
  // с цифрой — размер уменьшается, а не опускает слово под цифру
  const tiles = [tile([7.6, 3.0], 1.9), tile([INV])]
  const r = hubSizes({ box: BOX, tiles, space: SPACE, gold: null })
  const g = badgeGeom(r.fs)
  const room = BOX.w * SAFE - (badgeWidth(g, 1.9) + g.gap)
  assert.ok(7.6 * r.fs <= room, 'первое слово не помещается рядом с цифрой')
  const noBadge = hubSizes({ box: BOX, tiles: [tile([7.6, 3.0]), tile([INV])], space: SPACE, gold: null })
  assert.ok(r.max < noBadge.max && r.fs < noBadge.fs, 'с цифрой размер должен был уменьшиться')
  assert.equal(r.fs, smaller(r.max))
})

test('значок высокий (мелкий экран) — обтекание и во второй строке', () => {
  // 16 px: строка 18,4 px, значок 24 px — он закрывает и начало второй строки
  const g = badgeGeom(16)
  assert.equal(g.bh, 24)
  assert.equal(g.mt, 0)
  const flt = { w: 40, bottom: g.mt + g.bh }
  // вторая строка при обтекании уже: слово 6 em (96 px) не встаёт в 100 − 40 px
  assert.equal(lineCount([1, 6], 0.27, 16, 100, flt), Infinity)
  assert.equal(lineCount([1, 6], 0.27, 16, 100, null), 2)
})

test('низкая плитка: надпись ограничена высотой, а не шириной', () => {
  const box = { w: 380, h: 60 }
  const r = hubSizes({ box, tiles: RU, space: SPACE, gold: null })
  const most = Math.max(...RU.map((t) => lineCount(t.words, SPACE, r.fs, box.w * SAFE, fltFor(t, r.fs))))
  assert.ok(most * r.fs * LINE <= box.h * FILL + 1e-9, 'надпись выше допустимого')
  assert.ok(r.max < (box.w * SAFE) / INV, 'размер должна была ограничить высота')
  assert.equal(r.fs, smaller(r.max))
})

test('уменьшенный размер проверяется заново: слово рядом с цифрой не опускается под неё', () => {
  // Плитка ~100 px, цифра «120»: значок не мельче 24 px и не уменьшается вместе с надписью
  const box = { w: 100, h: 200 }
  const tiles = [tile([6.0, 2.0], 1.9), tile([7.0])]
  const r = hubSizes({ box, tiles, space: SPACE, gold: null })
  assert.ok(r.fs <= r.max)
  for (const t of tiles) assert.notEqual(lineCount(t.words, SPACE, r.fs, box.w * SAFE, fltFor(t, r.fs)), Infinity, 'слово не встаёт рядом с цифрой')
})

test('крошечное окно: не мельче нижней границы', () => {
  const r = hubSizes({ box: { w: 40, h: 30 }, tiles: RU, space: SPACE, gold: KASSA(30, 30) })
  assert.equal(r.max, MIN_FS)
  assert.equal(r.fs, MIN_FS)
  assert.equal(r.gold, MIN_FS)
})
