// ── Своя цена за 1 шт (версия 1.5.11) и за 1 кг (версия 1.5.12) ──
//
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
// продаются по цене упаковки, отдельные штуки — по своей цене: «1 уп + 5 шт» при упаковке
// 150 и своей цене 2 — это 150 + 10. Своей цены нет — штука стоит как прежде: цена
// упаковки / штук в упаковке. Та же формула, что у сервера (server/src/common/piece.ts)
// и у окна (client/src/lib/units.js): чек кассы без интернета сервер пересчитывает и
// сверяет с её суммой.
//
// Дробный товар (кг, л, м, м²) внутри считается тысячными: «штука» — грамм, упаковка без
// мешка — одна единица, 1000 граммов. С 1.5.12 у него бывает и настоящая упаковка: мешок
// муки 50 кг — 50 000 граммов. Мешок продаётся по цене мешка, отдельные килограммы — по
// своей цене ЗА 1 КГ (piecePrice), если её задали, иначе цена мешка / 50. Своя цена бывает
// только у товара, упаковку которого вскрывают: у штучного — больше одной штуки в упаковке,
// у дробного — больше одной единицы.
import { D, toCents } from './money.mjs'
import { uppOf } from './units.mjs'

export const DROBNYE = ['кг', 'л', 'м', 'м²']
// Граммов (тысячных) в одной единице дробного товара
export const KG = 1000
export const isDrob = (unit) => DROBNYE.includes(String(unit ?? '').trim().toLowerCase())

// Сколько внутренних единиц в одной «штуке» своей цены: у штучного одна, у дробного 1000
export const pieceUnits = (x) => (isDrob(x?.unit) ? KG : 1)

// Упаковку вскрывают и продают отдельно: штуки из пачки, килограммы из мешка
export const opensPack = (x) => uppOf(x) > pieceUnits(x)

// У дробного товара в упаковке не меньше 1000 граммов (одной единицы) — как у сервера
export function packFor(unit, unitsPerPack) {
  const n = Math.max(1, Math.trunc(Number(unitsPerPack)) || 1)
  return isDrob(unit) ? Math.max(KG, n) : n
}

// Своя цена у карточки — в дирамах (столбец pieceC), за штуку или за килограмм, или null
export function ownPieceC(row) {
  if (!opensPack(row)) return null
  const c = Number(row?.pieceC)
  return Number.isInteger(c) && c > 0 ? c : null
}

// Своя цена у строки документа (piecePrice, сомони) — как её вписали, Decimal или null.
// Единица строки обязательна: без неё цена за килограмм легла бы на каждый грамм
export function ownPiece(line) {
  if (!opensPack(line)) return null
  if (line?.piecePrice === null || line?.piecePrice === undefined || line?.piecePrice === '') return null
  const v = Number(line.piecePrice)
  return Number.isFinite(v) && v > 0 ? D(v) : null
}

// Цена ОДНОЙ внутренней единицы (штуки, грамма): своя / pieceUnits или цена упаковки / штук
export function pieceOf(line) {
  const own = ownPiece(line)
  return own ? own.dividedBy(pieceUnits(line)) : D(line.price).dividedBy(uppOf(line))
}

// Сумма строки документа до скидки: упаковки по цене упаковки, штуки — по своей цене
// штуки (килограмма) или цена упаковки / штук в упаковке
export function grossOf(line) {
  return D(line.price).times(line.qty || 0).plus(pieceOf(line).times(line.pieces || 0))
}

// Своя цена из того, что прислали (окно, сервер): больше нуля — в дирамах, иначе null
export function pieceCentsIn(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? toCents(n) : null
}

// ── Возврат: сколько денег за units штук позиции чека ──
// Своей цены штуки нет — как всегда: заплачено за позицию / продано штук × возвращено.
// Есть — возвращаемые штуки считаются сначала отдельными (по своей цене штуки), сверх них —
// штуками из целых упаковок (цена упаковки / штук), а скидка позиции делится пропорционально.
// already — сколько штук этой позиции уже вернули раньше. Та же формула у сервера и окна
export function refundOf(line, units, already = 0) {
  const u = uppOf(line)
  const sold = (line.qty || 0) * u + (line.pieces || 0)
  if (!(sold > 0) || !(units > 0)) return D(0)
  const gross = grossOf(line)
  const paid = gross.minus(D(line.discount ?? 0))
  const own = ownPiece(line)
  if (own === null) return paid.dividedBy(sold).times(units)
  const piecesLeft = Math.max(0, (line.pieces || 0) - Math.max(0, already))
  const asPieces = Math.min(units, piecesLeft)
  const grossRet = pieceOf(line).times(asPieces).plus(D(line.price).dividedBy(u).times(units - asPieces))
  return gross.gt(0) ? grossRet.times(paid).dividedBy(gross) : D(0)
}

// Упаковка строки прихода или возврата поставщику, как её считало окно (1.5.12). Окно
// присылает её само; без неё — как у сервера (common/piece, lineUpp): у дробного товара
// килограммами, у остальных — по карточке
export function lineUpp(item, product) {
  const sent = Math.trunc(Number(item?.unitsPerPack))
  if (Number.isFinite(sent) && sent >= 1) return sent
  return isDrob(product?.unit) ? KG : uppOf(product)
}

// Цена за упаковку строки → за упаковку товара: 185 за килограмм при мешке 50 кг — 9250
// за мешок (server/src/common/cost.ts, costInPack). В дирамах
export function costCInPack(costC, fromUpp, toUpp) {
  const from = Math.max(1, Math.trunc(fromUpp) || 1)
  const to = Math.max(1, Math.trunc(toUpp) || 1)
  return from === to ? costC : Math.round((costC * to) / from)
}
