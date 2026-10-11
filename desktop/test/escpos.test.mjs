// ── Печать на чековом принтере: что именно уйдёт в принтер ──
//
// Настоящего принтера у проверки нет, поэтому сверяются сами байты: команды языка
// ESC/POS и буквы в таблице принтера. Ошибка здесь выглядит на бумаге как
// «кракозябры» или уехавшие колонки — и видит её уже покупатель.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { encode, escpos, printable, renderTicket, sanitizeTicket, twoColumns, wrap } from '../src/print/escpos.mjs'

// Байты обратно в текст — чтобы сверять раскладку глазами. Команды выкидываются
function text866(buf) {
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x1b) {
      // ESC @ — два байта; ESC t n, ESC a n, ESC E n, ESC d n — три; ESC p m t1 t2 — пять
      i += buf[i + 1] === 0x40 ? 1 : buf[i + 1] === 0x70 ? 4 : 2
      continue
    }
    if (b === 0x1d) {
      i += buf[i + 1] === 0x56 ? 3 : 2 // GS V m n; GS ! n
      continue
    }
    if (b === 0x0a) out += '\n'
    else if (b < 0x80) out += String.fromCharCode(b)
    else if (b <= 0xaf) out += String.fromCharCode(b - 0x80 + 0x410)
    else if (b >= 0xe0 && b <= 0xef) out += String.fromCharCode(b - 0xe0 + 0x440)
    else if (b === 0xf0) out += 'Ё'
    else if (b === 0xf1) out += 'ё'
    else if (b === 0xfc) out += '№'
    else out += '?'
  }
  return out
}

test('русские буквы ложатся в таблицу принтера: CP866 и CP1251', () => {
  assert.deepEqual([...encode('АБЯ', 'cp866')], [0x80, 0x81, 0x9f])
  assert.deepEqual([...encode('абп', 'cp866')], [0xa0, 0xa1, 0xaf])
  assert.deepEqual([...encode('рся', 'cp866')], [0xe0, 0xe1, 0xef])
  assert.deepEqual([...encode('Ёё№', 'cp866')], [0xf0, 0xf1, 0xfc])
  assert.deepEqual([...encode('Ая', 'cp1251')], [0xc0, 0xff])
  assert.deepEqual([...encode('Ёё№', 'cp1251')], [0xa8, 0xb8, 0xb9])
  // Латиница, цифры и знаки — как есть
  assert.equal(encode('Nurofen 200mg x2 = 30.50', 'cp866').toString('latin1'), 'Nurofen 200mg x2 = 30.50')
  assert.equal(text866(encode('Аптека №1: Нурофен 200 мг', 'cp866')), 'Аптека №1: Нурофен 200 мг')
})

test('таджикских букв у принтера нет — печатается ближайшая русская, а не пустой квадрат', () => {
  assert.equal(printable('Қарзи мизоҷ: ҳама фурӯхта шуд'), 'Карзи мизоч: хама фурухта шуд')
  assert.equal(text866(encode('Ғӣ Ҷӯ Ҳқ')), 'Ги Чу Хк')
  assert.equal(printable('«Аптека» — чек… 5 × 10'), '"Аптека" - чек... 5 x 10')
  // Неразрывный пробел из денег («1 234,5») становится обычным
  assert.equal(printable('1 234,5 сомони'), '1 234,5 сомони')
  // Совсем незнакомый знак — вопросом, а не сбоем таблицы
  assert.deepEqual([...encode('日')], [0x3f])
})

test('длинное название переносится по словам, слишком длинное слово режется', () => {
  assert.deepEqual(wrap('Амоксициллин 500 мг капсулы №16', 16), ['Амоксициллин 500', 'мг капсулы №16'])
  assert.deepEqual(wrap('Тетрагидроканнабинолоподобный', 10), ['Тетрагидро', 'каннабинол', 'оподобный'])
  assert.deepEqual(wrap('', 32), [''])
  assert.deepEqual(wrap('строка\nвторая', 32), ['строка', 'вторая'])
  assert.ok(wrap('а '.repeat(200), 32).every((l) => l.length <= 32))
})

test('подпись слева, число справа — ровно по ширине ленты', () => {
  assert.deepEqual(twoColumns('Итого', '300 сомони', 32), ['Итого' + ' '.repeat(17) + '300 сомони'])
  assert.equal(twoColumns('Итого', '300 сомони', 32)[0].length, 32)
  assert.equal(twoColumns('Итого', '300 сомони', 48)[0].length, 48)
  // Подпись не помещается — переносится, число остаётся в последней строке
  const rows = twoColumns('Возвращено покупателям наличными за смену', '1 250,50 сомони', 32)
  assert.ok(rows.length > 1)
  assert.ok(rows.every((r) => r.length <= 32))
  assert.ok(rows.at(-1).endsWith('1 250,50 сомони'))
  // Пустая подпись: число у правого края
  assert.equal(twoColumns('', '25 сомони', 32)[0], ' '.repeat(23) + '25 сомони')
})

test('команды принтера: сброс и таблица букв, жирный, по центру, отрезать, ящик', () => {
  const p = escpos({ codepage: 'cp866', width: 32 })
  assert.deepEqual([...p.init().bytes()], [0x1b, 0x40, 0x1b, 0x74, 17])
  assert.deepEqual([...escpos({ codepage: 'cp1251' }).init().bytes()], [0x1b, 0x40, 0x1b, 0x74, 46])
  // Незнакомая таблица — та, что знают все
  assert.deepEqual([...escpos({ codepage: 'koi8' }).init().bytes()], [0x1b, 0x40, 0x1b, 0x74, 17])
  assert.deepEqual([...escpos().align('center').bytes()], [0x1b, 0x61, 1])
  assert.deepEqual([...escpos().bold(true).bold(false).bytes()], [0x1b, 0x45, 1, 0x1b, 0x45, 0])
  assert.deepEqual([...escpos().tall(true).bytes()], [0x1d, 0x21, 0x01])
  assert.deepEqual([...escpos().cut().bytes()], [0x1d, 0x56, 0x42, 0x00])
  assert.deepEqual([...escpos().drawer().bytes()], [0x1b, 0x70, 0x00, 0x19, 0xfa])
  assert.deepEqual([...escpos().line('A').bytes()], [0x41, 0x0a])
  assert.deepEqual([...escpos().feed(99).bytes()], [0x1b, 0x64, 10], 'подача ленты ограничена — иначе опечатка выплюнула бы полрулона')
})

const TICKET = {
  head: ['Аптека №1', '04.10.2026, 15:30'],
  rows: [
    { name: 'Нурофен 200 мг №10', sub: '2 уп × 150', value: '300 сомони' },
    { name: 'Парацетамол 500 мг таблетки №20 (очень длинное название товара)', sub: '5 шт × 10 · скидка −5', value: '45 сомони' },
  ],
  totals: [
    { label: 'Скидка', value: '−5 сомони' },
    { label: 'Итого', value: '345 сомони', big: true },
    { label: 'Оплата', value: 'Наличные' },
  ],
  tail: ['Кассир: Нилуфар', 'Спасибо за покупку!'],
}

test('чек на ленте 58 мм: всё на своих местах и ни одна строка не шире ленты', () => {
  const bytes = renderTicket(TICKET, { width: 32, codepage: 'cp866' })
  // Начинается со сброса и выбора таблицы, заканчивается подачей и отрезом
  assert.deepEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 17])
  assert.deepEqual([...bytes.subarray(-7)], [0x1b, 0x64, 3, 0x1d, 0x56, 0x42, 0x00])
  const lines = text866(bytes).split('\n')
  assert.ok(lines.every((l) => l.length <= 32), 'строка вылезла за ленту: ' + lines.find((l) => l.length > 32))
  assert.deepEqual(lines.slice(0, 3), ['Аптека №1', '04.10.2026, 15:30', '-'.repeat(32)])
  assert.ok(lines.includes('Нурофен 200 мг №10'))
  assert.ok(lines.includes('  2 уп x 150' + ' '.repeat(10) + '300 сомони'), 'количество слева, сумма у правого края')
  assert.ok(lines.includes('Итого' + ' '.repeat(17) + '345 сомони'))
  assert.ok(lines.includes('Спасибо за покупку!'))
  // Длинное название перенесено, а не обрезано
  assert.ok(text866(bytes).includes('(очень длинное\nназвание товара)') || text866(bytes).includes('название товара)'))
})

test('лента 80 мм шире — колонки раздвигаются; без отреза и с ящиком — по настройке', () => {
  const wide = text866(renderTicket(TICKET, { width: 48 })).split('\n')
  assert.ok(wide.includes('Итого' + ' '.repeat(33) + '345 сомони'))
  assert.ok(wide.includes('-'.repeat(48)))

  const noCut = renderTicket(TICKET, { cut: false })
  assert.deepEqual([...noCut.subarray(-3)], [0x1b, 0x64, 3])
  const withDrawer = renderTicket(TICKET, { drawer: true })
  assert.deepEqual([...withDrawer.subarray(5, 10)], [0x1b, 0x70, 0x00, 0x19, 0xfa], 'ящик открывается до печати — кассир уже отсчитывает сдачу')
})

test('итоговая строка печатается крупно и жирно, остальные — обычно', () => {
  const bytes = [...renderTicket({ totals: [{ label: 'Итого', value: '1', big: true }] })]
  const at = (seq) => bytes.findIndex((_, i) => seq.every((b, n) => bytes[i + n] === b))
  const on = at([0x1b, 0x45, 1, 0x1d, 0x21, 0x01])
  const off = at([0x1d, 0x21, 0x00, 0x1b, 0x45, 0])
  assert.ok(on > 0 && off > on, 'крупный шрифт должен включаться перед строкой и выключаться после')
})

test('чек из мусора не роняет печать: лишнее отбрасывается, размеры ограничены', () => {
  assert.deepEqual(sanitizeTicket(null), { head: [], rows: [], totals: [], tail: [] })
  assert.deepEqual(sanitizeTicket({ head: 'строка', rows: {}, totals: 5 }), { head: [], rows: [], totals: [], tail: [] })
  const huge = sanitizeTicket({ head: Array(5000).fill('x'.repeat(5000)), rows: [null, 7, { name: 12 }] })
  assert.equal(huge.head.length, 400)
  assert.equal(huge.head[0].length, 200)
  assert.deepEqual(huge.rows, [{ name: '', sub: '', value: '' }, { name: '', sub: '', value: '' }, { name: '12', sub: '', value: '' }])
  // Пустой чек — всё равно корректное задание: сброс, подача, отрез
  assert.deepEqual([...renderTicket(null)], [0x1b, 0x40, 0x1b, 0x74, 17, 0x1b, 0x61, 1, 0x1b, 0x61, 0, 0x1b, 0x64, 3, 0x1d, 0x56, 0x42, 0x00])
})
