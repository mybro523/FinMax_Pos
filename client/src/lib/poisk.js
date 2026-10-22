// ── Поиск по товару: и по названию, и по штрихкоду ──
//
// Во всех поисках, где ищут товары (отчёт продажи, журналы приходов, возвратов,
// списаний, закупки у поставщиков), годится и название, и штрихкод: кусок цифр,
// вписанный руками, или код, выстреленный сканером, — в том числе маркировка
// DataMatrix (из неё берётся код товара, как на кассе). Здесь правила без окна:
// их проверяет test/poisk.test.js.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { canonBarcode, looksLikeDataMatrix, normalizeScan } from './scan.js'

// Что набрали в поиске. text — для названий и прочего текста; code — цифры, по
// которым искать в штрихкодах (пусто, если набрали не цифры или меньше трёх).
// Пустой запрос — null: подходит всё
export function poiskZapros(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const text = s.toLowerCase()
  if (looksLikeDataMatrix(s)) return { text, code: canonBarcode(normalizeScan(s)) }
  const digits = s.replace(/\s/g, '')
  return { text, code: /^\d{3,}$/.test(digits) ? canonBarcode(digits) : '' }
}

// Штрихкод подходит, если содержит набранные цифры. Код из 14 цифр с нулём впереди —
// тот же EAN-13, поэтому сверяем и его «канонический» вид
export function kodPodhodit(z, barcode) {
  if (!z?.code) return false
  const bc = String(barcode ?? '').trim()
  if (!bc) return false
  return bc.includes(z.code) || canonBarcode(bc).includes(z.code)
}

// Хотя бы один из штрихкодов подходит (у чека, прихода, возврата — коды его строк)
export const kodyPodhodyat = (z, codes) => !!z?.code && (codes || []).some((c) => kodPodhodit(z, c))

// Товар подходит: название (или другой текст строки) содержит набранное, либо
// штрихкод — набранные цифры. Пустой запрос — подходит всё
export function tovarPodhodit(z, text, barcode) {
  if (!z) return true
  return String(text ?? '').toLowerCase().includes(z.text) || kodPodhodit(z, barcode)
}

// Штрихкоды товаров по их id — для строк, где записаны только id и название товара
// (позиции чеков, приходов, возвратов, списаний)
export const shtrihkodyPoId = (products) => new Map((products || []).map((p) => [p.id, p.barcode || '']))
