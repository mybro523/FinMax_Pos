import { Prisma } from '@prisma/client'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

// ── Своя цена за 1 шт (версия 1.5.11) ──
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
// продаются по цене упаковки, отдельные штуки — по своей цене: «1 уп + 5 шт» при упаковке
// 150 и своей цене 2 — это 150 + 10. Своей цены нет — штука стоит как прежде: цена
// упаковки / штук в упаковке. Одна формула на продажу, возврат и обмен с кассами — та же,
// что у сайта (client/src/lib/units.js) и у программы (desktop/src/local/units.mjs).
//
// Своя цена бывает только у товара, который делится на штуки и продаётся целыми: у
// дробного (кг, л, м, м²) «штука» — это грамм, своей цены у неё нет.
export const DROBNYE = ['кг', 'л', 'м', 'м²']

type Line = {
  qty?: number | null
  pieces?: number | null
  price: Prisma.Decimal.Value
  piecePrice?: Prisma.Decimal.Value | null
  unitsPerPack?: number | null
  unit?: string | null
}

const upp = (x: { unitsPerPack?: number | null }) => Math.max(1, x?.unitsPerPack || 1)

// Своя цена штуки или null. Пусто, ноль, мусор — своей цены нет
export function ownPiece(x: Line): Prisma.Decimal | null {
  if (upp(x) <= 1) return null
  if (x.unit && DROBNYE.includes(String(x.unit).trim().toLowerCase())) return null
  if (x.piecePrice === null || x.piecePrice === undefined || x.piecePrice === '') return null
  try {
    const v = D(x.piecePrice)
    return v.isFinite() && v.gt(0) ? v : null
  } catch {
    return null
  }
}

// Цена одной штуки: своя или цена упаковки / штук в упаковке
export function pieceOf(x: Line): Prisma.Decimal {
  return ownPiece(x) ?? D(x.price).dividedBy(upp(x))
}

// Сумма позиции до скидки: упаковки по цене упаковки, штуки по цене штуки
export function grossOf(x: Line): Prisma.Decimal {
  return D(x.price).times(x.qty || 0).plus(pieceOf(x).times(x.pieces || 0))
}

// Своя цена из того, что прислали (сайт, касса): число больше нуля — она, иначе null
export function piecePriceIn(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? D(n).toDecimalPlaces(2) : null
}

// ── Возврат: сколько денег за units штук позиции чека ──
// Своей цены штуки нет — как всегда: заплачено за позицию / продано штук × возвращено.
// Есть — возвращаемые штуки считаются сначала отдельными (по своей цене штуки), сверх них —
// штуками из целых упаковок (цена упаковки / штук), а скидка позиции делится пропорционально:
// иначе за 5 штук, купленных по 2, вернули бы 8,42 вместо 10. already — сколько штук этой
// позиции уже вернули раньше. Та же формула у сайта и программы
export function refundOf(line: Line & { discount?: Prisma.Decimal.Value | null }, units: number, already = 0): Prisma.Decimal {
  const u = upp(line)
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

// Больше какой суммы касса без связи вернуть не могла: она могла не знать о возвратах с
// других касс, и её «уже вернули» — своё. Сумма линейна по числу «отдельных» штук, поэтому
// предел — большая из двух крайностей: всё сначала отдельными штуками или всё упаковками
export function refundCeiling(line: Line & { discount?: Prisma.Decimal.Value | null }, units: number): Prisma.Decimal {
  return Prisma.Decimal.max(refundOf(line, units, 0), refundOf(line, units, line.pieces || 0))
}
