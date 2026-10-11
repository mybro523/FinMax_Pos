import { Prisma } from '@prisma/client'
import { D } from './money'

// ── Средневзвешенная закупочная цена ──
// После прихода закупочная цена товара становится средней между тем, что уже лежит
// на складе, и тем, что привезли. Считать это надо В ШТУКАХ, а не в упаковках:
// у делимых товаров часть остатка лежит во вскрытой упаковке, и если её не учесть,
// старый остаток недооценивается, а цена уезжает в сторону последней поставки.
//
// Пример: в упаковке 20 таблеток, на складе 0 целых пачек и 15 таблеток по 100 сомони
// за пачку. Привезли 1 пачку по 200. По упаковкам старый остаток весит ноль и цена
// станет 200 — хотя на полке лежит почти пачка старого товара. По штукам получится
// (0,75 × 100 + 200) / 1,75 ≈ 157 — это и есть настоящая средняя.

export interface WeightedCostInput {
  stock: number // целых упаковок на складе до прихода
  looseUnits?: number | null // штук во вскрытой упаковке
  unitsPerPack?: number | null // штук в упаковке
  cost: Prisma.Decimal | number | string // текущая закупочная цена УПАКОВКИ
  addPacks: number // сколько упаковок пришло
  addValue: Prisma.Decimal | number | string // на какую сумму пришло
}

// Возвращает новую закупочную цену УПАКОВКИ (как и хранится в карточке товара).
export function weightedPackCost(input: WeightedCostInput): Prisma.Decimal {
  const upp = Math.max(1, input.unitsPerPack || 1)
  const oldUnits = D(input.stock || 0).times(upp).plus(input.looseUnits || 0)
  const addUnits = D(input.addPacks || 0).times(upp)
  const totalUnits = oldUnits.plus(addUnits)

  // Ни старого остатка, ни прихода — менять нечего
  if (totalUnits.lte(0)) return D(input.cost)

  const oldValue = D(input.cost).dividedBy(upp).times(oldUnits)
  return oldValue.plus(D(input.addValue)).dividedBy(totalUnits).times(upp)
}

// ── Закупочная цена заново, по тому что реально лежит на полке ──
//
// Нужна там, где приход правят или удаляют. Обратить средневзвешенную формулу
// нельзя: она необратима — из «сейчас в среднем 15» не восстановить, сколько было
// до последней поставки. Зато каждая партия помнит СВОЮ цену, поэтому цену товара
// можно не «откатывать», а просто пересчитать по оставшимся партиям. Получается
// точное число, а не приблизительное.
//
// Считаем в штуках по той же причине, что и в weightedPackCost: часть остатка
// лежит во вскрытой упаковке, и по упаковкам она весила бы ноль.
export function costFromBatches(
  batches: { units: number; cost: Prisma.Decimal | number | string }[],
  unitsPerPack?: number | null,
  fallback: Prisma.Decimal | number | string = 0,
): Prisma.Decimal {
  const upp = Math.max(1, unitsPerPack || 1)
  let units = D(0)
  let value = D(0)
  for (const b of batches) {
    if (!b || b.units <= 0) continue
    units = units.plus(b.units)
    value = value.plus(D(b.cost).dividedBy(upp).times(b.units))
  }
  // Полка пуста — считать не из чего. Оставляем последнюю известную цену:
  // она пригодится, когда товар привезут снова, и не обнуляет отчёты
  if (units.lte(0)) return D(fallback)
  return value.dividedBy(units).times(upp)
}
