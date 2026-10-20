// ── Поле товара из двух частей: «Штрихкод» и «Наименование» ──
//
// В новом поступлении и в возврате поставщику товар выбирают двумя полями. В первое
// сканируют или вписывают штрихкод — во втором само появляется название. Во втором
// можно и набрать название — тогда штрихкод выбранного товара сам встаёт в первое.
// Здесь — правила без окна (pages/prihod/ProductPick.jsx — само поле): их можно проверить.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { canonBarcode, looksLikeDataMatrix, normalizeScan } from './scan.js'

// Товар по коду: тот же штрихкод или тот же товар из DataMatrix и QR (код товара
// в них свой, но это тот же EAN-13) — так же, как ищет касса (db/ops.js, findByBarcode)
export function productByCode(products, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const exact = products.find((p) => p.barcode === s)
  if (exact) return exact
  const norm = canonBarcode(normalizeScan(s))
  return norm ? products.find((p) => p.barcode && canonBarcode(p.barcode) === norm) || null : null
}

// Набранный код — начало другого, более длинного штрихкода: «79060» и «790601».
// Тогда товар с коротким кодом подставляется не сразу: человек, может быть, ещё печатает
export function codeIsPrefix(products, raw) {
  const s = String(raw ?? '').trim()
  return !!s && products.some((p) => p.barcode && p.barcode.length > s.length && p.barcode.startsWith(s))
}

// ── Через сколько подставить товар, набранный руками ──
// Без Enter: как только набранное совпало со штрихкодом товара. Но не в ту же
// миллисекунду: сканер вводит код за доли секунды и сам жмёт Enter — пауза нужна,
// чтобы он не «зацепился» на полпути за товар с коротким кодом. Человек между
// цифрами ждёт дольше — для него это всё равно «сразу». Код — начало более длинного:
// ждём дольше, чтобы успели допечатать. null — подставлять нечего
export const AUTO_MS = 350
export const AUTO_PREFIX_MS = 1200
export function autoPickDelay(products, raw) {
  if (!productByCode(products, raw)) return null
  return codeIsPrefix(products, raw) ? AUTO_PREFIX_MS : AUTO_MS
}

// ── Подсказки к полю «Наименование» ──
// По названию (и по цифрам штрихкода — вдруг помнят его кусок), не больше восьми
export function nameSuggest(products, q, limit = 8) {
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return []
  return products.filter((p) => String(p.name || '').toLowerCase().includes(needle) || String(p.barcode || '').includes(needle)).slice(0, limit)
}

// Похоже ли написанное на код, а не на название: так бывает, когда курсор стоял в
// поле названия, а кассир выстрелил сканером
export function looksLikeCode(raw) {
  const s = String(raw ?? '').trim()
  return /^\d{6,}$/.test(s.replace(/\s/g, '')) || looksLikeDataMatrix(s)
}
