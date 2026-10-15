// ── Разбор отсканированного кода: обычный штрихкод или DataMatrix маркировки ──
// Товары маркируются GS1 DataMatrix, где в начале зашит код товара GTIN (AI 01, 14 цифр).
// GTIN одинаков для всех пачек одного товара (в отличие от серийного номера — AI 21),
// поэтому по нему товар определяется однозначно. Приводим GTIN к EAN-13, чтобы он совпадал
// с обычным штрихкодом того же товара.

// Управляющие символы: FNC1 обычно приходит как GS (0x1D); плюс возможен ведущий AIM-идентификатор
// символогии вида «]d2» (GS1 DataMatrix), «]C1», «]e0» и т.п.
function stripPrefix(s) {
  return s.replace(/^\][A-Za-z]\d/, '').replace(/^[\x00-\x1f]+/, '')
}

// GTIN-14 → EAN-13 (индикатор упаковки 0 — как у потребительских пачек). Иначе оставляем как есть.
function gtinToEan(gtin) {
  return gtin.length === 14 && gtin[0] === '0' ? gtin.slice(1) : gtin
}

// Достаём код товара из скана. GS1 DataMatrix → GTIN (в форме EAN-13);
// обычный штрихкод / нераспознанное → очищенная строка как есть.
export function normalizeScan(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const t = stripPrefix(s)
  // GS1: AI 01 (GTIN, ровно 14 цифр) в начале данных
  const head = t.match(/^01(\d{14})/)
  if (head && t.length >= 16) return gtinToEan(head[1])
  // ...или AI 01 сразу после разделителя GS (некоторые сканеры так отдают)
  const afterGs = t.match(/[\x1d\x1e]01(\d{14})/)
  if (afterGs) return gtinToEan(afterGs[1])

  // QR со ссылкой (GS1 Digital Link): код товара зашит в адрес — .../01/04870204010053/21/…
  // Так печатают QR на упаковках, поэтому достаём GTIN, иначе товар не найдётся.
  if (/^https?:\/\//i.test(t) || t.includes('/01/')) {
    const dl = t.match(/\/01\/(\d{14})/) || t.match(/\/gtin\/(\d{14})/i)
    if (dl) return gtinToEan(dl[1])
    const q = t.match(/[?&](?:01|gtin)=(\d{13,14})/i)
    if (q) return gtinToEan(q[1])
  }

  // QR/код, где записан только номер товара (13–14 цифр, возможно с пробелами)
  const digitsOnly = t.replace(/\s+/g, '')
  if (/^\d{13,14}$/.test(digitsOnly)) return gtinToEan(digitsOnly)

  // Обычный/нераспознанный код — возвращаем ОЧИЩЕННУЮ строку (без AIM-префикса ]E0 и FNC1),
  // иначе сканер с AIM-идентификатором ломал бы поиск обычных штрихкодов.
  return t
}

// Канонический вид штрихкода для сравнения (GTIN-14 «0»+EAN13 → EAN-13).
export function canonBarcode(code) {
  const s = String(code ?? '').trim()
  if (/^\d{14}$/.test(s) && s[0] === '0') return s.slice(1)
  return s
}

// Похоже ли на DataMatrix/GS1 (для подсказок в интерфейсе)
export function looksLikeDataMatrix(raw) {
  const t = stripPrefix(String(raw ?? '').trim())
  return /^01\d{14}/.test(t) && t.length >= 18
}
