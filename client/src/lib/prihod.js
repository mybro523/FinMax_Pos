// ── Расчёты нового прихода ──
// Строка прихода в окне: сколько пришло (упаковки и штуки сверх них, у весового —
// килограммы), цена поставщика, его скидка, цена продажи и срок. Здесь — всё, что из
// этого считается: закупочная цена со скидкой, суммы строки, итоги для панели справа
// и строка для отправки. Экран только показывает, считает — этот файл: так одна и та
// же формула не расходится между таблицей, панелью итогов и тем, что уходит на сервер.
//
// Цена поставщика и цена продажи — за упаковку (у весового — за килограмм), как в
// карточке товара. Штуки сверх целых упаковок оплачиваются долей упаковки.
import { uppOf, isDivisible, isVesovoy, edinica, gramsOfKg, kgText } from './units.js'

// Число из поля: пусто и мусор — ноль, запятая — как точка
export const num = (v) => {
  const n = Number(String(v ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// Хвост двоичной арифметики (8,499999…) — долой, но не до копеек: сумма строки
// считается от неокруглённой цены и сходится с накладной (33,333 × 3 = 100,00)
const exact = (v) => Math.round(v * 1e6) / 1e6
export const kop = (v) => Math.round((Number(v) || 0) * 100) / 100

// Число для ячейки таблицы — без «сомони»: в узкой колонке слово съедало бы место.
// Целые без дробной части, дробные — до сотых, разряды через пробел: «1 234,5»
const NF = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
export const n2 = (v) => NF.format(kop(v))
// Проценты — с запятой, как пишут по-русски: «13,06%»
export const pct = (v) => `${NF.format(kop(v))}%`

// Скидка поставщика, % — от 0 до 100, до сотых
export const discPct = (disc) => kop(clamp(num(disc), 0, 100))

// Закупочная цена со скидкой поставщика — по ней считается себестоимость
export const discCost = (base, disc) => exact(Math.max(0, num(base)) * (1 - discPct(disc) / 100))

// ── Строка из карточки товара ──
// discAll — скидка «на все товары», если её уже вписали: новая строка встаёт с ней
export function lineFromProduct(p, { disc = '' } = {}) {
  const ves = isVesovoy(p)
  return {
    key: p.id,
    productId: p.id,
    name: p.name,
    barcode: p.barcode || '',
    category: p.category || '',
    unit: edinica(p),
    // Штук в упаковке (у весового — граммов в килограмме): по нему uppOf(строки)
    unitsPerPack: uppOf(p),
    ves,
    // Делимую упаковку (20 штук в пачке) принимают «упаковки + штуки»
    div: !ves && isDivisible(p),
    qty: '1',
    pieces: '',
    base: String(Number(p.cost) || ''),
    disc: disc === '' || disc === null || disc === undefined ? '' : String(disc),
    price: String(Number(p.price) || ''),
    price0: Number(p.price) || 0,
    mk: null,
    expiryDate: '',
  }
}

// Штук (у весового — граммов) в строке
export function lineUnits(l) {
  if (l.ves) return gramsOfKg(l.qty)
  const packs = Math.max(0, Math.trunc(num(l.qty)))
  const pieces = l.div ? Math.max(0, Math.trunc(num(l.pieces))) : 0
  return packs * uppOf(l) + pieces
}

// Сколько это упаковок (килограммов) — дробно: «2 уп + 5 шт» по 20 в пачке = 2,25
export const linePacks = (l) => lineUnits(l) / (l.ves ? 1000 : uppOf(l))

export const lineCost = (l) => discCost(l.base, l.disc)
// Сумма по цене поставщика (до скидки), к оплате (со скидкой) и в рознице
export const lineBase = (l) => Math.max(0, num(l.base)) * linePacks(l)
export const lineTotal = (l) => lineCost(l) * linePacks(l)
export const lineRetail = (l) => Math.max(0, num(l.price)) * linePacks(l)

// Цена продажи одной штуки делимой упаковки
export const piecePrice = (l) => (l.div ? num(l.price) / uppOf(l) : num(l.price))

// ── Итоги для панели справа ──
export function summary(lines) {
  const s = { count: lines.length, packs: 0, base: 0, total: 0, retail: 0 }
  for (const l of lines) {
    s.packs += linePacks(l)
    s.base += lineBase(l)
    s.total += lineTotal(l)
    s.retail += lineRetail(l)
  }
  s.packs = Math.round(s.packs * 1000) / 1000
  s.base = kop(s.base)
  s.total = kop(s.total)
  s.retail = kop(s.retail)
  s.discount = kop(s.base - s.total)
  s.discountPct = s.base > 0 ? kop((s.discount / s.base) * 100) : 0
  // Ожидаемая наценка — к закупу со скидкой, как и наценка в строке
  s.markup = kop(s.retail - s.total)
  s.markupPct = s.total > 0 ? kop((s.markup / s.total) * 100) : 0
  return s
}

// ── Сколько пришло — словами ──
// «2 уп + 5 шт», «1,25 кг», «10 шт». t — перевод подписей единиц
export function qtyText(l, t = (s) => s) {
  if (l.ves) return `${kgText(gramsOfKg(l.qty))} ${t(l.unit)}`
  const units = lineUnits(l)
  const upp = uppOf(l)
  if (!l.div) return `${Math.trunc(units / upp)} ${t(l.unit)}`
  const packs = Math.trunc(units / upp)
  const pieces = units % upp
  if (!pieces) return `${packs} ${t(l.unit)}`
  if (!packs) return `${pieces} ${t('шт')}`
  return `${packs} ${t(l.unit)} + ${pieces} ${t('шт')}`
}

// «В упаковке»: у делимой — сколько штук, у весового — единица
export const packText = (l, t = (s) => s) => (l.ves ? t(l.unit) : l.div ? `${uppOf(l)} ${t('шт')}` : `1 ${t(l.unit)}`)

// ── Проверка строки ──
// Пусто — строка годится. Иначе — что не так, чтобы показать человеку
export function lineProblem(l) {
  if (l.ves) {
    if (gramsOfKg(l.qty) <= 0) return 'укажите вес'
  } else if (lineUnits(l) <= 0) {
    return 'укажите количество'
  }
  if (String(l.base ?? '').trim() === '' || num(l.base) < 0) return 'укажите цену поставщика'
  if (num(l.disc) < 0 || num(l.disc) > 100) return 'скидка — от 0 до 100%'
  return ''
}

// ── Строка для отправки ──
// Штуки сверх целой упаковки перекладываются в упаковки: «1 уп + 25 шт» по 20 в
// пачке уходит как 2 уп + 5 шт. Новую цену продажи шлём, только если её поменяли —
// иначе приход затёр бы цену, которую за это время поправили в карточке
export function toItem(l) {
  const units = lineUnits(l)
  const upp = l.ves ? 1000 : uppOf(l)
  const price = num(l.price) > 0 && num(l.price) !== l.price0 ? kop(num(l.price)) : undefined
  return {
    productId: l.productId,
    name: l.name,
    qty: Math.floor(units / upp),
    pieces: units % upp,
    cost: lineCost(l),
    discount: discPct(l.disc),
    expiryDate: l.expiryDate || '',
    ...(price !== undefined ? { price } : {}),
  }
}
