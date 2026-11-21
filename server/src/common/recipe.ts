import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

// ── Состав товара (сырьё), версия 1.8.5 ──
// Составной товар собирается из других товаров-ингредиентов. При продаже списывается
// состав, а не остаток самого товара. units строки — сколько ШТУК ингредиента (у дробного —
// тысячных: граммов, миллилитров) нужно на ОДНУ штуку составного товара.

type Tx = Prisma.TransactionClient

export type RecipeLine = { ingredientId: string; units: number; ord: number }

const MAX_LINES = 200

// Из запроса ([{ ingredientId, units }]) — в чистые строки. Повторы одного ингредиента и
// нулевые количества отбрасываем. undefined/null — «состав не прислали» (пустой список)
export function normalizeRecipe(input: any): RecipeLine[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new BadRequestException('Состав: ожидался список')
  const out: RecipeLine[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, MAX_LINES)) {
    const ingredientId = String(raw?.ingredientId || '').trim()
    const units = Math.trunc(Number(raw?.units) || 0)
    if (!ingredientId || units <= 0 || seen.has(ingredientId)) continue
    seen.add(ingredientId)
    out.push({ ingredientId, units, ord: out.length })
  }
  return out
}

// Сохранить состав товара (замена целиком). Ингредиент должен существовать, не быть самим
// товаром и не быть другим составным товаром — иначе получились бы кольца и вложенное
// списание, которое здесь намеренно не поддерживается.
export async function saveRecipe(tx: Tx, productId: string, recipe: RecipeLine[]) {
  await tx.recipeItem.deleteMany({ where: { productId } })
  if (!recipe.length) return
  const ids = recipe.map((r) => r.ingredientId)
  if (ids.includes(productId)) throw new BadRequestException('Товар не может быть ингредиентом сам себя')
  const found = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, recipe: { select: { id: true }, take: 1 } },
  })
  const byId = new Map(found.map((p) => [p.id, p]))
  for (const r of recipe) {
    const ing = byId.get(r.ingredientId)
    if (!ing) throw new BadRequestException('Ингредиент не найден — обновите список товаров')
    if (ing.recipe.length) throw new BadRequestException(`«${ing.name}» сам состоит из сырья — его нельзя добавить в состав`)
  }
  await tx.recipeItem.createMany({
    data: recipe.map((r) => ({ productId, ingredientId: r.ingredientId, units: r.units, ord: r.ord })),
  })
}

// Состав нескольких товаров сразу: productId -> [{ ingredientId, units }]
export async function loadRecipes(tx: Tx, productIds: string[]): Promise<Map<string, { ingredientId: string; units: number }[]>> {
  const map = new Map<string, { ingredientId: string; units: number }[]>()
  const wanted = [...new Set(productIds)]
  if (!wanted.length) return map
  const rows = await tx.recipeItem.findMany({
    where: { productId: { in: wanted } },
    orderBy: { ord: 'asc' },
    select: { productId: true, ingredientId: true, units: true },
  })
  for (const r of rows) {
    if (!map.has(r.productId)) map.set(r.productId, [])
    map.get(r.productId)!.push({ ingredientId: r.ingredientId, units: r.units })
  }
  return map
}
