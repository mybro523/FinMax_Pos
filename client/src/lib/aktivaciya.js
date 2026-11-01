// ── Код активации и код сброса на экране (магазин без интернета, 1.6.0) ──
//
// Код — 50 знаков (10 групп по 5): латинские буквы и цифры, без I, L, O, U, чтобы их не путали
// с 1 и 0. Его диктуют по телефону или присылают в мессенджер, и набирают руками. Поэтому окно
// прощает то, что неважно: строчные буквы, пробелы и дефисы, O вместо нуля, I и L вместо
// единицы — и русскую раскладку: буква, набранная на клавише латинской, становится латинской
// (по месту клавиши). Правильность самого кода проверяет основная часть программы
// (desktop/src/local/licence-code.mjs): опечатку она отличает от чужого кода.

export const CODE_LEN = 50
const ALLOWED = /[0-9A-HJKMNP-TV-Z]/

// Русская раскладка ЙЦУКЕН → латинская QWERTY по месту клавиши
const RU_KEYS = {
  Й: 'Q', Ц: 'W', У: 'E', К: 'R', Е: 'T', Н: 'Y', Г: 'U', Ш: 'I', Щ: 'O', З: 'P',
  Ф: 'A', Ы: 'S', В: 'D', А: 'F', П: 'G', Р: 'H', О: 'J', Л: 'K', Д: 'L',
  Я: 'Z', Ч: 'X', С: 'C', М: 'V', И: 'B', Т: 'N', Ь: 'M',
}

export function normalizeCode(text, max = CODE_LEN) {
  let out = ''
  for (const ch0 of String(text ?? '').toUpperCase()) {
    let ch = RU_KEYS[ch0] || ch0
    if (ch === 'O') ch = '0'
    else if (ch === 'I' || ch === 'L') ch = '1'
    if (ALLOWED.test(ch)) out += ch
    if (out.length >= max) break
  }
  return out
}

export const formatCode = (raw) => (raw.match(/.{1,5}/g) || []).join('-')

// Где курсор в поле. Дефисы поле расставляет само, поэтому место курсора считают в знаках
// кода: после n-го знака курсор стоит перед дефисом, который за ним следует. Человек правит
// опечатку посреди кода — курсор должен остаться там, а не убежать в конец
export const caretAt = (n) => n + Math.floor(Math.max(n - 1, 0) / 5)

// Правка поля: в показанный текст на место выделения [from, to) вставили text.
// Ответ — код целиком и сколько его знаков стоит перед курсором
export function editCode(shown, from, to, text = '') {
  const s = String(shown ?? '')
  const head = normalizeCode(s.slice(0, from), Infinity)
  const added = normalizeCode(text, Infinity)
  const raw = normalizeCode(head + added + normalizeCode(s.slice(to), Infinity))
  return { raw, before: Math.min(head.length + added.length, raw.length) }
}

// Вставка из сообщения: код там латиницей, а вокруг — русские слова («Ваш код: …»). Если в
// тексте есть код целиком — ровно groups групп по 5 (код активации — 10, код компьютера — 2), —
// берётся только он. Иначе русские буквы отбрасываются: по месту клавиш их переводят только
// при наборе, а не при вставке
const DASH = '\\s\\-\\u2010-\\u2015'
const wholeOf = (groups) =>
  new RegExp(`(?<![0-9A-Za-z][${DASH}]{0,3})[0-9A-Za-z]{5}(?:[${DASH}]{1,3}[0-9A-Za-z]{5}){${groups - 1}}(?![${DASH}]{0,3}[0-9A-Za-z])`)
export function pastedCode(text, groups = 10) {
  const s = String(text ?? '')
  const whole = s.match(wholeOf(groups))
  if (whole) return whole[0].replace(new RegExp(`[${DASH}]`, 'g'), '')
  return s.replace(/[Ѐ-ӿ]+/g, ' ')
}

// Где кончилась правка, если поле поменяла программа, а не человек (экранная клавиатура ставит
// текст целиком — курсор у поля после этого в конце): по общему началу и общему концу прежнего
// и нового текста. Ответ — место в новом тексте сразу после вставленного (или стёртого)
export function editEnd(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return b.length - s
}

// Нажатая клавиша — какой латинский знак на ней, если раскладка не латинская. Иначе null:
// латинский знак и так придёт в поле обычным путём, а служебные клавиши (End, стрелки,
// Backspace — и цифры дополнительной клавиатуры без NumLock) делают своё
export function physicalKey(e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey) return null
  if (typeof e.key !== 'string' || [...e.key].length !== 1) return null
  if (/[0-9A-Za-z]/.test(e.key)) return null
  const m = /^Key([A-Z])$/.exec(e.code || '') || /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '')
  return m ? m[1] : null
}

// Что сказать о сроке. Основная часть программы отвечает по-русски и с датой внутри — такую
// строку по словарю не перевести, поэтому окно собирает её само из переводимых частей
export function soloMessage(a, t) {
  if (!a) return ''
  if (a.expired) return `${t('Срок работы программы закончился')} ${a.untilHuman}. ${t('Данные магазина сохранены — введите новый код активации.')}`
  if (a.warn) return `${t('Срок работы программы заканчивается')} ${a.untilHuman}. ${t('Попросите новый код активации у поставщика программы.')}`
  if (!a.active && !a.activated) return t('Программа не активирована — введите код активации.')
  return ''
}
