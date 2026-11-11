// ── Маленькое табло покупателя (1.7.6) ──
//
// У части кассовых моноблоков сзади — не второй экран, а маленькое табло на COM-порту: видна
// только сумма. Табло бывают двух видов:
//   • цифровое на 8 цифр (LED) — сумма и лампочки «Цена / Итого / Получено / Сдача».
//     Команды: ESC @ — сброс, ESC s n — лампочка (0 — все погашены, 2 — «Итого»,
//     4 — «Сдача»), ESC Q A <цифры> CR — показать число, FF — очистить;
//   • двухстрочное 2×20 (VFD, команды Epson/CD5220): ESC @ — сброс, FF — очистить, дальше
//     40 знаков: первая строка и вторая. Русских букв такие табло обычно не знают — текст
//     латиницей.
// Что показать, берётся из того же, что идёт на экран покупателя (lib/customerScreen.js):
// приветствие, корзина с итогом, «Спасибо» со сдачей. Здесь — только байты, без порта:
// правила проверяются тестами (test/tablo.test.js), порт открывают lib/tabloPort.js (сайт)
// и desktop/src/tablo.mjs (программа).
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.

export const TABLO_VIDY = ['off', 'led8', 'vfd']
export const TABLO_SKOROSTI = [2400, 4800, 9600, 19200]
export const tabloVid = (v) => (TABLO_VIDY.includes(v) ? v : 'off')
export const tabloSkorost = (v, vid = 'led8') => {
  const n = Number(v)
  return TABLO_SKOROSTI.includes(n) ? n : vid === 'vfd' ? 9600 : 2400
}

const ESC = 0x1b
const FF = 0x0c
const CR = 0x0d

// Сумма из строки денег («1 234,5 сомони», «−12 сомони») → «1234.50». Нет числа — ''
export function summaIz(text) {
  const s = String(text ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  if (!m) return ''
  const n = Number(m[0])
  return Number.isFinite(n) ? Math.abs(n).toFixed(2) : ''
}

// Латиница для двухстрочного табло: русские и таджикские буквы — по звучанию
const LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', ӣ: 'i', й: 'y', к: 'k', қ: 'q',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ӯ: 'u', ф: 'f', х: 'kh', ҳ: 'h', ц: 'ts', ч: 'ch',
  ҷ: 'j', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', '«': '"', '»': '"', '—': '-', '–': '-', '№': 'N',
}
export function latinica(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    const low = ch.toLowerCase()
    const r = LAT[low]
    if (r === undefined) out += /[\x20-\x7e]/.test(ch) ? ch : ''
    else out += ch === low || !r ? r : r[0].toUpperCase() + r.slice(1)
  }
  return out.replace(/\s+/g, ' ').trim()
}

const stroka = (text, align = 'left') => {
  const s = latinica(text).slice(0, 20)
  if (align === 'right') return s.padStart(20)
  if (align === 'center') return (' '.repeat(Math.floor((20 - s.length) / 2)) + s).padEnd(20)
  return s.padEnd(20)
}

// Что показать на табло по состоянию экрана покупателя:
// lamp — лампочка цифрового табло (0 — нет, 2 — «Итого», 4 — «Сдача»); amount — сумма или ''
// (табло чистое); line1, line2 — строки двухстрочного табло
export function tabloKadr(state) {
  const mode = state?.mode
  if (mode === 'cart' || mode === 'test') {
    const amount = summaIz(state?.total)
    return { lamp: 2, amount, line1: 'ITOGO:', line2: amount ? amount + ' TJS' : '' }
  }
  if (mode === 'thanks') {
    const change = summaIz(state?.change)
    if (change && Number(change) > 0) return { lamp: 4, amount: change, line1: 'SDACHA:', line2: change + ' TJS' }
    const amount = summaIz(state?.total)
    return { lamp: 2, amount, line1: 'ITOGO:', line2: amount ? amount + ' TJS' : '' }
  }
  return { lamp: 0, amount: '', line1: state?.shop || '', line2: '' }
}

const ascii = (s) => Array.from(String(s), (c) => c.charCodeAt(0) & 0x7f)

// Байты для табло. vid — 'led8' или 'vfd'; 'off' — пусто
export function tabloBytes(vid, kadr) {
  if (vid === 'led8') {
    // Восемь знакомест: число длиннее — без копеек
    let digits = String(kadr?.amount || '')
    if (digits.replace('.', '').length > 8) digits = digits.split('.')[0].slice(-8)
    const out = [ESC, 0x40, ESC, 0x73, 0x30 + (kadr?.lamp || 0)]
    if (!digits) return [...out, FF]
    return [...out, ESC, 0x51, 0x41, ...ascii(digits), CR]
  }
  if (vid === 'vfd') {
    const top = kadr?.amount ? stroka(kadr.line1) : stroka(kadr?.line1, 'center')
    const bottom = stroka(kadr?.line2, 'right')
    return [ESC, 0x40, FF, ...ascii(top), ...ascii(bottom)]
  }
  return []
}

// Проверка табло: «1234.56» и лампочка «Итого»
export const TABLO_PROBA = { mode: 'test', total: '1234,56' }
