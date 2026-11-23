import { useMemo, useRef, useState } from 'react'
import { LuX, LuSearch } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { useT } from '../lib/i18n'
import { money } from '../db/store'
import { isVesovoy } from '../lib/units'
import { poiskZapros, tovarPodhodit } from '../lib/poisk'
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

  // ── Поиск ингредиента (1.8.9) ──
  // Товаров бывают тысячи — вместо выпадающего списка поле поиска по названию и штрихкоду
  // (как в «Товарах»): печатаешь — видишь совпадения, клик или Enter добавляет в состав.
  // USB-сканер печатает штрихкод в это же поле. Камеры нет (ввод с клавиатуры)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const z = useMemo(() => poiskZapros(query), [query])
  const matches = useMemo(() => {
    if (!query.trim()) return []
    return ingredientOptions.filter((p) => tovarPodhodit(z, p.name, p.barcode)).slice(0, 8)
  }, [z, ingredientOptions, query])

  const pick = (p) => {
    if (!p) return
    addIngredient(p.id)
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(matches[active] || matches[0]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
  }

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
      {/* Поле поиска ингредиента с выпадающими совпадениями */}
      <div style={{ position: 'relative' }}>
        <LuSearch size={15} aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          placeholder={t('Поиск по названию или штрихкоду…')}
          aria-label={t('Поиск по названию или штрихкоду…')}
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%', paddingLeft: 32 }}
        />
        {open && query.trim() !== '' && (
          <ul
            role="listbox"
            style={{
              position: 'absolute', zIndex: 50, left: 0, right: 0, top: '100%', marginTop: 3,
              maxHeight: 260, overflowY: 'auto', listStyle: 'none', margin: 0, padding: 4,
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.22)',
            }}
          >
            {matches.length === 0 && (
              <li style={{ padding: '8px 10px', color: 'var(--muted)' }}>{t('Ничего не найдено')}</li>
            )}
            {matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(p) }}
                onMouseEnter={() => setActive(i)}
                style={{
                  padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center',
                  background: i === active ? 'var(--hover)' : 'transparent',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span className="tag-cat" style={{ flexShrink: 0 }}>{p.barcode || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {composite && recipeCost > 0 && (
        <div className="tag-cat" style={{ marginTop: 6 }}>{t('Себестоимость по составу')}: {money(recipeCost)} · {t('остаток не ведётся — списывается сырьё')}</div>
      )}
    </div>
  )
}
