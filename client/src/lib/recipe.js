// ── Состав товара (сырьё), версия 1.8.5 ──
// Составной товар (торт, кирпич) собирается из других товаров-ингредиентов. При продаже
// списывается состав, а не остаток самого товара. В строке состава units — сколько ШТУК
// ингредиента (у дробного — тысячных: граммов, миллилитров) нужно на ОДНУ штуку товара.
//
// Касса сама считает «можно собрать N» по остаткам ингредиентов: у неё есть весь список
// товаров, поэтому доступность обновляется сразу, как только ингредиенты продаются.

import { sellableUnits, unitCost, isVesovoy, gramsOfKg, kgText, KG } from './units.js'

const num = (v) => Number(v) || 0

// Составной ли товар: есть непустой состав
export const isComposite = (p) => Array.isArray(p?.recipe) && p.recipe.length > 0

// Ингредиент по id — из списка товаров (Map или массив)
export function ingredientOf(byId, id) {
  if (!byId) return null
  if (byId instanceof Map) return byId.get(id) || null
  if (Array.isArray(byId)) return byId.find((p) => p.id === id) || null
  return byId[id] || null
}

// Количество ингредиента из поля формы — в базовые единицы (штуки или тысячные у дробного).
// Яйца «10» → 10; мука (кг) «0.2» → 200 граммов; молоко (л) «1» → 1000
export const recipeBaseUnits = (ingredient, qty) =>
  isVesovoy(ingredient) ? gramsOfKg(qty) : Math.max(0, Math.trunc(num(qty)))

// Базовые единицы обратно в число для поля формы: 200 (г) → «0,2»; 10 (шт) → «10»
export const recipeQtyText = (ingredient, units) => (isVesovoy(ingredient) ? kgText(units) : String(Math.max(0, Math.trunc(num(units)))))

// Подпись единицы, в которой задаётся количество ингредиента в составе
export const recipeUnitLabel = (ingredient) => (isVesovoy(ingredient) ? String(ingredient?.unit || 'кг') : 'шт')

// ── Сколько составного товара можно собрать ──
// По тому ингредиенту, которого хватает на наименьшее число штук. Нет ингредиента или
// количество в составе нулевое — собрать нельзя (0)
export function compositeBuildable(p, byId) {
  if (!isComposite(p)) return null
  let min = Infinity
  for (const line of p.recipe) {
    const need = Math.max(0, Math.trunc(num(line.units)))
    const ing = ingredientOf(byId, line.ingredientId)
    if (!ing || need <= 0) return 0
    const can = Math.floor(sellableUnits(ing) / need)
    if (can < min) min = can
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0
}

// Себестоимость одной штуки составного товара — сумма стоимости ингредиентов
export function compositeCost(p, byId) {
  if (!isComposite(p)) return num(p?.cost)
  let c = 0
  for (const line of p.recipe) {
    const ing = ingredientOf(byId, line.ingredientId)
    if (!ing) continue
    c += unitCost(ing) * num(line.units)
  }
  return c
}

// Доступно к продаже: у составного — сколько можно собрать, у обычного — годный остаток
export const availUnitsOf = (p, byId) => (isComposite(p) ? compositeBuildable(p, byId) : sellableUnits(p))

export { KG }
