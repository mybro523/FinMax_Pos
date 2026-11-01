// ── Поле кода активации (lib/aktivaciya.js) ──
// Код в 50 знаков диктуют по телефону и набирают руками. Поле прощает то, что неважно:
// строчные буквы, пробелы, дефисы, O вместо нуля, I и L вместо единицы и русскую раскладку.
// Ошибка здесь — человек набрал код верно, а программа говорит «опечатка».
import test from 'node:test'
import assert from 'node:assert/strict'
import { CODE_LEN, normalizeCode, formatCode, caretAt, editCode, editEnd, pastedCode, physicalKey, soloMessage } from '../src/lib/aktivaciya.js'

const CODE = '240MW-0G00Z-FTTBH-GT2F8-XAE3J-3BJGZ-MTRYW-NZDJM-TFW6Y-ZNMR9'
const RAW = CODE.replace(/-/g, '')

test('код, набранный как диктуют, приводится к тому же коду', () => {
  assert.equal(RAW.length, CODE_LEN)
  assert.equal(normalizeCode(CODE), RAW)
  assert.equal(normalizeCode(CODE.toLowerCase()), RAW)
  assert.equal(normalizeCode(CODE.replace(/-/g, ' ')), RAW)
  assert.equal(normalizeCode(CODE.toLowerCase().replace(/-/g, '  ').replace(/0/g, 'o')), RAW)
  assert.equal(formatCode(normalizeCode(CODE.toLowerCase())), CODE)
})

test('буквы, похожие на цифры: O → 0, I и L → 1', () => {
  assert.equal(normalizeCode('OoIiLl'), '001111')
})

test('лишнее отбрасывается: U, знаки, буквы вне раскладки', () => {
  assert.equal(normalizeCode('A-B_C.D/E'), 'ABCDE')
  assert.equal(normalizeCode('u U'), '')
  assert.equal(normalizeCode('ХЪЖЭБЮЁ'), '')
  assert.equal(normalizeCode(null), '')
  assert.equal(normalizeCode(undefined), '')
})

test('русская раскладка: буква по месту клавиши', () => {
  // ЙЦУКЕН стоит на QWERTY; Г — на U (её в коде нет), Щ — на O (= 0), Ш — на I (= 1)
  assert.equal(normalizeCode('йцукен'), 'QWERTY')
  assert.equal(normalizeCode('ФЫВА'), 'ASDF')
  assert.equal(normalizeCode('ячсмить'), 'ZXCVBNM')
  assert.equal(normalizeCode('Г'), '')
  assert.equal(normalizeCode('ЩШД'), '011')
  // Половина кода латиницей, половина — в русской раскладке
  const ru = { Q: 'Й', W: 'Ц', E: 'У', R: 'К', T: 'Е', Y: 'Н', P: 'З', A: 'Ф', S: 'Ы', D: 'В', F: 'А', G: 'П', H: 'Р', J: 'О', K: 'Л', Z: 'Я', X: 'Ч', C: 'С', V: 'М', B: 'И', N: 'Т', M: 'Ь' }
  const half = RAW.slice(0, 25) + [...RAW.slice(25)].map((c) => ru[c] || c).join('')
  assert.notEqual(half, RAW)
  assert.equal(normalizeCode(half), RAW)
})

test('больше 50 знаков не набирается', () => {
  assert.equal(normalizeCode(RAW + 'ABCDE').length, CODE_LEN)
  assert.equal(normalizeCode(RAW + 'ABCDE'), RAW)
  assert.equal(normalizeCode('ABCDEFGH', 5), 'ABCDE')
})

test('вид кода: группы по 5 через дефис, неполная группа в конце', () => {
  assert.equal(formatCode(''), '')
  assert.equal(formatCode('ABC'), 'ABC')
  assert.equal(formatCode('ABCDE'), 'ABCDE')
  assert.equal(formatCode('ABCDEF'), 'ABCDE-F')
  assert.equal(formatCode(RAW), CODE)
})

test('клавиша: латинский знак идёт обычным путём, нелатинский — по месту клавиши', () => {
  assert.equal(physicalKey({ key: 'a', code: 'KeyA' }), null)
  assert.equal(physicalKey({ key: '7', code: 'Digit7' }), null)
  assert.equal(physicalKey({ key: 'ф', code: 'KeyA' }), 'A')
  assert.equal(physicalKey({ key: 'Щ', code: 'KeyO' }), 'O')
  // Цифры на русской раскладке те же, но «Shift+7» даёт «?» — по месту клавиши это 7
  assert.equal(physicalKey({ key: '?', code: 'Digit7' }), '7')
  // Дополнительная клавиатура: с NumLock цифра идёт обычным путём, без него это End
  assert.equal(physicalKey({ key: '1', code: 'Numpad1' }), null)
  assert.equal(physicalKey({ key: 'End', code: 'Numpad1' }), null)
  assert.equal(physicalKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), null)
  // Сочетания и служебные клавиши не трогаем
  assert.equal(physicalKey({ key: 'м', code: 'KeyV', ctrlKey: true }), null)
  assert.equal(physicalKey({ key: 'Enter', code: 'Enter' }), null)
  assert.equal(physicalKey({ key: 'Backspace', code: 'Backspace' }), null)
  assert.equal(physicalKey({ key: 'ж', code: 'Semicolon' }), null)
  assert.equal(physicalKey(null), null)
})

test('курсор после n знаков — перед следующим дефисом', () => {
  assert.equal(caretAt(0), 0)
  assert.equal(caretAt(3), 3)
  assert.equal(caretAt(5), 5) // ABCDE|-F
  assert.equal(caretAt(6), 7) // ABCDE-F|
  assert.equal(caretAt(10), 11)
  assert.equal(caretAt(50), 59)
  assert.equal(caretAt(50), CODE.length)
  // Курсор всегда стоит сразу после n-го знака кода
  for (let n = 1; n <= 50; n++) assert.equal(CODE.slice(0, caretAt(n)).replace(/-/g, '').length, n)
})

test('правка посреди кода: опечатку исправили — курсор там же', () => {
  // Набрали «…FTTBX…» вместо «…FTTBH…» (3-я группа): выделили X и набрали h
  const wrong = CODE.replace('FTTBH', 'FTTBX')
  const at = wrong.indexOf('FTTBX') + 4
  const fixed = editCode(wrong, at, at + 1, 'h')
  assert.equal(fixed.raw, RAW)
  assert.equal(fixed.before, 15)
  assert.equal(caretAt(fixed.before), at + 1)
  // Знак пропустили: курсор после «FTTB», вставили H — код сдвинулся и стал верным
  const lost = formatCode(RAW.slice(0, 14) + RAW.slice(15))
  const put = editCode(lost, caretAt(14), caretAt(14), 'H')
  assert.equal(put.raw, RAW)
  assert.equal(put.before, 15)
  // Русская раскладка посреди кода: «р» на месте H
  assert.equal(editCode(lost, caretAt(14), caretAt(14), 'р').raw, RAW)
  // Поле уже само вставило строчную букву (обычный ввод): считаем знаки до курсора
  const typed = lost.slice(0, caretAt(14)) + 'h' + lost.slice(caretAt(14))
  const after = editCode(typed, caretAt(14) + 1, caretAt(14) + 1)
  assert.equal(after.raw, RAW)
  assert.equal(after.before, 15)
  // Выделили всё и вставили код из сообщения
  const pasted = editCode('ABC', 0, 3, pastedCode('Код: ' + CODE.toLowerCase()))
  assert.equal(pasted.raw, RAW)
  assert.equal(pasted.before, 50)
  // Код уже полный, вставили знак в начало — лишний хвост отрезан, курсор после вставки
  const over = editCode(CODE, 0, 0, 'Z')
  assert.equal(over.raw.length, 50)
  assert.equal(over.before, 1)
})

test('вставка из сообщения: берётся сам код, русские слова не превращаются в буквы', () => {
  const take = (s) => normalizeCode(pastedCode(s))
  assert.equal(take(CODE), RAW)
  assert.equal(take('Ваш код активации: ' + CODE + '. Срок — до 01.12.2027'), RAW)
  assert.equal(take('Код компьютера: M4VA4-S71V6\nКод активации: ' + CODE), RAW)
  assert.equal(take('Код:\n' + CODE.replace(/-/g, ' ')), RAW)
  assert.equal(take('Код: ' + CODE.replace(/-/g, ' - ')), RAW)
  // Мессенджер заменил дефис «неразрывным» или тире
  assert.equal(take(CODE.replace(/-/g, '‑')), RAW)
  assert.equal(take(CODE.replace(/-/g, '–')), RAW)
  // Без групп: русские слова отбрасываются, а не переводятся по клавишам
  assert.equal(take('Код: ' + RAW), RAW)
  assert.equal(take('Ваш код ' + RAW.slice(0, 20)), RAW.slice(0, 20))
  // Кусок кода — вставляется как есть
  assert.equal(take('MTRYW-NZDJM'), 'MTRYWNZDJM')
  assert.equal(pastedCode(null), '')
})

test('что сказать о сроке', () => {
  const t = (s) => s
  assert.equal(soloMessage(null, t), '')
  assert.equal(soloMessage({ active: true, activated: true }, t), '')
  assert.match(soloMessage({ active: true, activated: true, warn: true, untilHuman: '01.12.2026' }, t), /заканчивается 01\.12\.2026\. Попросите новый код/)
  assert.match(soloMessage({ active: false, activated: true, expired: true, untilHuman: '01.12.2026' }, t), /закончился 01\.12\.2026\. Данные магазина сохранены/)
  assert.match(soloMessage({ active: false, activated: false }, t), /не активирована/)
  // Части фразы идут через словарь: перевод собирается из переводимых кусков
  const tg = (s) => '[' + s + ']'
  assert.equal(soloMessage({ warn: true, active: true, activated: true, untilHuman: '01.12.2026' }, tg), '[Срок работы программы заканчивается] 01.12.2026. [Попросите новый код активации у поставщика программы.]')
})

// Экранная клавиатура программы ставит текст целиком (курсор у поля после этого в конце):
// поле находит место правки по разнице с прежним текстом. Здесь — та же цепочка, что в
// CodeInput (BezInterneta.jsx): клавиатура вставляет знак у курсора, поле приводит код к виду
// и ставит курсор само
function keyboardField() {
  let raw = ''
  let caret = 0
  const shown = () => formatCode(raw)
  const apply = (v) => {
    const before = shown()
    const at = editEnd(before, v)
    const next = editCode(v, at, at)
    if (next.raw === raw && v.length < before.length && next.before > 0) {
      const cut = next.before - 1
      raw = raw.slice(0, cut) + raw.slice(next.before)
      caret = caretAt(cut)
    } else {
      raw = next.raw
      caret = caretAt(next.before)
    }
  }
  return {
    type: (ch) => apply(shown().slice(0, caret) + ch + shown().slice(caret)),
    erase: () => apply(shown().slice(0, caret - 1) + shown().slice(caret)),
    moveTo: (n) => (caret = caretAt(n)),
    setCaret: (pos) => (caret = pos),
    get raw() {
      return raw
    },
    get caret() {
      return caret
    },
  }
}

test('экранная клавиатура: место правки — по разнице с прежним текстом', () => {
  assert.equal(editEnd('ABCDE', 'ABCDEF'), 6)
  assert.equal(editEnd('ABCDE-FGH', 'ABCXDE-FGH'), 4)
  assert.equal(editEnd('ABCDE-F', 'ABCDEF'), 5)
  assert.equal(editEnd('ABCDE-F', 'ABCD-F'), 4)
  assert.equal(editEnd('', 'a'), 1)
  assert.equal(editEnd('AAB', 'AAAB'), 3)
})

test('экранная клавиатура: код набирается целиком, буквы не путаются (и в русской раскладке)', () => {
  const f = keyboardField()
  for (const ch of RAW.toLowerCase()) f.type(ch)
  assert.equal(f.raw, RAW)
  assert.equal(formatCode(f.raw), CODE)
  const ru = keyboardField()
  const RU = { Q: 'й', W: 'ц', E: 'у', R: 'к', T: 'е', Y: 'н', P: 'з', A: 'ф', S: 'ы', D: 'в', F: 'а', G: 'п', H: 'р', J: 'о', K: 'л', Z: 'я', X: 'ч', C: 'с', V: 'м', B: 'и', N: 'т', M: 'ь' }
  for (const ch of RAW) ru.type(RU[ch] || ch)
  assert.equal(ru.raw, RAW)
})

test('экранная клавиатура: вставка посреди кода и «Стереть» у дефиса', () => {
  const f = keyboardField()
  const lost = RAW.slice(0, 14) + RAW.slice(15)
  for (const ch of lost) f.type(ch)
  f.moveTo(14)
  f.type(RAW[14].toLowerCase())
  assert.equal(f.raw, RAW)
  assert.equal(f.caret, caretAt(15))
  // Два знака подряд посреди кода — в том же порядке
  const g = keyboardField()
  for (const ch of RAW.slice(0, 10) + RAW.slice(12)) g.type(ch)
  g.moveTo(10)
  g.type(RAW[10])
  g.type(RAW[11])
  assert.equal(g.raw, RAW)
  // Курсор сразу за дефисом (человек ткнул туда): «Стереть» стирает знак перед дефисом с первого нажатия
  const h = keyboardField()
  for (const ch of 'ABCDEF') h.type(ch)
  h.setCaret(6)
  h.erase()
  assert.equal(h.raw, 'ABCDF')
  assert.equal(h.caret, caretAt(4))
})

test('вставка кода компьютера из сообщения: две группы', () => {
  assert.equal(normalizeCode(pastedCode('Код компьютера: XJ980-C0A4R', 2), 10), 'XJ980C0A4R')
  assert.equal(normalizeCode(pastedCode('xj980 c0a4r', 2), 10), 'XJ980C0A4R')
  // Без групп — русские слова отбрасываются
  assert.equal(normalizeCode(pastedCode('Код: XJ980C0A4R', 2), 10), 'XJ980C0A4R')
})
