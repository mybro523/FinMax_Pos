import { useEffect, useRef } from 'react'
import { LuWandSparkles, LuX } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { useToast } from './ui'
import { useCollection } from '../db/store'
import { useT } from '../lib/i18n'
import { useCategories, categoryNames, categoryOptions } from '../lib/categories'
import { generateEan13, isInternalBarcode } from '../lib/barcode'
import { KG, gramsOfKg, isVesovoy } from '../lib/units'

// ── Карточка товара: одна форма на всю программу ──
//
// Заводить товар можно двумя путями: из раздела «Товары» и прямо на кассе, когда
// сканер поймал незнакомый штрихкод. Раньше это были два отдельных куска кода,
// и они предсказуемо разъехались: в «Товары» добавили дозировку, срок годности,
// минимальный остаток, вскрытые штуки и аналоги, а кассовую форму не тронули.
// Владелец заводил товар с кассы — и половина карточки оставалась пустой, причём
// молча: он даже не знал, что эти поля есть.
//
// Поэтому форма здесь одна. Страницы решают, что делать с заполненным (сохранить,
// сохранить и положить в корзину), но ПОЛЯ у обеих одни и те же — по построению,
// а не по договорённости, которую в следующий раз забудут.
//
// Единицы измерения («уп», «шт») в форме нет намеренно: владелец сервиса убрал её,
// чтобы не заполнять поле, которое почти всегда одно и то же. Новый товар получает
// «уп», у заведённых раньше остаётся вписанное. На расчёты это не влияет — только
// на подпись рядом с числом.

export const emptyProduct = {
  name: '', barcode: '', category: '', cost: '', price: '', stock: '', minStock: '',
  unitsPerPack: '1', looseUnits: '0', dosage: '', expiryDate: '', analogIds: [], unit: '',
}

// Из формы — в то, что уходит на сервер. Одна воронка на обе страницы: раньше
// каждая приводила числа по-своему, и «пусто» превращалось то в 0, то в NaN.
export function productPayload(f, { normalizeBarcode = (v) => v } = {}) {
  // Весовой товар: в форме остаток набран в килограммах, а хранится он как
  // «целые кг + граммы» — та же пара, что упаковки и вскрытые штуки
  if (isVesovoy(f)) {
    const grams = gramsOfKg(f.stock)
    return {
      name: (f.name || '').trim(),
      barcode: normalizeBarcode(f.barcode || ''),
      category: (f.category || '').trim(),
      cost: Number(f.cost) || 0,
      price: Number(f.price) || 0,
      stock: Math.floor(grams / KG),
      looseUnits: grams % KG,
      minStock: Number(f.minStock) || 0,
      unit: 'кг',
      unitsPerPack: KG,
      dosage: (f.dosage || '').trim(),
      expiryDate: f.expiryDate || '',
      analogIds: Array.isArray(f.analogIds) ? f.analogIds : [],
    }
  }
  return {
    name: (f.name || '').trim(),
    barcode: normalizeBarcode(f.barcode || ''),
    category: (f.category || '').trim(),
    cost: Number(f.cost) || 0,
    price: Number(f.price) || 0,
    stock: Number(f.stock) || 0,
    minStock: Number(f.minStock) || 0,
    unit: (f.unit || '').trim() || 'уп',
    unitsPerPack: Math.max(1, Number(f.unitsPerPack) || 1),
    looseUnits: Math.max(0, Number(f.looseUnits) || 0),
    dosage: (f.dosage || '').trim(),
    expiryDate: f.expiryDate || '', // пусто — сервер сохранит «без срока»
    analogIds: Array.isArray(f.analogIds) ? f.analogIds : [],
  }
}

export default function ProductForm({ value, onChange, autoFocus = 'barcode' }) {
  const t = useT()
  const toast = useToast()
  const products = useCollection('products')
  const catList = useCategories()

  const barcodeRef = useRef(null)
  const nameRef = useRef(null)

  // Форма открывается под сканер: курсор сразу в штрихкоде, а не в названии.
  // На кассе штрихкод уже считан — там курсор нужен в названии.
  useEffect(() => {
    const el = autoFocus === 'name' ? nameRef.current : barcodeRef.current
    if (!el) return
    el.focus()
    // При правке код уже заполнен — скан заменит его целиком, а не допишет в конец
    el.select?.()
  }, [autoFocus])

  const set = (k, v) => onChange({ ...value, [k]: v })
  const ves = isVesovoy(value)

  // Галочка «на вес»: единица меняется на килограммы, упаковки и штуки уходят.
  // Остаток при переключении очищается: прежнее число значило упаковки, а не кг
  const toggleVes = (on) =>
    onChange({
      ...value,
      unit: on ? 'кг' : '',
      unitsPerPack: on ? String(KG) : '1',
      looseUnits: '0',
      stock: '',
    })

  // Свой штрихкод для товара без заводского кода — уникальный в пределах базы
  function genBarcode() {
    const code = generateEan13(products.map((p) => p.barcode))
    if (!code) return toast(t('Не удалось сгенерировать код'), 'err')
    set('barcode', code)
    toast(t('Штрихкод сгенерирован — распечатайте и наклейте на упаковку'))
  }

  const nameById = (id) => products.find((p) => p.id === id)?.name || t('удалённый товар')

  return (
    <>
      <div className="field" data-tour="pf.name">
        <label>{t('Название')}</label>
        <input ref={nameRef} value={value.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.barcode">
          <label>{t('Штрихкод')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={barcodeRef}
              value={value.barcode}
              onChange={(e) => set('barcode', e.target.value)}
              onKeyDown={(e) => {
                // Сканер дописывает Enter — не сохраняем полупустой товар,
                // а переходим к названию
                if (e.key !== 'Enter') return
                e.preventDefault()
                nameRef.current?.focus()
              }}
              placeholder="487…"
            />
            <button
              type="button"
              className="btn ghost"
              style={{ flexShrink: 0 }}
              onClick={genBarcode}
              title={t('Сгенерировать штрихкод, если его нет на упаковке')}
            >
              <LuWandSparkles size={16} />
            </button>
          </div>
          {isInternalBarcode(value.barcode) && (
            <div className="tag-cat">{t('Внутренний код аптеки — распечатайте этикетку')}</div>
          )}
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.category">
          <label>{t('Категория')}</label>
          <select value={value.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">{t('— выберите категорию —')}</option>
            {categoryOptions(value.category, catList).map((o) => (
              <option key={o.value} value={o.value}>
                {o.legacy ? `${o.value} — ${t('старая категория')}` : t(o.value)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="pf-ves" data-tour="pf.ves">
        <input type="checkbox" checked={ves} onChange={(e) => toggleVes(e.target.checked)} />
        <span>
          {t('Продаётся на вес (килограммами)')}
          <span className="tag-cat">{t('Цена за 1 кг, вес с точностью до грамма. Код на весах впишите в поле штрихкода.')}</span>
        </span>
      </label>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.dosage">
          <label>{t('Дозировка')}</label>
          <input value={value.dosage} onChange={(e) => set('dosage', e.target.value)} placeholder="напр. 500 мг" />
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.expiry">
          <label>{t('Срок годности')}</label>
          <input type="date" value={value.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label>{ves ? t('Закупочная цена за 1 кг') : t('Закупочная цена')}</label>
          <NumberInput value={value.cost} onChange={(e) => set('cost', e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label>{ves ? t('Цена продажи за 1 кг') : t('Цена продажи')}</label>
          <NumberInput value={value.price} onChange={(e) => set('price', e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
          <label>{ves ? t('Остаток (кг)') : t('Остаток (упаковок)')}</label>
          <NumberInput integer={!ves} value={value.stock} onChange={(e) => set('stock', e.target.value)} placeholder={ves ? '12.5' : ''} />
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
          <label>{ves ? t('Мин. остаток (кг)') : t('Мин. остаток')}</label>
          <NumberInput integer value={value.minStock} onChange={(e) => set('minStock', e.target.value)} />
        </div>
      </div>

      {!ves && (
        <div className="row">
          <div className="field" style={{ flex: 1 }} data-tour="pf.upp">
            <label>{t('Штук в упаковке')}</label>
            <NumberInput
              integer
              value={value.unitsPerPack}
              onChange={(e) => set('unitsPerPack', e.target.value)}
              placeholder="1"
              title="Для деления на таблетки. 1 = продаётся только целиком"
            />
          </div>
          <div className="field" style={{ flex: 1 }} data-tour="pf.loose">
            <label>{t('Вскрыто (штук)')}</label>
            <NumberInput
              integer
              value={value.looseUnits}
              onChange={(e) => set('looseUnits', e.target.value)}
              placeholder="0"
              title="Остаток штук во вскрытой упаковке"
            />
          </div>
        </div>
      )}

      {/* Аналоги: чем заменить, если этого не осталось */}
      <div className="field" data-tour="pf.analogs">
        <label>{t('Аналоги (взаимозаменяемые товары)')}</label>
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value
            if (id && !value.analogIds.includes(id)) set('analogIds', [...value.analogIds, id])
          }}
        >
          <option value="">{t('— добавить аналог —')}</option>
          {products
            .filter((p) => p.id !== value.id && !value.analogIds.includes(p.id))
            .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {value.analogIds.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {value.analogIds.map((id) => (
              <span key={id} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {nameById(id)}
                <button
                  type="button"
                  onClick={() => set('analogIds', value.analogIds.filter((x) => x !== id))}
                  style={{ background: 'none', border: 'none', color: 'var(--danger)', display: 'inline-flex', padding: 0 }}
                >
                  <LuX size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
