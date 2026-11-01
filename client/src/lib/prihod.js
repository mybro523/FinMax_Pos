// ── Расчёты нового прихода ──
// Строка прихода в окне: сколько пришло (упаковки и штуки сверх них, у весового —
// килограммы), цена поставщика, его скидка, цена продажи и срок. Здесь — всё, что из
// этого считается: закупочная цена со скидкой, суммы строки, итоги для панели справа
// и строка для отправки. Экран только показывает, считает — этот файл: так одна и та
// же формула не расходится между таблицей, панелью итогов и тем, что уходит на сервер.
//
// Цена поставщика и цена продажи — за упаковку (у весового без мешка — за килограмм), как в
// карточке товара. Штуки (килограммы) сверх целых упаковок оплачиваются долей упаковки.
//
// Весовой товар в мешке (1.5.12) — как штучный: «2 уп + 10 кг» при мешке 50 кг, цены — за
// мешок. Сколько в упаковке, можно поменять прямо в приходе (поле «Кол-во в упаковке»):
// строка помнит, с какой упаковкой товар пришёл (upp0), и при проведении карточка получает
// новую (packChanged). У штучного так же: пачка была 20 шт, стала 24
import { uppOf, isDivisible, isVesovoy, edinica, gramsOfKg, kgText, stockUnits, KG } from './units.js'

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

// ── Упаковка строки (1.5.12) ──
// Поле «Кол-во в упаковке»: у штучного — штук в упаковке (целое), у весового — кг в мешке
// (дробное; пусто или не больше 1 — без мешка, на вес). Ниже — перевод поля в «штук
// (граммов) в упаковке» и обратно
export const MAX_UPP = 1_000_000
export function packFromField(v, ves) {
  const n = num(v)
  if (ves) return n > 1 ? Math.min(MAX_UPP, Math.round(n * KG)) : KG
  return Math.min(MAX_UPP, Math.max(1, Math.trunc(n) || 1))
}
// Точкой, как поле её и держит (NumberInput): «2.5»
export const packField = (upp, ves) => (ves ? (upp > KG ? String(upp / KG) : '') : String(Math.max(1, Math.trunc(upp) || 1)))

// Строка с другой упаковкой: делится ли она, как теперь считается количество
export function withPack(l, upp) {
  const u = Math.max(1, Math.trunc(upp) || 1)
  return { ...l, unitsPerPack: u, div: isDivisible({ unit: l.unit, unitsPerPack: u }) }
}

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
    // Штук в упаковке (у весового — граммов: без мешка 1000, мешок 50 кг — 50 000): по нему
    // uppOf(строки). upp0 — какой упаковка была в карточке: другая — её поменяли в приходе
    unitsPerPack: uppOf(p),
    upp0: uppOf(p),
    // Цены и остаток товара до прихода — по ним спросим, за что были цены, если упаковку сменят
    cost0: Number(p.cost) || 0,
    stock0: stockUnits(p),
    ves,
    // Делимую упаковку (20 штук в пачке, мешок 50 кг) принимают «упаковки + штуки (кг)»
    div: isDivisible(p),
    qty: '1',
    pieces: '',
    base: String(Number(p.cost) || ''),
    disc: disc === '' || disc === null || disc === undefined ? '' : String(disc),
    price: String(Number(p.price) || ''),
    price0: Number(p.price) || 0,
    // Своя цена за 1 шт (1.5.11): что в карточке сейчас и что вписали в приходе
    piece: Number(p.piecePrice) > 0 ? String(Number(p.piecePrice)) : '',
    piece0: Number(p.piecePrice) > 0 ? Number(p.piecePrice) : null,
    mk: null,
    expiryDate: '',
  }
}

// Штук (у весового — граммов) в строке. Весовой без мешка — одним числом в килограммах,
// в мешке — мешки и килограммы сверх них
export function lineUnits(l) {
  if (l.ves && !l.div) return gramsOfKg(l.qty)
  const packs = Math.max(0, Math.trunc(num(l.qty)))
  const pieces = !l.div ? 0 : l.ves ? gramsOfKg(l.pieces) : Math.max(0, Math.trunc(num(l.pieces)))
  return packs * uppOf(l) + pieces
}

// Сколько это упаковок (у весового без мешка — килограммов) — дробно: «2 уп + 5 шт» по 20
// в пачке = 2,25
export const linePacks = (l) => lineUnits(l) / uppOf(l)

export const lineCost = (l) => discCost(l.base, l.disc)
// Сумма по цене поставщика (до скидки), к оплате (со скидкой) и в рознице
export const lineBase = (l) => Math.max(0, num(l.base)) * linePacks(l)
export const lineTotal = (l) => lineCost(l) * linePacks(l)
export const lineRetail = (l) => Math.max(0, num(l.price)) * linePacks(l)

// Цена продажи одной штуки (у мешка — одного килограмма) — по расчёту: цена упаковки /
// штук (кг) в упаковке
export const piecePrice = (l) => (l.div ? (num(l.price) / uppOf(l)) * (l.ves ? KG : 1) : num(l.price))
// Своя цена штуки (у мешка — за 1 кг), вписанная в строке: больше нуля — она, иначе null
export const ownPiece = (l) => (l.div && num(l.piece) > 0 ? kop(num(l.piece)) : null)
// Своя цена штуки в строке не та, что была в карточке до прихода
export const pieceChanged = (l) => l.div && ownPiece(l) !== (l.piece0 ?? null)
// Упаковку поменяли в этом приходе (1.5.12)
export const packChanged = (l) => !!l.productId && l.upp0 !== undefined && uppOf(l) !== l.upp0
// Упаковку поменяли у товара с ценами или остатком: надо спросить, за что были прежние цены —
// за прежнюю упаковку (перевести ×новая/прежняя) или уже за новую (оставить). Как в карточке
export function packAsk(l) {
  if (!packChanged(l)) return null
  const has = num(l.cost0) > 0 || num(l.price0) > 0 || num(l.stock0) > 0
  return has ? { was: l.upp0, now: uppOf(l), ratio: uppOf(l) / l.upp0 } : null
}

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
// «2 уп + 5 шт», «1,25 кг», «10 шт», у мешков — «2 уп + 10 кг». t — перевод подписей единиц
export function qtyText(l, t = (s) => s) {
  if (l.ves && !l.div) return `${kgText(gramsOfKg(l.qty))} ${t(l.unit)}`
  const units = lineUnits(l)
  const upp = uppOf(l)
  // Упаковка — «уп» (у весового «кг» — это уже его штука), отдельные — «шт» или «кг»
  const uL = l.ves ? 'уп' : l.unit
  if (!l.div) return `${Math.trunc(units / upp)} ${t(uL)}`
  const packs = Math.trunc(units / upp)
  const pieces = units % upp
  const pL = l.ves ? `${kgText(pieces)} ${t(l.unit)}` : `${pieces} ${t('шт')}`
  if (!pieces) return `${packs} ${t(uL)}`
  if (!packs) return pL
  return `${packs} ${t(uL)} + ${pL}`
}

// «В упаковке»: у делимой — сколько штук, у мешка — сколько кг, у весового без мешка — единица
export const packText = (l, t = (s) => s) =>
  l.ves ? (l.div ? `${kgText(uppOf(l))} ${t(l.unit)}` : t(l.unit)) : l.div ? `${uppOf(l)} ${t('шт')}` : `1 ${t(l.unit)}`

// ── Проверка строки ──
// Пусто — строка годится. Иначе — что не так, чтобы показать человеку
export function lineProblem(l) {
  if (l.ves && !l.div) {
    if (gramsOfKg(l.qty) <= 0) return 'укажите вес'
  } else if (lineUnits(l) <= 0) {
    return 'укажите количество'
  }
  if (packAsk(l) && l.packScale !== 'scale' && l.packScale !== 'keep') return 'укажите, за что были прежние цены'
  if (String(l.base ?? '').trim() === '' || num(l.base) < 0) return 'укажите цену поставщика'
  if (num(l.disc) < 0 || num(l.disc) > 100) return 'скидка — от 0 до 100%'
  return ''
}

// ── Строка для отправки ──
// Штуки сверх целой упаковки перекладываются в упаковки: «1 уп + 25 шт» по 20 в
// пачке уходит как 2 уп + 5 шт. Новую цену продажи шлём, только если её поменяли —
// иначе приход затёр бы цену, которую за это время поправили в карточке. Упаковку строки
// шлём всегда (так сервер прочтёт qty и pieces, даже если упаковку товара за это время
// сменили), а packChanged — если её поменяли в этом приходе: карточка получит её (1.5.12)
export function toItem(l) {
  const units = lineUnits(l)
  const upp = uppOf(l)
  const price = num(l.price) > 0 && num(l.price) !== l.price0 ? kop(num(l.price)) : undefined
  // Своя цена штуки — тоже только если её поменяли (пусто — «своей нет», null)
  const piecePrice = pieceChanged(l) ? ownPiece(l) : undefined
  return {
    productId: l.productId,
    name: l.name,
    qty: Math.floor(units / upp),
    pieces: units % upp,
    unitsPerPack: upp,
    ...(packChanged(l) ? { packChanged: true, ...(packAsk(l) && l.packScale === 'scale' ? { packScale: true } : {}) } : {}),
    cost: lineCost(l),
    discount: discPct(l.disc),
    expiryDate: l.expiryDate || '',
    ...(price !== undefined ? { price } : {}),
    ...(piecePrice !== undefined ? { piecePrice } : {}),
  }
}

// ══════════ Возврат поставщику ══════════
// Строка возврата: что отдаём поставщику, сколько (упаковки и штуки сверх них, у
// весового — килограммы) и по какой цене он засчитывает. Сколько лежит на складе —
// снимком при добавлении: больше, чем есть, вернуть нельзя (просроченное отдать
// можно — его чаще всего и возвращают).

// Цена возврата по умолчанию — по которой этот поставщик привёз товар в последний
// раз (уже со скидкой). Не привозил или поставщик не выбран — закупочная из карточки.
// arrivals — журнал приходов, свежие первыми. upp — упаковка товара сейчас: строка прихода
// могла быть записана в другой (185 за кг, а теперь мешок 50 кг — это 9250 за мешок, 1.5.12)
export function lastSupplierCost(arrivals, supplierId, productId, upp = 0) {
  if (!supplierId) return null
  for (const a of arrivals || []) {
    if (a.supplierId !== supplierId) continue
    const it = (a.items || []).find((i) => i.productId === productId)
    if (!it) continue
    const cost = Number(it.cost) || 0
    const was = Number(it.unitsPerPack) || 0
    return upp > 0 && was > 0 && was !== upp ? kop((cost * upp) / was) : cost
  }
  return null
}

export function retLineFromProduct(p, { arrivals, supplierId } = {}) {
  const last = lastSupplierCost(arrivals, supplierId, p.id, uppOf(p))
  return {
    ...lineFromProduct(p),
    // Здесь price — цена возврата за упаковку (килограмм), а не цена продажи
    price: String(last ?? (Number(p.cost) || '')),
    fromArrival: last !== null,
    stock: stockUnits(p),
  }
}

export const retLineSum = (l) => Math.max(0, num(l.price)) * linePacks(l)

export function retSummary(lines) {
  const s = { count: lines.length, packs: 0, total: 0 }
  for (const l of lines) {
    s.packs += linePacks(l)
    s.total += retLineSum(l)
  }
  s.packs = Math.round(s.packs * 1000) / 1000
  s.total = kop(s.total)
  return s
}

// Пусто — строка годится, иначе — что не так
export function retProblem(l) {
  const units = lineUnits(l)
  if (units <= 0) return l.ves && !l.div ? 'укажите вес' : 'укажите количество'
  if (units > Math.max(0, Number(l.stock) || 0)) return 'на складе меньше'
  if (String(l.price ?? '').trim() === '' || num(l.price) < 0) return 'укажите цену возврата'
  return ''
}

// Строка для отправки: штуки сверх целой упаковки — в упаковки, цена — до дирама. Упаковка
// строки — с ней, чтобы сервер прочёл qty и pieces так же (1.5.12)
export function toRetItem(l) {
  const units = lineUnits(l)
  const upp = uppOf(l)
  return { productId: l.productId, name: l.name, qty: Math.floor(units / upp), pieces: units % upp, unitsPerPack: upp, price: kop(num(l.price)) }
}
