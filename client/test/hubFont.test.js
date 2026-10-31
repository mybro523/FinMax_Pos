// ── Надписи на плитках главного меню (31.10.2026) ──
//
// Владелец: надписи как можно крупнее, слово целиком (не влезает — переходит на следующую
// строку), у всех плиток один размер, растут вместе с экраном; «КАССА» — в полтора раза
// крупнее; цифра в углу на надпись не налезает. Ширины слов — в em шрифта Inter 700 с
// интервалом −0,02 em, мерены на странице (canvas и страница сходятся до 0,1 %).
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { hubSizes, lineCount, badgeGeom, badgeWidth, LINE, FILL, GOLD, MIN_FS } from '../src/lib/hubFont.js'

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

test('самое длинное слово («Инвентаризация») помещается в плитку целиком — и это самый крупный такой размер', () => {
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: null })
  assert.ok(INV * r.fs <= BOX.w, `слово ${INV * r.fs} px шире плитки ${BOX.w} px`)
  assert.ok(INV * (r.fs + 0.5) > BOX.w * SAFE, 'размер не самый крупный из возможных')
  assert.ok(r.fs >= 25 && r.fs <= 26, `на экране владельца надпись около 25 px, а не ${r.fs}`)
  for (const t of RU) assert.notEqual(lineCount(t.words, SPACE, r.fs, BOX.w * SAFE, fltFor(t, r.fs)), Infinity, 'какое-то слово рвётся')
})

test('длинное название уходит на вторую строку целыми словами и не выше доли плитки', () => {
  const r = hubSizes({ box: BOX, tiles: RU, space: SPACE, gold: null })
  for (const t of RU) {
    const n = lineCount(t.words, SPACE, r.fs, BOX.w * SAFE, fltFor(t, r.fs))
    assert.ok(n >= 1 && n <= 2, `строк ${n}`)
    assert.ok(n * r.fs * LINE <= BOX.h * FILL + 1e-9, 'надпись выше допустимого')
  }
  // «Панель управления» в одну строку не влезает → две строки
  assert.equal(lineCount([3.62, 5.83], SPACE, r.fs, BOX.w * SAFE, null), 2)
})

test('надпись растёт и уменьшается вместе с плиткой — на любом экране та же пропорция', () => {
  const sizes = [
    { w: 128, h: 116 }, // 1024×768
    { w: 185, h: 116 }, // 1366×768
    { w: 212, h: 120 }, // 1526 (владелец)
    { w: 275, h: 195 }, // 1920×1080
  ].map((box) => ({ box, fs: hubSizes({ box, tiles: RU, space: SPACE, gold: null }).fs }))
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i].fs > sizes[i - 1].fs, 'на большем экране надпись не крупнее')
  for (const s of sizes) {
    const share = (INV * s.fs) / s.box.w // доля ширины плитки под самым длинным словом
    assert.ok(share > 0.95 && share <= 1, `пропорция ${share.toFixed(3)} при ${s.box.w} px`)
  }
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
  assert.ok(r.fs < noBadge.fs, 'с цифрой размер должен был уменьшиться')
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
  assert.ok(r.fs < (box.w * SAFE) / INV, 'размер должна была ограничить высота')
})

test('крошечное окно: не мельче нижней границы', () => {
  const r = hubSizes({ box: { w: 40, h: 30 }, tiles: RU, space: SPACE, gold: KASSA(30, 30) })
  assert.equal(r.fs, MIN_FS)
  assert.equal(r.gold, MIN_FS)
})
