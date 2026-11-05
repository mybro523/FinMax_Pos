// ── Логотип магазина на чековой ленте (print/logo.mjs, 1.6.4) ──
//
// Чековый принтер печатает только чёрные точки: логотип вписывается в ленту, становится
// чёрно-белым (бледный — вытягивается по яркости, полутона — рассеиванием точек) и уходит
// командой «растр» (GS v 0) над полосой с названием магазина.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanLogo, LOGO_GAMMA, LOGO_MAX_CHARS, logoTarget, monoToBgra, paperDots, rasterBytes, toMono } from '../src/print/logo.mjs'
import { renderTicket } from '../src/print/escpos.mjs'
import { screenLogo, sanitizeScreenState } from '../src/customer-screen.mjs'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('годится только картинка data URL PNG или JPEG и не тяжелее 300 КБ', () => {
  assert.equal(cleanLogo(PNG), PNG)
  assert.equal(cleanLogo('data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ')
  // WebP Electron (nativeImage) не раскрывает ни в 44-й, ни в 22-й — такого логотипа «нет»
  assert.equal(cleanLogo('data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='), '')
  for (const bad of ['', null, 7, 'https://example.com/logo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,abc"onerror="x', 'javascript:alert(1)']) {
    assert.equal(cleanLogo(bad), '', String(bad))
  }
  assert.equal(cleanLogo('data:image/png;base64,' + 'A'.repeat(LOGO_MAX_CHARS)), '', 'слишком тяжёлая — как «логотипа нет»')
  // Экран покупателя пропускает то же самое
  assert.equal(screenLogo(PNG), PNG)
  assert.equal(screenLogo('data:text/html;base64,PGI+'), '')
  // Окно кассы логотип не присылает — его добавляет основная часть программы
  assert.equal('logo' in sanitizeScreenState({ mode: 'idle', shop: 'Шифо', logo: PNG }), false)
})

test('ширина ленты в точках и размер логотипа на ней', () => {
  assert.deepEqual([paperDots(32), paperDots(42), paperDots(48), paperDots('x')], [384, 504, 576, 384])
  // Широкий — на три четверти ленты
  assert.deepEqual(logoTarget(720, 180, 576), { width: 432, height: 108 })
  // Высокий — не выше 160 точек (2 см)
  assert.deepEqual(logoTarget(300, 600, 576), { width: 80, height: 160 })
  // Мелкий — увеличивается не больше чем вдвое
  assert.deepEqual(logoTarget(60, 20, 384), { width: 120, height: 40 })
  assert.deepEqual(logoTarget(0, 0, 384), { width: 2, height: 2 })
})

// Картинка w×h одного цвета (BGRA, как отдаёт Electron)
function solid(w, h, [r, g, b, a = 255]) {
  const px = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) px.set([b, g, r, a], i * 4)
  return px
}
const bitAt = (mono, x, y) => (mono.bits[y * mono.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) !== 0
const blackCount = (mono) => {
  let n = 0
  for (const byte of mono.bits) for (let k = 0; k < 8; k++) n += (byte >> k) & 1
  return n
}

test('чёрное — чёрным, прозрачное — бумагой; логотип по центру ленты', () => {
  const mono = toMono(solid(8, 3, [0, 0, 0]), 8, 3, 16)
  assert.deepEqual([mono.width, mono.height, mono.bytesPerRow], [16, 3, 2])
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 16; x++) assert.equal(bitAt(mono, x, y), x >= 4 && x < 12, `точка ${x},${y}`)
  }
  assert.equal(blackCount(toMono(solid(10, 10, [0, 0, 0, 0]), 10, 10, 16)), 0, 'прозрачное не печатается')
  assert.equal(blackCount(toMono(solid(10, 10, [255, 255, 255]), 10, 10, 16)), 0, 'белое не печатается')
})

test('бледный логотип вытягивается по яркости: жёлтый печатается чёрным, а не едва заметной сеткой', () => {
  // Золотой FinMax (#EFBD24) на прозрачном
  const w = 20
  const h = 6
  const px = solid(w, h, [0, 0, 0, 0])
  for (let y = 1; y < 5; y++) for (let x = 2; x < 18; x++) px.set([0x24, 0xbd, 0xef, 255], (y * w + x) * 4)
  const mono = toMono(px, w, h, 24)
  const x0 = (24 - w) / 2
  for (let y = 1; y < 5; y++) for (let x = 2; x < 18; x++) assert.ok(bitAt(mono, x0 + x, y), `жёлтая точка ${x},${y} не напечаталась`)
  assert.equal(bitAt(mono, x0, 0), false, 'поле вокруг осталось бумагой')
})

test('полутона — рассеиванием точек: светло-серый — частью точек; середина плотнее (гамма 2,2)', () => {
  // Слева чёрное, справа светло-серое: «чернила» тёмные, серое остаётся полутоном
  const w = 40
  const h = 20
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.set(x < 10 ? [0, 0, 0, 255] : [200, 200, 200, 255], (y * w + x) * 4)
  }
  const grayShare = (mono) => {
    let n = 0
    for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) n += bitAt(mono, x, y) ? 1 : 0
    return n / ((w - 10) * h)
  }
  assert.equal(LOGO_GAMMA, 2.2)
  const dense = grayShare(toMono(px, w, h, 40))
  const flat = grayShare(toMono(px, w, h, 40, { gamma: 1 }))
  assert.ok(dense > 0.2 && dense < 0.8, `доля чёрных точек в сером ${dense.toFixed(2)}`)
  assert.ok(dense > flat + 0.1, `с гаммой серое плотнее: ${dense.toFixed(2)} против ${flat.toFixed(2)}`)
})

test('умноженная прозрачность (nativeImage.toBitmap): полупрозрачное белое — бумага, а не чёрное пятно', () => {
  // Electron 44 и 22 отдают белую точку с прозрачностью 128 как 128,128,128,128 (BGRA, умноженная)
  const half = (px) => {
    const out = new Uint8Array(20 * 20 * 4)
    for (let i = 0; i < 400; i++) out.set(px, i * 4)
    return out
  }
  // Чёрная полоса слева — «чернила» логотипа, справа — полупрозрачное белое (ореол, тень)
  const withInk = (fill) => {
    const px = half(fill)
    for (let y = 0; y < 20; y++) for (let x = 0; x < 4; x++) px.set([0, 0, 0, 255], (y * 20 + x) * 4)
    return px
  }
  const right = (mono) => {
    let n = 0
    for (let y = 0; y < 20; y++) for (let x = 6; x < 20; x++) n += bitAt(mono, x, y) ? 1 : 0
    return n
  }
  assert.equal(right(toMono(withInk([128, 128, 128, 128]), 20, 20, 20, { premultiplied: true })), 0, 'умноженная: полупрозрачное белое не печатается')
  assert.equal(right(toMono(withInk([255, 255, 255, 128]), 20, 20, 20)), 0, 'обычная: то же самое')
  // Без учёта умножения то же белое стало бы серым и напечаталось бы сеткой — так и было
  assert.ok(right(toMono(withInk([128, 128, 128, 128]), 20, 20, 20)) > 50, 'проверка ловит прежнюю ошибку')
  // Полупрозрачное золото (#EFBD24, прозрачность 128) рядом с чёрными «чернилами»: обычное
  // (BGRA 24,BD,EF,128) и умноженное (так его отдаёт Electron: 18,95,120,128) — одна яркость,
  // поэтому и точек столько же (до округления)
  const straight = toMono(withInk([0x24, 0xbd, 0xef, 128]), 20, 20, 20)
  const premul = toMono(withInk([18, 95, 120, 128]), 20, 20, 20, { premultiplied: true })
  const a = right(straight)
  const b = right(premul)
  assert.ok(a > 5 && a < 14 * 20 - 5, `золото — полутоном, а не пусто и не сплошь (${a} точек)`)
  assert.ok(Math.abs(a - b) <= 6, `обычное ${a} и умноженное ${b} — почти одинаково`)
})

test('команда принтеру: GS v 0, ширина в байтах и высота в точках', () => {
  const mono = toMono(solid(8, 2, [0, 0, 0]), 8, 2, 576)
  const bytes = rasterBytes(mono)
  assert.deepEqual([...bytes.subarray(0, 8)], [0x1d, 0x76, 0x30, 0x00, 72, 0, 2, 0])
  assert.equal(bytes.length, 8 + 72 * 2)
  // Предпросмотр — та же полоса картинкой: чёрное там, где принтер поставит точку
  const bgra = monoToBgra(mono)
  assert.equal(bgra.length, 576 * 2 * 4)
  const at = (x, y) => [...bgra.subarray((y * 576 + x) * 4, (y * 576 + x) * 4 + 4)]
  assert.deepEqual(at(284, 0), [0, 0, 0, 255])
  assert.deepEqual(at(0, 0), [255, 255, 255, 255])
})

const ticket = {
  head: ['Шифо', 'Чек № 1'],
  docAt: 1,
  rows: [{ name: 'Хлеб', sub: '1 шт × 5', value: '5 сомони' }],
  totals: [{ label: 'Итого', value: '5 сомони', big: true }],
  tail: ['Кассир: Нилуфар', 'Шифо', 'www.finmaxpos.tj'],
  signAt: 1,
  siteAt: 2,
}
const indexOf = (buf, seq) => {
  for (let i = 0; i + seq.length <= buf.length; i++) if (seq.every((b, k) => buf[i + k] === b)) return i
  return -1
}

test('лента: логотип — над полосой с названием; без логотипа — чек как прежде', () => {
  const plain = renderTicket(ticket, { width: 32 })
  assert.equal(indexOf(plain, [0x1d, 0x76, 0x30]), -1, 'без логотипа растра нет')
  const mono = toMono(solid(40, 10, [0, 0, 0]), 40, 10, 384)
  const withLogo = renderTicket(ticket, { width: 32, logo: mono })
  const raster = indexOf(withLogo, [0x1d, 0x76, 0x30, 0x00, 48, 0, 10, 0])
  const band = indexOf(withLogo, [0x1d, 0x42, 1]) // белым по чёрному — полоса с названием
  assert.ok(raster > 0 && band > raster, 'логотип — первым, над полосой')
  // После картинки — просвет 16 точек и снова выравнивание влево
  assert.deepEqual([...withLogo.subarray(raster + 8 + 48 * 10, raster + 8 + 48 * 10 + 6)], [0x1b, 0x4a, 16, 0x1b, 0x61, 0])
  // Всё остальное — байт в байт как без логотипа
  assert.deepEqual(withLogo.subarray(withLogo.length - (plain.length - 7)), plain.subarray(7))
  // Испорченная полоса (байтов меньше, чем строк × ширина) — без логотипа, а не мусор на бумаге
  const broken = renderTicket(ticket, { width: 32, logo: { ...mono, bits: mono.bits.subarray(1) } })
  assert.deepEqual(broken, plain)
  // Сайт внизу — обычной строкой по центру
  assert.ok(indexOf(plain, [...Buffer.from('www.finmaxpos.tj')]) > 0)
})
