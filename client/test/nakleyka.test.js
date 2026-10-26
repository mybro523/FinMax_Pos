// ── Наклейка для принтера этикеток: размеры, раскладка, сколько наклеек ──
// Наклейка — страница ровно её размера. Если раскладка ошибётся, полоски вылезут за
// край или название наедет на код — на бумаге это брак, а сканер не прочтёт код.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  wrapLines,
  DEFAULT_SIZE,
  MAX_TOTAL,
  MM_PER_PT,
  NAKLEYKA_SIZES,
  copiesOf,
  fitText,
  nakleekNaStroku,
  nakleykaName,
  nakleykaPlan,
  razvernut,
  sizeId,
  sizeOf,
  sizeText,
  totalOf,
} from '../src/lib/nakleyka.js'

test('размеры: ходовые узнаются, свой — в пределах и с точностью до полмиллиметра', () => {
  assert.deepEqual(NAKLEYKA_SIZES.map((s) => s.id), ['58x40', '58x30', '40x30', '30x20'])
  assert.equal(sizeId({ w: 40, h: 30 }), '40x30')
  assert.equal(sizeId({ w: '58', h: '40' }), '58x40')
  assert.equal(sizeId({ w: 43, h: 25 }), 'custom')
  assert.deepEqual(sizeOf({ w: '43,2', h: 25.3 }), { w: 43, h: 25.5 })
  // За пределами — к ближайшему краю; мусор — размер по умолчанию
  assert.deepEqual(sizeOf({ w: 500, h: 5 }), { w: 110, h: 20 })
  assert.deepEqual(sizeOf({ w: 'много', h: 30 }), DEFAULT_SIZE)
  assert.deepEqual(sizeOf(null), DEFAULT_SIZE)
  assert.equal(sizeText({ w: 58, h: 40 }), '58×40 мм')
  assert.equal(sizeText({ w: 43.5, h: 25 }), '43,5×25 мм')
})

test('название на наклейке — с дозировкой, без лишних пробелов', () => {
  assert.equal(nakleykaName({ name: 'Нурофен', dosage: '200 мг' }), 'Нурофен 200 мг')
  assert.equal(nakleykaName({ name: '  Мука   высший сорт ' }), 'Мука высший сорт')
  assert.equal(nakleykaName({}), '')
})

test('строки: перенос по словам, длинное слово — по буквам, лишнее — многоточием в последней', () => {
  const m = (t, pt) => t.length * pt * 0.5 // «буква» шириной в полкегля
  assert.deepEqual(wrapLines('раз два три', { pt: 2, widthMm: 7, measure: m }).lines, ['раз два', 'три'])
  assert.deepEqual(wrapLines('абвгдеёжзий', { pt: 2, widthMm: 4, measure: m }).lines, ['абвг', 'деёж', 'зий'])
  const cut = wrapLines('раз два три четыре', { pt: 2, widthMm: 7, maxLines: 2, measure: m })
  assert.equal(cut.cut, true)
  assert.equal(cut.lines.length, 2)
  assert.ok(cut.lines[1].endsWith('…') && m(cut.lines[1], 2) <= 7, cut.lines[1])
  assert.deepEqual(wrapLines('  ', { pt: 2, widthMm: 7, measure: m }), { lines: [], cut: false })
})

test('подбор кегля: короткое — крупно в одну строку, длинное — мельче в две, совсем длинное — обрезается', () => {
  const short = fitText('Хлеб', { widthMm: 36, lines: 2, maxPt: 8.5, minPt: 6.5 })
  assert.deepEqual(short, { pt: 8.5, lines: 1, rows: ['Хлеб'], cut: false })
  const two = fitText('Парацетамол таблетки 500 мг', { widthMm: 36, lines: 2, maxPt: 8.5, minPt: 6.5 })
  assert.equal(two.lines, 2)
  assert.equal(two.cut, false)
  const long = fitText('Очень длинное название товара с подробным описанием упаковки и производителя', { widthMm: 26, lines: 1, maxPt: 7.5, minPt: 6 })
  assert.deepEqual([long.pt, long.cut, long.rows.length], [6, true, 1])
  assert.ok(long.rows[0].startsWith('Очень') && long.rows[0].endsWith('…'), long.rows[0])
  // Одно слово длиннее строки переносится по буквам — тоже считается строками
  const word = fitText('Аааааааааааааааааааааааааааааааааа', { widthMm: 20, lines: 2, maxPt: 8, minPt: 8 })
  assert.equal(word.cut, true)
  assert.deepEqual(fitText('', { widthMm: 20, lines: 1, maxPt: 8, minPt: 6 }), { pt: 8, lines: 0, rows: [], cut: false })
})

// Части наклейки укладываются в её высоту, полоски — в ширину
function assertFits(plan) {
  const id = `${plan.w}×${plan.h}${plan.sx || plan.sy ? ` сдвиг ${plan.sx.toFixed(2)}/${plan.sy.toFixed(2)}` : ''}${plan.flip ? ' перевёрнута' : ''}`
  const nameH = plan.name.lines * plan.name.pt * MM_PER_PT * 1.12
  const priceH = plan.price.pt * MM_PER_PT * 1.2 + 0.8
  const textH = 0.25 + plan.barcode.fontMm * 0.95
  const used = nameH + priceH + textH + plan.barcode.barMm
  assert.ok(used <= plan.h - plan.pad.t - plan.pad.b + 1e-9, `${id}: ${used.toFixed(2)} мм из ${plan.h - plan.pad.t - plan.pad.b}`)
  // Код с белыми полями — не шире наклейки без 0,8 мм
  assert.ok(plan.barcode.width <= plan.w - 0.8 + 1e-9, `${id}: код ${plan.barcode.width} мм`)
  assert.ok(plan.barcode.barMm >= 5, `${id}: полоски ${plan.barcode.barMm} мм`)
  // Части не наезжают друг на друга: название — над кодом, код — над ценой
  assert.ok(plan.name.top + plan.name.height <= plan.barcode.top + 1e-9, id + ': название над кодом')
  assert.ok(plan.barcode.top + plan.barcode.height <= plan.price.top + 1e-9, id + ': код над ценой')
  // Блок наклейки: на 0,6 мм уже и ниже страницы, ширина — целые точки
  const dots = (v) => Math.abs(v / plan.dot - Math.round(v / plan.dot)) < 1e-6
  assert.ok(dots(plan.boxW), id + ': ширина блока — целые точки')
  assert.ok(plan.boxW <= plan.w - 0.6 + 1e-9 && plan.boxW > plan.w - 0.6 - plan.dot, id + ': блок на 0,6 мм уже страницы')
  assert.ok(Math.abs(plan.boxH - (plan.h - 0.6)) < 1e-9, id + ': блок на 0,6 мм ниже страницы')
  // После сдвига и поворота — где окажутся название, полосы кода и плашка цены на странице:
  // всё внутри рисунка, полосы — на точках принтера
  const X = (x) => (plan.flip ? 2 * plan.cx - x : x) + plan.sx
  const Y = (y) => (plan.flip ? 2 * plan.cy - y : y) + plan.sy
  const inside = (x0, x1, y0, y1, what) => {
    const xs = [X(x0), X(x1)].sort((a, b) => a - b)
    const ys = [Y(y0), Y(y1)].sort((a, b) => a - b)
    assert.ok(xs[0] >= -1e-9 && xs[1] <= plan.vbW + 1e-9 && ys[0] >= -1e-9 && ys[1] <= plan.vbH + 1e-9, `${id}: ${what} внутри рисунка — x ${xs.map((v) => v.toFixed(2))} из ${plan.vbW.toFixed(2)}, y ${ys.map((v) => v.toFixed(2))} из ${plan.vbH.toFixed(2)}`)
  }
  const innerW = plan.w - plan.pad.l - plan.pad.r
  inside(plan.xc - innerW / 2, plan.xc + innerW / 2, plan.name.top, plan.name.top + plan.name.height, 'название')
  const bc = plan.barcode
  const barsL = bc.left + bc.model.quietL * bc.module
  const barsR = bc.left + bc.width - bc.model.quietR * bc.module
  inside(barsL, barsR, bc.top, bc.top + bc.height, 'полосы кода')
  if (plan.price.text) inside(plan.xc - plan.price.plateW / 2, plan.xc + plan.price.plateW / 2, plan.price.top, plan.price.top + plan.price.height, 'плашка цены')
  assert.ok(dots(X(barsL)) && dots(X(barsR)), `${id}: полосы на точках принтера (${X(barsL).toFixed(4)})`)
  // Полосы — не ближе 1 мм к краю наклейки там, где они лягут на бумагу (сдвиг возмещает
  // промах принтера, поэтому — в раскладке, до сдвига)
  assert.ok(barsL >= 1 - 1e-9 && barsR <= plan.w - 1 + 1e-9, `${id}: полосы от края наклейки ${barsL.toFixed(2)} и ${(plan.w - barsR).toFixed(2)} мм`)
}

test('каждый ходовой размер: название, EAN-13 и цена помещаются, полоски не ниже 5 мм', () => {
  const p = { name: 'Нурофен Экспресс 200 мг №12', price: '125,50 сомони', code: '4870204010060' }
  for (const s of NAKLEYKA_SIZES) {
    const plan = nakleykaPlan(s, p)
    assert.equal(plan.problem, '', s.id)
    assertFits(plan)
  }
  // 58 мм — модуль в 3 точки, 40 и 30 мм — в 2 точки
  const dot = 25.4 / 203
  assert.ok(Math.abs(nakleykaPlan({ w: 58, h: 40 }, p).barcode.module - 3 * dot) < 1e-12)
  assert.ok(Math.abs(nakleykaPlan({ w: 40, h: 30 }, p).barcode.module - 2 * dot) < 1e-12)
  assert.ok(Math.abs(nakleykaPlan({ w: 30, h: 20 }, p).barcode.module - 2 * dot) < 1e-12)
  // На низкой наклейке название — одной строкой
  assert.equal(nakleykaPlan({ w: 30, h: 20 }, p).name.lines, 1)
})

test('принтер 300 dpi: на всех ходовых размерах EAN-13, EAN-8 и короткий Code 128 помещаются', () => {
  for (const code of ['4870204010060', '96385074', 'AB-123', '012345678905']) {
    for (const s of NAKLEYKA_SIZES) {
      const plan = nakleykaPlan(s, { name: 'Нурофен 200 мг', price: '25,50 сомони', code, dpi: 300 })
      assert.equal(plan.problem, '', `${code} на ${s.id} при 300 dpi`)
      assertFits(plan)
    }
  }
  // EAN-13 на 30×20 при 300 dpi — с полями 9 и 7 модулей (полные 11 и 7 не помещаются)
  const tight = nakleykaPlan({ w: 30, h: 20 }, { name: 'X', code: '4870204010060', dpi: 300 })
  assert.deepEqual([tight.barcode.model.quietL, tight.barcode.model.quietR], [9, 7])
  // При 203 dpi поля полные
  const full = nakleykaPlan({ w: 30, h: 20 }, { name: 'X', code: '4870204010060', dpi: 203 })
  assert.deepEqual([full.barcode.model.quietL, full.barcode.model.quietR], [11, 7])
})

test('сдвиг из настройки (−2…+2 мм) и поворот: ничего не срезано, полосы на точках', () => {
  const p = { name: 'Нурофен Экспресс 200 мг №12', price: '125,50 сомони', code: '4870204010060' }
  for (const s of NAKLEYKA_SIZES) {
    for (const dpi of [203, 300]) {
      for (const dx of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
        for (const dy of [-2, -1, 0, 1, 2]) {
          for (const flip of [false, true]) {
            const plan = nakleykaPlan(s, { ...p, dpi, dx, dy, flip })
            assert.equal(plan.problem, '', `${s.id} ${dpi} dpi сдвиг ${dx}/${dy}${flip ? ' перевёрнута' : ''}`)
            assertFits(plan)
          }
        }
      }
    }
  }
  // Без сдвига и поворота — посередине, как раньше
  const plain = nakleykaPlan({ w: 58, h: 40 }, p)
  assert.ok(Math.abs(plain.xc - 29) < 1e-9 && plain.pad.l === plain.pad.r)
  // Перевёрнутая без сдвига — тоже посередине наклейки (а не блока): поля слева и справа почти равны
  const fl = nakleykaPlan({ w: 58, h: 40 }, { ...p, flip: true })
  const X = (x) => 2 * fl.cx - x
  const bl = X(fl.barcode.left + fl.barcode.width - fl.barcode.model.quietR * fl.barcode.module)
  const br = X(fl.barcode.left + fl.barcode.model.quietL * fl.barcode.module)
  assert.ok(Math.abs(bl - (58 - br)) < 2.5, `перевёрнутая: полосы от краёв ${bl.toFixed(2)} и ${(58 - br).toFixed(2)}`)
})

test('свои размеры от самого маленького до большого тоже раскладываются', () => {
  const p = { name: 'Товар', price: '9,90 сомони', code: '123' }
  for (const s of [{ w: 25, h: 20 }, { w: 43, h: 25 }, { w: 50, h: 30 }, { w: 100, h: 150 }, { w: 110, h: 20 }]) {
    const plan = nakleykaPlan(s, p)
    assert.equal(plan.problem, '', `${s.w}×${s.h}`)
    assertFits(plan)
  }
})

test('цена: плашка не шире наклейки, не влезающая цена — с многоточием', () => {
  const plan = nakleykaPlan({ w: 30, h: 20 }, { name: 'X', price: '1 250,75 сомони', code: '123' })
  assert.equal(plan.price.text, '1 250,75 сомони')
  assert.ok(plan.price.plateW <= plan.w - plan.pad.l - plan.pad.r + 1e-9, String(plan.price.plateW))
  const huge = nakleykaPlan({ w: 30, h: 20 }, { name: 'X', price: '123 456 789 012,99 сомони', code: '123' })
  assert.ok(huge.price.text.endsWith('…'), huge.price.text)
  assert.ok(huge.price.plateW <= huge.w - huge.pad.l - huge.pad.r + 1e-9, String(huge.price.plateW))
  assert.equal(nakleykaPlan({ w: 30, h: 20 }, { name: 'X', price: '', code: '123' }).price.plateW, 0)
})

test('почему не напечатать: нет кода, русские буквы, код длиннее наклейки', () => {
  assert.equal(nakleykaPlan({ w: 58, h: 40 }, { name: 'X', code: '' }).problem, 'nocode')
  assert.equal(nakleykaPlan({ w: 58, h: 40 }, { name: 'X', code: 'Хлеб-1' }).problem, 'badcode')
  // EAN-13 на наклейке шириной 25 мм не помещается даже узкими полосками
  assert.equal(nakleykaPlan({ w: 25, h: 20 }, { name: 'X', code: '4870204010060' }).problem, 'toolong')
  // Длинный код с буквами — тоже
  assert.equal(nakleykaPlan({ w: 30, h: 20 }, { name: 'X', code: 'ABCDEFGHIJKLMNOP' }).problem, 'toolong')
  // 13 цифр с неверной контрольной — Code 128, на 30 мм не помещается, на 40 — да
  assert.equal(nakleykaPlan({ w: 30, h: 20 }, { name: 'X', code: '2154000000001' }).problem, 'toolong')
  assert.equal(nakleykaPlan({ w: 40, h: 30 }, { name: 'X', code: '2154000000001' }).problem, '')
})

test('Code 128 на узкой наклейке: белые поля сужаются до 6 модулей, если иначе не помещается', () => {
  // «AB-123» — 101 модуль: с полями по 10 — 30,25 мм, на 30 мм не встаёт; с полями по 6 — да
  const narrow = nakleykaPlan({ w: 30, h: 20 }, { name: 'X', code: 'AB-123' })
  assert.equal(narrow.problem, '')
  assert.deepEqual([narrow.barcode.model.quietL, narrow.barcode.model.quietR], [6, 6])
  // Где место есть — поля полные
  const wide = nakleykaPlan({ w: 40, h: 30 }, { name: 'X', code: 'AB-123' })
  assert.deepEqual([wide.barcode.model.quietL, wide.barcode.model.quietR], [10, 10])
  // EAN-13 на 25 мм не встаёт и с узкими полями
  assert.equal(nakleykaPlan({ w: 25, h: 20 }, { name: 'X', code: '4870204010060' }).problem, 'toolong')
})

test('сколько наклеек на строку прихода: упаковки, неполная — тоже, весовой — одна', () => {
  const pack = { id: 'p1', unitsPerPack: 1, unit: 'шт' }
  const blister = { id: 'p2', unitsPerPack: 10, unit: 'уп' }
  const kg = { id: 'p3', unitsPerPack: 1000, unit: 'кг' }
  assert.equal(nakleekNaStroku({ qty: 12, pieces: 0 }, pack), 12)
  assert.equal(nakleekNaStroku({ qty: 2, pieces: 5 }, blister), 3)
  assert.equal(nakleekNaStroku({ qty: 0, pieces: 4 }, blister), 1)
  assert.equal(nakleekNaStroku({ qty: 25, pieces: 350 }, kg), 1)
  assert.equal(nakleekNaStroku({ qty: 5000, pieces: 0 }, pack), 999, 'не больше 999 за раз')
  assert.equal(nakleekNaStroku({ qty: 3 }, null), 0, 'товара нет в справочнике')
})

test('наклейки подряд: каждая копия — своя, всего не больше 2000', () => {
  const rows = [{ key: 'a', count: 2 }, { key: 'b', count: 0 }, { key: 'c', count: '3' }]
  assert.deepEqual(razvernut(rows).map((x) => x.key), ['a:0', 'a:1', 'c:0', 'c:1', 'c:2'])
  assert.equal(totalOf(rows), 5)
  assert.equal(razvernut([{ key: 'x', count: 999 }, { key: 'y', count: 999 }, { key: 'z', count: 999 }]).length, MAX_TOTAL)
  assert.equal(copiesOf('-3'), 0)
  assert.equal(copiesOf('2.7'), 2)
  assert.equal(copiesOf(100000), 999)
})
