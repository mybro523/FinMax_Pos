import { useMemo } from 'react'
import { LuX } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { useT } from '../lib/i18n'
import { money } from '../db/store'
import { isVesovoy } from '../lib/units'
import { isComposite, compositeCost, recipeBaseUnits, recipeQtyText, recipeUnitLabel } from '../lib/recipe'

// ── Редактор состава (сырьё, 1.8.5) ──
// Один редактор для карточки товара и для прихода. value — строки состава
// { ingredientId, units, qty }: units — базовые единицы (штуки или тысячные у дробного),
// qty — число в поле (в единице ингредиента). onChange(next) отдаёт новый массив строк.
// products — все товары (ингредиенты и подсчёт себестоимости), selfId — id самого товара
// (себя в состав класть нельзя; у нового товара его ещё нет — null), unit — единица товара
// (для подписи «Количество — на 1 шт/кг»). Ингредиентом может быть любой обычный товар,
// кроме самого товара и другого составного (вложенные составы не поддерживаются).
export default function RecipeEditor({ value, onChange, products, selfId = null, unit = 'шт' }) {
  const t = useT()
  const recipe = Array.isArray(value) ? value : []
  const prodById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const recipeIds = new Set(recipe.map((r) => r.ingredientId))
  const ingredientOptions = products.filter((p) => p.id !== selfId && !recipeIds.has(p.id) && !isComposite(p))

  const addIngredient = (id) => {
    if (!id || recipeIds.has(id)) return
    onChange([...recipe, { ingredientId: id, units: 0, qty: '' }])
  }
  const setIngredientQty = (id, qty) => {
    const ing = prodById.get(id)
    onChange(recipe.map((r) => (r.ingredientId === id ? { ...r, qty, units: recipeBaseUnits(ing, qty) } : r)))
  }
  const removeIngredient = (id) => onChange(recipe.filter((r) => r.ingredientId !== id))

  const composite = recipe.some((r) => Number(r.units) > 0)
  // Себестоимость по составу — подсказкой (сумма стоимости ингредиентов)
  const recipeCost = composite ? compositeCost({ recipe: recipe.map((r) => ({ ingredientId: r.ingredientId, units: r.units })) }, prodById) : 0

  return (
    <div className="field" data-tour="pf.recipe">
      <label>{t('Состав (из какого сырья собирается)')}</label>
      <div className="tag-cat" style={{ marginTop: -2, marginBottom: 6 }}>
        {t('Добавьте ингредиенты — при продаже они спишутся со склада автоматически.')} {t('Количество — на 1')} {t(unit)}.
      </div>
      {recipe.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
          {recipe.map((r) => {
            const ing = prodById.get(r.ingredientId)
            return (
              <div key={r.ingredientId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{ing ? ing.name : t('удалённый товар')}</span>
                <div style={{ width: 104, flexShrink: 0 }}>
                  <NumberInput integer={!isVesovoy(ing)} value={r.qty ?? recipeQtyText(ing, r.units)} onChange={(e) => setIngredientQty(r.ingredientId, e.target.value)} placeholder="0" />
                </div>
                <span className="tag-cat" style={{ width: 30, flexShrink: 0 }}>{t(recipeUnitLabel(ing))}</span>
                <button
                  type="button"
                  onClick={() => removeIngredient(r.ingredientId)}
                  aria-label={`${t('Убрать')}: ${ing ? ing.name : ''}`}
                  style={{ background: 'none', border: 'none', color: 'var(--danger)', display: 'inline-flex', padding: 0, cursor: 'pointer', flexShrink: 0 }}
                >
                  <LuX size={15} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <select value="" onChange={(e) => { addIngredient(e.target.value); e.target.value = '' }}>
        <option value="">{t('— добавить ингредиент —')}</option>
        {ingredientOptions.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {composite && recipeCost > 0 && (
        <div className="tag-cat" style={{ marginTop: 6 }}>{t('Себестоимость по составу')}: {money(recipeCost)} · {t('остаток не ведётся — списывается сырьё')}</div>
      )}
    </div>
  )
}
