// ── Своя цена за 1 шт (версия 1.5.11) ──
//
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
// продаются по цене упаковки, отдельные штуки — по своей цене: «1 уп + 5 шт» при упаковке
// 150 и своей цене 2 — это 150 + 10. Своей цены нет — штука стоит как прежде: цена
// упаковки / штук в упаковке. Та же формула, что у сервера (server/src/common/piece.ts)
// и у окна (client/src/lib/units.js): чек кассы без интернета сервер пересчитывает и
// сверяет с её суммой.
//
// Своя цена бывает только у товара, который делится на штуки и продаётся целыми: у
// дробного (кг, л, м, м²) «штука» — это грамм, своей цены у неё нет.
import { D, toCents } from './money.mjs'
import { uppOf } from './units.mjs'

export const DROBNYE = ['кг', 'л', 'м', 'м²']
const drobnyy = (x) => DROBNYE.includes(String(x?.unit || '').trim().toLowerCase())

// Своя цена штуки у карточки — в дирамах (столбец pieceC) или null
export function ownPieceC(row) {
  if (uppOf(row) <= 1 || drobnyy(row)) return null
  const c = Number(row?.pieceC)
  return Number.isInteger(c) && c > 0 ? c : null
}

// Своя цена штуки у строки документа (piecePrice, сомони) — числом Decimal или null
export function ownPiece(line) {
  if (uppOf(line) <= 1 || drobnyy(line)) return null
  if (line?.piecePrice === null || line?.piecePrice === undefined || line?.piecePrice === '') return null
  const v = Number(line.piecePrice)
  return Number.isFinite(v) && v > 0 ? D(v) : null
}

// Сумма строки документа до скидки: упаковки по цене упаковки, штуки — по своей цене
// штуки или цена упаковки / штук в упаковке
export function grossOf(line) {
  const piece = ownPiece(line) ?? D(line.price).dividedBy(uppOf(line))
  return D(line.price).times(line.qty || 0).plus(piece.times(line.pieces || 0))
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
  const grossRet = own.times(asPieces).plus(D(line.price).dividedBy(u).times(units - asPieces))
  return gross.gt(0) ? grossRet.times(paid).dividedBy(gross) : D(0)
}
