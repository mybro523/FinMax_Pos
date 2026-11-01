import { Prisma } from '@prisma/client'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

// ── Своя цена за 1 шт (версия 1.5.11) и за 1 кг (версия 1.5.12) ──
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
// продаются по цене упаковки, отдельные штуки — по своей цене: «1 уп + 5 шт» при упаковке
// 150 и своей цене 2 — это 150 + 10. Своей цены нет — штука стоит как прежде: цена
// упаковки / штук в упаковке. Одна формула на продажу, возврат и обмен с кассами — та же,
// что у сайта (client/src/lib/units.js) и у программы (desktop/src/local/piece.mjs).
//
// Дробный товар (кг, л, м, м²) внутри считается тысячными: «штука» — грамм, а упаковка без
// мешка — одна единица, 1000 граммов. С 1.5.12 у него бывает и настоящая упаковка: мешок муки
// 50 кг — это 50 000 граммов в упаковке. Тогда мешок продаётся по цене мешка, а отдельные
// килограммы — по своей цене за 1 кг, если её задали (по ней — piecePrice, ЗА КИЛОГРАММ), иначе
// цена мешка / 50. Своя цена бывает только у товара, упаковку которого вскрывают: у штучного —
// больше одной штуки в упаковке, у дробного — больше одной единицы.
export const DROBNYE = ['кг', 'л', 'м', 'м²']
// Граммов (тысячных) в одной единице дробного товара
export const KG = 1000
// Больше штук (граммов) в упаковке не бывает: бочка 200 л — 200 000, бухта кабеля 500 м —
// 500 000, мешок-«биг-бэг» тонна — 1 000 000. До 1.5.12 предел был 100 000 — мешок 100 кг
export const MAX_UPP = 1_000_000

export const isDrob = (unit: unknown) => DROBNYE.includes(String(unit ?? '').trim().toLowerCase())

// Единица обязательна (может быть null — тогда товар штучный): без неё своя цена дробного
// товара — за килограмм — легла бы на каждый грамм, и сумма вышла бы в тысячу раз больше
type Line = {
  qty?: number | null
  pieces?: number | null
  price: Prisma.Decimal.Value
  piecePrice?: Prisma.Decimal.Value | null
  unitsPerPack?: number | null
  unit: string | null | undefined
}

const upp = (x: { unitsPerPack?: number | null }) => Math.max(1, x?.unitsPerPack || 1)

// Сколько внутренних единиц в одной «штуке», за которую задаётся своя цена: у штучного — одна,
// у дробного — 1000 (граммов в килограмме)
export const pieceUnits = (x: { unit?: string | null }) => (isDrob(x?.unit) ? KG : 1)

// Упаковку вскрывают и продают отдельно: у штучного — штуки, у дробного — килограммы из мешка
export const opensPack = (x: { unit?: string | null; unitsPerPack?: number | null }) => upp(x) > pieceUnits(x)

// Своя цена — как её вписали (за штуку или за килограмм) — или null. Пусто, ноль, мусор — нет
export function ownPiece(x: Line): Prisma.Decimal | null {
  if (!opensPack(x)) return null
  if (x.piecePrice === null || x.piecePrice === undefined || x.piecePrice === '') return null
  try {
    const v = D(x.piecePrice)
    return v.isFinite() && v.gt(0) ? v : null
  } catch {
    return null
  }
}

// Цена ОДНОЙ внутренней единицы (штуки или грамма): своя / pieceUnits или цена упаковки / штук
export function pieceOf(x: Line): Prisma.Decimal {
  const own = ownPiece(x)
  return own ? own.dividedBy(pieceUnits(x)) : D(x.price).dividedBy(upp(x))
}

// Цена штуки или килограмма — как её показывают и сверяют: своя или по расчёту
export function piecePriceShown(x: Line): Prisma.Decimal {
  return pieceOf(x).times(pieceUnits(x))
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
  const grossRet = pieceOf(line).times(asPieces).plus(D(line.price).dividedBy(u).times(units - asPieces))
  return gross.gt(0) ? grossRet.times(paid).dividedBy(gross) : D(0)
}

// Больше какой суммы касса без связи вернуть не могла: она могла не знать о возвратах с
// других касс, и её «уже вернули» — своё. Сумма линейна по числу «отдельных» штук, поэтому
// предел — большая из двух крайностей: всё сначала отдельными штуками или всё упаковками
export function refundCeiling(line: Line & { discount?: Prisma.Decimal.Value | null }, units: number): Prisma.Decimal {
  return Prisma.Decimal.max(refundOf(line, units, 0), refundOf(line, units, line.pieces || 0))
}

// ── Упаковка дробного товара (1.5.12) ──
// Без мешка у дробного товара в упаковке 1000 граммов — одна единица. Меньше не бывает:
// «упаковка» меньше килограмма значила бы, что цена за неё — за полкило
export function packFor(unit: unknown, unitsPerPack: number | null | undefined): number {
  const n = Math.max(1, Math.trunc(Number(unitsPerPack) || 1))
  return isDrob(unit) ? Math.max(KG, n) : n
}

// Сколько штук в упаковке у товара, которого касса прежней версии ещё не знала с мешком.
// Прежние окна (сайт до перезагрузки, программа до обновления) считали строку весового
// прихода и возврата поставщику КИЛОГРАММАМИ — упаковкой в 1000 граммов, что бы ни стояло в
// карточке. Новые присылают упаковку строки сами
export function lineUpp(item: { unitsPerPack?: number | null }, product: { unit?: string | null; unitsPerPack?: number | null }): number {
  const sent = Math.trunc(Number(item.unitsPerPack))
  if (Number.isFinite(sent) && sent >= 1) return sent
  return isDrob(product.unit) ? KG : upp(product)
}

// Строка прежнего окна (без упаковки строки) у товара в мешке. Прежнее окно считало её
// килограммами, а цену подставляло из карточки — за мешок, хотя подписывало «за кг». Что
// значат деньги такой строки, не понять: 9250 за кг записали бы долг поставщику в 50 раз
// больше. Поэтому такую строку не принимаем — пусть оформят обновлённым окном
export function oldLineOnSack(item: { unitsPerPack?: number | null }, product: { unit?: string | null; unitsPerPack?: number | null }) {
  return !(Math.trunc(Number(item.unitsPerPack)) >= 1) && isDrob(product.unit) && opensPack(product)
}
export const OLD_WINDOW_SACK = (name: string) =>
  `«${name}»: у товара теперь упаковка (мешок). Обновите программу (сайт — перезагрузите страницу) и оформите заново.`
