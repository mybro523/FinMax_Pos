// ── Товары из Excel (12.11.2026) ──
// Владелец сервиса заводит магазин клиента сразу с его товарами (или дозагружает в заведённый).
// Файлы у клиентов разные: у одних две колонки без заголовка (штрихкод, название), у других —
// таблица с шапкой «Наименование / Цена / Остаток». Поэтому колонки ищутся так:
//   • есть строка-шапка со знакомыми словами — колонки по ней;
//   • нет — штрихкод там, где больше всего «длинных чисел», название — где больше всего текста.
// Товару без штрихкода даётся свой код (EAN-13 с «2», как кнопка генерации в карточке),
// повтор штрихкода — берётся первая строка, остальные — в пропущенные с причиной
// (why: 'noname' — нет названия, 'dup' — повтор строки ref, 'max' — больше MAX_TOVAROV).
import { generateEan13 } from './barcode.js'

export const MAX_TOVAROV = 50000

// Значение ячейки Excel → строка. exceljs отдаёт числа, даты, формулы ({ result }), ссылки
// ({ text }) и «богатый текст» ({ richText: [...] })
export function cellText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fullwide', { useGrouping: false }) : String(v)
  if (v instanceof Date) return ''
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x?.text || '').join('')
    if ('result' in v) return cellText(v.result)
    if ('text' in v) return cellText(v.text)
    return ''
  }
  return String(v)
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const isCode = (s) => /^\d{6,14}$/.test(s)
const num = (s) => {
  const t = String(s ?? '').replace(/\s/g, '').replace(',', '.')
  if (!t) return NaN
  return Number(t)
}

// Слова шапки → поле товара
const SHAPKA = [
  ['barcode', /штрих|barcode|ean|^код$|^код товара|^шк$/i],
  ['name', /наимен|назван|^товар|^name|^номенклатура/i],
  ['cost', /закуп|себест|^cost|входн/i],
  ['price', /цена|^price|продаж|розн/i],
  ['stock', /остат|кол-?во|количеств|^stock|^qty/i],
  ['category', /катег|групп|^category|^раздел/i],
  ['unit', /^ед|единиц|^unit/i],
]

function shapkaOf(row) {
  const cols = {}
  row.forEach((cell, i) => {
    const t = clean(cellText(cell))
    if (!t || t.length > 40) return
    for (const [field, re] of SHAPKA) {
      if (cols[field] === undefined && re.test(t)) {
        cols[field] = i
        break
      }
    }
  })
  // Шапка — если узнали хотя бы название (или штрихкод) и ещё одну колонку
  return cols.name !== undefined && Object.keys(cols).length >= 2 ? cols : null
}

// Колонки без шапки: по первым 300 непустым строкам
function guessCols(rows) {
  const sample = rows.slice(0, 300)
  const width = Math.max(0, ...sample.map((r) => r.length))
  let best = { code: -1, codeN: 0, name: -1, nameN: 0 }
  for (let c = 0; c < width; c++) {
    let codes = 0
    let texts = 0
    for (const r of sample) {
      const t = clean(cellText(r[c]))
      if (!t) continue
      if (isCode(t)) codes++
      else if (/[A-Za-zА-Яа-яЁёӢӣӮӯҲҳҶҷҚқҒғ]/.test(t) && t.length >= 2) texts++
    }
    if (codes > best.codeN) best = { ...best, code: c, codeN: codes }
    if (texts > best.nameN) best = { ...best, name: c, nameN: texts }
  }
  const cols = {}
  if (best.name >= 0) cols.name = best.name
  if (best.code >= 0 && best.code !== best.name) cols.barcode = best.code
  return cols
}

// Буква колонки Excel: 0 → A, 26 → AA
export const colLetter = (i) => {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// rows — [{ n: номер строки в Excel, cells: [значения ячеек с колонки A] }].
// taken — штрихкоды, которые заняты и без файла (для кодов товарам без штрихкода)
export function razobrat(rows, { taken = [] } = {}) {
  const list = (rows || []).filter((r) => r && Array.isArray(r.cells) && r.cells.some((v) => clean(cellText(v))))
  let cols = null
  let start = 0
  for (let i = 0; i < Math.min(10, list.length); i++) {
    const s = shapkaOf(list[i].cells)
    if (s) {
      cols = s
      start = i + 1
      break
    }
  }
  if (!cols) cols = guessCols(list.map((r) => r.cells))
  if (cols.name === undefined) return { items: [], skipped: [], cols, error: 'Не нашлась колонка с названиями товаров' }

  const items = []
  const skipped = []
  const byCode = new Map()
  const busy = new Set(Array.from(taken).map(String))
  const noCode = []
  for (const r of list.slice(start)) {
    const get = (f) => (cols[f] === undefined ? '' : clean(cellText(r.cells[cols[f]])))
    const name = get('name').slice(0, 200)
    let barcode = get('barcode').replace(/\s/g, '').slice(0, 64)
    if (!name) {
      skipped.push({ n: r.n, why: 'noname', text: barcode })
      continue
    }
    if (barcode && byCode.has(barcode)) {
      skipped.push({ n: r.n, why: 'dup', ref: byCode.get(barcode), text: `${barcode} ${name}` })
      continue
    }
    if (items.length >= MAX_TOVAROV) {
      skipped.push({ n: r.n, why: 'max', text: name })
      continue
    }
    const it = { barcode, name }
    const price = num(get('price'))
    const cost = num(get('cost'))
    const stock = num(get('stock'))
    if (price > 0) it.price = Math.round(price * 100) / 100
    if (cost > 0) it.cost = Math.round(cost * 100) / 100
    if (stock > 0) it.stock = Math.trunc(stock)
    const category = get('category').slice(0, 60)
    if (category) it.category = category
    const unit = get('unit').slice(0, 12)
    if (unit) it.unit = unit
    if (barcode) {
      byCode.set(barcode, r.n)
      busy.add(barcode)
    } else noCode.push(it)
    items.push(it)
  }
  // Свой код — после всех строк: не займёт штрихкод, который встретится в файле ниже
  for (const it of noCode) {
    it.barcode = generateEan13(busy)
    it.own = true
    busy.add(it.barcode)
  }
  return { items, skipped, cols, ownCodes: noCode.length }
}

// Прочитать первый лист .xlsx (exceljs грузится только сейчас — он тяжёлый)
export async function prochitatXlsx(file) {
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.xls') || name.endsWith('.csv')) throw new Error('Нужен файл .xlsx: откройте его в Excel и сохраните как «Книга Excel (.xlsx)»')
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(await file.arrayBuffer())
  } catch {
    throw new Error('Файл не читается как Excel (.xlsx)')
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0]
  if (!ws) throw new Error('В файле нет листов')
  const rows = []
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const v = Array.isArray(row.values) ? row.values.slice(1) : []
    rows.push({ n, cells: v })
  })
  return rows
}
