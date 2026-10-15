import { useEffect, useRef, useState } from 'react'
import { LuCamera, LuWandSparkles, LuX } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { AddCategoryBtn } from './CategorySelect'
import { AddTypeBtn } from './TypeSelect'
import { szhatFoto } from '../lib/foto'
import { useDialog, useToast } from './ui'
import { useCollection } from '../db/store'
import { useT } from '../lib/i18n'
import { useCategories, categoryNames, categoryOptions } from '../lib/categories'
import { useProductTypes, typeNames, typeOptions, typeHasAnalogs } from '../lib/productTypes'
import { generateEan13, isInternalBarcode } from '../lib/barcode'
import { KG, gramsOfKg, isVesovoy, edinica, EDINICY } from '../lib/units'
import { priceFromMarkup, markupOf } from '../lib/pricing'

// ── Карточка товара: одна форма на всю программу ──
//
// Заводить товар можно двумя путями: из раздела «Товары» и прямо на кассе, когда
// сканер поймал незнакомый штрихкод (и ещё из прихода — кнопкой «Новый товар»).
// Раньше это были отдельные куски кода, и они предсказуемо разъехались: в «Товары»
// добавили дозировку, срок годности, минимальный остаток, вскрытые штуки и аналоги,
// а кассовую форму не тронули. Владелец заводил товар с кассы — и половина
// карточки оставалась пустой, причём молча: он даже не знал, что эти поля есть.
//
// Поэтому форма здесь одна. Страницы решают, что делать с заполненным (сохранить,
// сохранить и положить в корзину), но ПОЛЯ у всех одни и те же — по построению,
// а не по договорённости, которую в следующий раз забудут.
//
// ── Единица измерения ──
// Система универсальная: штуки, упаковки, килограммы, литры, метры, рулоны, пачки.
// Кг, л, м и м² продаются дробно (1,5 л, 2,3 м) — той же механикой, что весовой
// товар. Остальные — целыми, и у них может быть «штук внутри» для продажи поштучно.
//
// ── Тип товара и аналоги ──
// Тип (медицинский, продукты, бытовая химия…) ведётся в Настройках, как категории.
// Поле «Аналоги» видно, только если у выбранного типа стоит отметка «с аналогами»:
// у лекарства замены ищут, у шампуня — нет. Если аналоги у товара уже заданы,
// поле не прячется, что бы ни было выбрано, — иначе их было бы не убрать.
//
// ── Наценка ──
// Цену продажи можно задать процентом к закупочной: вписали 25% — цена посчиталась.
// Вписали цену — процент пересчитался. Хранится только цена: процент — лишь способ
// её назначить.

export const emptyProduct = {
  name: '', barcode: '', category: '', type: '', image: '', cost: '', price: '', stock: '', minStock: '',
  unitsPerPack: '1', looseUnits: '0', dosage: '', expiryDate: '', analogIds: [], unit: '',
}

// Из формы — в то, что уходит на сервер. Одна воронка на все страницы: раньше
// каждая приводила числа по-своему, и «пусто» превращалось то в 0, то в NaN.
export function productPayload(f, { normalizeBarcode = (v) => v } = {}) {
  const common = {
    name: (f.name || '').trim(),
    barcode: normalizeBarcode(f.barcode || ''),
    category: (f.category || '').trim(),
    type: (f.type || '').trim(),
    image: f.image || '',
    cost: Number(f.cost) || 0,
    price: Number(f.price) || 0,
    minStock: Number(f.minStock) || 0,
    dosage: (f.dosage || '').trim(),
    expiryDate: f.expiryDate || '', // пусто — сервер сохранит «без срока»
    analogIds: Array.isArray(f.analogIds) ? f.analogIds : [],
  }
  // Дробный товар (кг, л, м, м²): в форме остаток набран дробным числом, а хранится
  // он как «целые единицы + тысячные» — та же пара, что упаковки и вскрытые штуки
  if (isVesovoy(f)) {
    const parts = gramsOfKg(f.stock)
    return {
      ...common,
      stock: Math.floor(parts / KG),
      looseUnits: parts % KG,
      unit: String(f.unit).trim().toLowerCase(),
      unitsPerPack: KG,
    }
  }
  const unit = (f.unit || '').trim() || 'уп'
  // У штуки нет «штук внутри»: иначе одна штука продавалась бы частями
  const upp = unit === 'шт' && !(Number(f.unitsPerPack) > 1) ? 1 : Math.max(1, Number(f.unitsPerPack) || 1)
  return {
    ...common,
    stock: Number(f.stock) || 0,
    unit,
    unitsPerPack: upp,
    looseUnits: upp > 1 ? Math.max(0, Number(f.looseUnits) || 0) : 0,
  }
}

export default function ProductForm({ value, onChange, autoFocus = 'barcode', hideStock = false }) {
  const dialog = useDialog()
  const fotoRef = useRef(null)
  const t = useT()
  const toast = useToast()

  // Фото выбрано — сжимаем на месте и кладём строкой в карточку
  async function pickFoto(file) {
    if (!file) return
    try {
      onChange({ ...value, image: await szhatFoto(file) })
    } catch (e) {
      toast(t(e.message), 'err')
    }
  }
  const products = useCollection('products')
  const catList = useCategories()
  const types = useProductTypes()

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
  const drob = isVesovoy(value)
  const u = edinica(value)
  const analogIds = Array.isArray(value.analogIds) ? value.analogIds : []

  // Смена единицы. Переход между дробной и целой обнуляет остаток: прежнее число
  // значило упаковки, а не килограммы (и наоборот). Между двумя дробными или двумя
  // целыми остаток остаётся — меняется только подпись
  function pickUnit(next) {
    const nextDrob = isVesovoy({ unit: next })
    if (nextDrob !== drob) {
      return onChange({ ...value, unit: next, unitsPerPack: nextDrob ? String(KG) : '1', looseUnits: '0', stock: '' })
    }
    if (next === 'шт' && !(Number(value.unitsPerPack) > 1)) return onChange({ ...value, unit: next, unitsPerPack: '1', looseUnits: '0' })
    onChange({ ...value, unit: next })
  }

  // ── Наценка ──
  // Пока человек печатает процент, показываем то, что он набирает (иначе «12.»
  // превращалось бы в «12» под пальцами). Ушёл из поля — процент снова считается от цены
  const [mkDraft, setMkDraft] = useState(null)
  const markup = mkDraft ?? markupOf(value.cost, value.price)
  function setMarkup(v) {
    setMkDraft(v)
    const p = priceFromMarkup(value.cost, v)
    if (p !== null) onChange({ ...value, price: String(p) })
  }

  // Свой штрихкод для товара без заводского кода — уникальный в пределах базы
  function genBarcode() {
    const code = generateEan13(products.map((p) => p.barcode))
    if (!code) return toast(t('Не удалось сгенерировать код'), 'err')
    set('barcode', code)
    toast(t('Штрихкод сгенерирован — распечатайте и наклейте на упаковку'))
  }

  const nameById = (id) => products.find((p) => p.id === id)?.name || t('удалённый товар')
  const showAnalogs = typeHasAnalogs(value.type, types) || analogIds.length > 0
  // У «штуки» нет штук внутри; у заведённого раньше товара с такими штуками поле остаётся
  const showUpp = !drob && (u !== 'шт' || Number(value.unitsPerPack) > 1)
  const unitKnown = EDINICY.some((x) => x.v === u)

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
            <div className="tag-cat">{t('Внутренний код магазина — распечатайте этикетку')}</div>
          )}
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.category">
          <label>{t('Категория (необязательно)')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={{ flex: 1, minWidth: 0 }} value={value.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">{t('— без категории —')}</option>
              {categoryOptions(value.category, catList).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.legacy ? `${o.value} — ${t('старая категория')}` : t(o.value)}
                </option>
              ))}
            </select>
            <AddCategoryBtn dialog={dialog} toast={toast} options={categoryNames(catList)} onPicked={(name) => set('category', name)} />
          </div>
        </div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.type">
          <label htmlFor="pf-type">{t('Тип товара (необязательно)')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select id="pf-type" style={{ flex: 1, minWidth: 0 }} value={value.type || ''} onChange={(e) => set('type', e.target.value)}>
              <option value="">{t('— без типа —')}</option>
              {typeOptions(value.type, types).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.legacy ? `${o.value} — ${t('старый тип')}` : t(o.value)}
                </option>
              ))}
            </select>
            <AddTypeBtn toast={toast} options={typeNames(types)} onPicked={(name) => set('type', name)} />
          </div>
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.unit">
          <label htmlFor="pf-unit">{t('Единица измерения')}</label>
          <select id="pf-unit" value={u} onChange={(e) => pickUnit(e.target.value)}>
            {!unitKnown && <option value={u}>{u}</option>}
            {EDINICY.map((x) => (
              <option key={x.v} value={x.v}>
                {t(x.v) === t(x.name) ? t(x.v) : `${t(x.v)} — ${t(x.name)}`}{x.drob ? ` (${t('дробно')})` : ''}
              </option>
            ))}
          </select>
          {drob && (
            <div className="tag-cat">
              {u === 'кг'
                ? t('Цена за 1 кг, вес с точностью до грамма. Код на весах впишите в поле штрихкода.')
                : t('Цена за 1 единицу, продаётся дробно — например 1,5 или 2,25.')}
            </div>
          )}
        </div>
      </div>

      {/* ── Фото товара ── */}
      <div className="field" data-tour="pf.foto">
        <label>{t('Фото товара (необязательно)')}</label>
        <div className="pf-foto">
          {value.image ? <img className="foto-mini lg" src={value.image} alt="" /> : <span className="pf-foto-none">{t('нет фото')}</span>}
          <input ref={fotoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { pickFoto(e.target.files?.[0]); e.target.value = '' }} />
          <button type="button" className="btn ghost" onClick={() => fotoRef.current?.click()}>
            <span className="ic"><LuCamera size={15} /></span> {value.image ? t('Заменить') : t('Загрузить фото')}
          </button>
          {value.image && <button type="button" className="btn ghost" onClick={() => set('image', '')}>{t('Убрать')}</button>}
        </div>
        <div className="tag-cat" style={{ marginTop: 6 }}>{t('Кружок с фото появится в кассе и в списке товаров; нажатие открывает снимок во весь экран.')}</div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }} data-tour="pf.dosage">
          <label>{t('Фасовка / объём')}</label>
          <input value={value.dosage} onChange={(e) => set('dosage', e.target.value)} placeholder={t('напр. 500 мг, 1 л')} />
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.expiry">
          <label>{t('Срок годности')}</label>
          <input type="date" value={value.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} />
        </div>
      </div>

      <div className="row pf-prices">
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label htmlFor="pf-cost">{t('Закупочная цена')} <span className="tag-cat">· {t('за 1')} {t(u)}</span></label>
          <NumberInput id="pf-cost" value={value.cost} onChange={(e) => set('cost', e.target.value)} />
        </div>
        <div className="field pf-markup" data-tour="pf.markup">
          <label htmlFor="pf-markup">{t('Наценка, %')}</label>
          <NumberInput
            id="pf-markup"
            value={markup}
            onChange={(e) => setMarkup(e.target.value)}
            onBlur={() => setMkDraft(null)}
            placeholder={Number(value.cost) > 0 ? '25' : '—'}
            disabled={!(Number(value.cost) > 0)}
            title={Number(value.cost) > 0 ? t('Процент к закупочной цене — цена продажи посчитается сама') : t('Сначала впишите закупочную цену')}
          />
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label htmlFor="pf-price">{t('Цена продажи')} <span className="tag-cat">· {t('за 1')} {t(u)}</span></label>
          <NumberInput id="pf-price" value={value.price} onChange={(e) => { setMkDraft(null); set('price', e.target.value) }} />
        </div>
      </div>

      <div className="row">
        {/* В приходе остаток не спрашиваем: сколько пришло — в строке прихода,
            иначе товар посчитался бы дважды */}
        {!hideStock && (
          <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
            <label>{t('Остаток')} ({t(u)})</label>
            <NumberInput integer={!drob} value={value.stock} onChange={(e) => set('stock', e.target.value)} placeholder={drob ? '12.5' : ''} />
          </div>
        )}
        <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
          <label>{t('Мин. остаток')} ({t(u)})</label>
          <NumberInput integer value={value.minStock} onChange={(e) => set('minStock', e.target.value)} />
        </div>
      </div>

      {showUpp && (
        <div className="row">
          <div className="field" style={{ flex: 1 }} data-tour="pf.upp">
            <label>{u === 'уп' ? t('Штук в упаковке') : t('Штук внутри')} <span className="tag-cat">· {t('для продажи поштучно')}</span></label>
            <NumberInput
              integer
              value={value.unitsPerPack}
              onChange={(e) => set('unitsPerPack', e.target.value)}
              placeholder="1"
              title={t('Для продажи поштучно. 1 = продаётся только целиком')}
            />
          </div>
          {!hideStock && <div className="field" style={{ flex: 1 }} data-tour="pf.loose">
            <label>{t('Вскрыто (штук)')}</label>
            <NumberInput
              integer
              value={value.looseUnits}
              onChange={(e) => set('looseUnits', e.target.value)}
              placeholder="0"
              title={t('Остаток штук во вскрытой упаковке')}
            />
          </div>}
        </div>
      )}

      {/* Аналоги: чем заменить, если этого не осталось. Только у типов «с аналогами» */}
      {showAnalogs && (
        <div className="field" data-tour="pf.analogs">
          <label>{t('Аналоги (взаимозаменяемые товары)')}</label>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value
              if (id && !analogIds.includes(id)) set('analogIds', [...analogIds, id])
            }}
          >
            <option value="">{t('— добавить аналог —')}</option>
            {products
              .filter((p) => p.id !== value.id && !analogIds.includes(p.id))
              .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {analogIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {analogIds.map((id) => (
                <span key={id} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {nameById(id)}
                  <button
                    type="button"
                    onClick={() => set('analogIds', analogIds.filter((x) => x !== id))}
                    aria-label={`${t('Убрать')}: ${nameById(id)}`}
                    style={{ background: 'none', border: 'none', color: 'var(--danger)', display: 'inline-flex', padding: 0 }}
                  >
                    <LuX size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
