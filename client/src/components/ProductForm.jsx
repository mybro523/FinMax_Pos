import { useEffect, useRef, useState } from 'react'
import { LuCamera, LuWandSparkles, LuX } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { AddCategoryBtn } from './CategorySelect'
import { AddTypeBtn } from './TypeSelect'
import { szhatFoto } from '../lib/foto'
import { useDialog, useToast } from './ui'
import { useCollection, money } from '../db/store'
import { useT } from '../lib/i18n'
import { useCategories, categoryNames, categoryOptions } from '../lib/categories'
import { useProductTypes, typeNames, typeOptions, typeHasAnalogs } from '../lib/productTypes'
import { generateEan13, isInternalBarcode } from '../lib/barcode'
import { KG, gramsOfKg, isVesovoy, edinica, EDINICY, kgText } from '../lib/units'
import { repackAsk, repackNeeded, r2, vesUpp } from '../lib/vesUpak'
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
// Система универсальная: штуки, упаковки, килограммы, литры, метры, рулоны.
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
  name: '', barcode: '', category: '', type: '', image: '', cost: '', price: '', piecePrice: '', stock: '', minStock: '',
  unitsPerPack: '1', looseUnits: '0', dosage: '', expiryDate: '', analogIds: [], unit: '',
  // Сколько кг (л, м) в упаковке у дробного товара: мешок муки — 50 (1.5.12). Пусто — на вес
  vesUp: '',
}

// Помощники мешка — в lib/vesUpak.js (проверяются без окна); карточка отдаёт их дальше
export { MAX_UPP, repackAsk, repackNeeded, vesUpp, vesUpText } from '../lib/vesUpak'

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
    // Окно знает упаковку дробного товара (1.5.12): правку мешка сервер примет. Прежние окна
    // этого не знали — их правка мешок у товара не снимает (server/products, oldWindowPack)
    drobPack: true,
  }
  // Дробный товар (кг, л, м, м²): в форме остаток набран дробным числом, а хранится
  // он как «целые упаковки + тысячные» — та же пара, что упаковки и вскрытые штуки. Упаковка —
  // мешок (50 кг — 50 000 граммов) или, без мешка, одна единица (1000 граммов)
  if (isVesovoy(f)) {
    const parts = gramsOfKg(f.stock)
    const upp = vesUpp(f.vesUp)
    // Своя цена за 1 кг — только у товара в мешке: без мешка цена продажи и так за 1 кг
    const piece = Number(String(f.piecePrice ?? '').replace(',', '.'))
    return {
      ...common,
      stock: Math.floor(parts / upp),
      looseUnits: parts % upp,
      unit: String(f.unit).trim().toLowerCase(),
      unitsPerPack: upp,
      piecePrice: upp > KG && Number.isFinite(piece) && piece > 0 ? Math.round(piece * 100) / 100 : null,
      // Мешок сменили: прежние цены переведены на новую упаковку (scale) или оставлены (keep) —
      // сервер так же поступит с ценами партий
      ...(repackAsk(f) && (f.repack === 'scale' || f.repack === 'keep') ? { repack: f.repack } : {}),
    }
  }
  const unit = (f.unit || '').trim() || 'уп'
  // У штуки нет «штук внутри»: иначе одна штука продавалась бы частями
  const upp = unit === 'шт' && !(Number(f.unitsPerPack) > 1) ? 1 : Math.max(1, Number(f.unitsPerPack) || 1)
  // Своя цена за 1 шт (1.5.11): только у делимой упаковки; пусто или ноль — своей нет,
  // штука стоит цена упаковки / штук в упаковке
  const piece = Number(String(f.piecePrice ?? '').replace(',', '.'))
  return {
    ...common,
    stock: Number(f.stock) || 0,
    unit,
    unitsPerPack: upp,
    looseUnits: upp > 1 ? Math.max(0, Number(f.looseUnits) || 0) : 0,
    piecePrice: upp > 1 && Number.isFinite(piece) && piece > 0 ? Math.round(piece * 100) / 100 : null,
  }
}

// arrival — форма открыта из прихода: «Остаток» здесь становится количеством в строке
// прихода (товар считается один раз), а «Вскрыто (штук)» не спрашивается
export default function ProductForm({ value, onChange, autoFocus = 'barcode', arrival = false }) {
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
  // Мешок поменяли ещё раз — прежний ответ «за что были цены» уже не про него: цены — как были
  const setVesUp = (v) =>
    onChange({ ...value, vesUp: v, repack: undefined, ...(value.repack === 'scale' ? { cost: value.cost0 ?? value.cost, price: value.price0 ?? value.price } : {}) })
  // Ответ: прежние цены были за прежнюю упаковку — перевести; уже за новую — оставить как были
  function chooseRepack(kind) {
    const ask = repackAsk(value)
    if (!ask) return
    if (kind === 'scale') onChange({ ...value, repack: 'scale', cost: String(r2(Number(value.cost0) * ask.ratio)), price: String(r2(Number(value.price0) * ask.ratio)) })
    else onChange({ ...value, repack: 'keep', cost: String(value.cost0 ?? value.cost), price: String(value.price0 ?? value.price) })
  }
  const drob = isVesovoy(value)
  const u = edinica(value)
  const analogIds = Array.isArray(value.analogIds) ? value.analogIds : []

  // Смена единицы. Переход между дробной и целой обнуляет остаток: прежнее число
  // значило упаковки, а не килограммы (и наоборот). Между двумя дробными или двумя
  // целыми остаток остаётся — меняется только подпись
  function pickUnit(next) {
    const nextDrob = isVesovoy({ unit: next })
    if (nextDrob !== drob) {
      return onChange({ ...value, unit: next, unitsPerPack: nextDrob ? String(KG) : '1', looseUnits: '0', stock: '', vesUp: '', piecePrice: '' })
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
  // Весовой в мешке (1.5.12): сколько кг в мешке и цены — за мешок
  const vesKg = drob && vesUpp(value.vesUp) > KG ? vesUpp(value.vesUp) / KG : 0
  // Цена штуки (у мешка — килограмма) по расчёту — подсказкой в поле своей цены: «1,67»
  const perPiece = drob ? vesKg : Number(value.unitsPerPack)
  const autoPiece = perPiece > 1 && Number(value.price) > 0
    ? String(Math.round((Number(value.price) / perPiece) * 100) / 100).replace('.', ',')
    : ''
  // За что цены в карточке: «за 1 уп», «за 1 кг», у мешка — «за 1 уп (50 кг)»
  const zaChto = vesKg ? `${t('за 1')} ${t('уп')} (${String(vesKg).replace('.', ',')} ${t(u)})` : `${t('за 1')} ${t(u)}`
  // Остаток весового в мешках — подсказкой под полем: «= 2 уп + 10 кг»
  const ostatokGr = drob ? gramsOfKg(value.stock) : 0
  const ostatokUp = vesKg && ostatokGr > 0
    ? `= ${Math.floor(ostatokGr / vesUpp(value.vesUp))} ${t('уп')}${ostatokGr % vesUpp(value.vesUp) ? ` + ${kgText(ostatokGr % vesUpp(value.vesUp))} ${t(u)}` : ''}`
    : ''
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
            {/* Единица, которой больше нет в выборе (у товара, заведённого раньше), —
                остаётся у этого товара, пока её не сменят */}
            {!unitKnown && <option value={u}>{t(u)}</option>}
            {EDINICY.map((x) => (
              <option key={x.v} value={x.v}>
                {t(x.v) === t(x.name) ? t(x.v) : `${t(x.v)} — ${t(x.name)}`}{x.drob ? ` (${t('дробно')})` : ''}
              </option>
            ))}
          </select>
          {drob && (
            <div className="tag-cat">
              {u === 'кг'
                ? t('Вес с точностью до грамма. Код на весах впишите в поле штрихкода.')
                : t('Продаётся дробно — например 1,5 или 2,25.')}
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

      {/* Подписи в одну строку, «за 1 уп» — мелко под полем: три поля стоят на одной
          линии при любой ширине окна */}
      <div className="row pf-prices">
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label htmlFor="pf-cost">{t('Закупочная цена')}</label>
          <NumberInput id="pf-cost" value={value.cost} onChange={(e) => set('cost', e.target.value)} />
          <span className="pf-hint">{zaChto}</span>
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
          <span className="pf-hint">{t('от закупочной')}</span>
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.prices">
          <label htmlFor="pf-price">{t('Цена продажи')}</label>
          <NumberInput id="pf-price" value={value.price} onChange={(e) => { setMkDraft(null); set('price', e.target.value) }} />
          <span className="pf-hint">{zaChto}</span>
        </div>
      </div>

      <div className="row">
        {/* В приходе «Остаток» — это сколько пришло: число уходит в строку прихода, а
            товар заводится с нулём, иначе он посчитался бы дважды */}
        <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
          <label>{t('Остаток')} ({t(u)})</label>
          <NumberInput integer={!drob} value={value.stock} onChange={(e) => set('stock', e.target.value)} placeholder={drob ? '12.5' : ''} />
          {/* Подсказка под полем, а не в подписи: поля «Остаток» и «Мин. остаток» на одной линии */}
          {arrival ? <span className="pf-hint">{t('встанет в строку прихода')}</span> : ostatokUp && <span className="pf-hint">{ostatokUp}</span>}
        </div>
        <div className="field" style={{ flex: 1 }} data-tour="pf.stock">
          {/* У мешков минимум считается мешками, как упаковки штучного */}
          <label>{t('Мин. остаток')} ({vesKg ? t('уп') : t(u)})</label>
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
          {!arrival && <div className="field" style={{ flex: 1 }} data-tour="pf.loose">
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

      {/* Своя цена за 1 шт (1.5.11) — своей строкой: касса продаёт отдельные штуки по ней,
          целые упаковки — по цене продажи. Пусто — цена упаковки / штук в упаковке */}
      {showUpp && Number(value.unitsPerPack) > 1 && (
        <div className="row">
          <div className="field" style={{ flex: 1 }} data-tour="pf.piece">
            <label htmlFor="pf-piece">{t('Своя цена за 1 шт')}</label>
            <NumberInput id="pf-piece" value={value.piecePrice ?? ''} onChange={(e) => set('piecePrice', e.target.value)} placeholder={autoPiece || '—'} />
            <span className="pf-hint">{t('пусто — по расчёту')}{autoPiece ? `: ${autoPiece}` : ''}</span>
          </div>
          <div className="field pf-spacer" style={{ flex: 1 }} aria-hidden="true" />
        </div>
      )}

      {/* Весовой в упаковке (1.5.12): мешок муки 50 кг, канистра 20 л. Пусто — продаётся
          только на вес, цена — за 1 кг. Задали — цены за мешок, а отдельные килограммы касса
          продаёт по своей цене за 1 кг или по цене мешка / кг в мешке */}
      {drob && (
        <div className="row">
          <div className="field" style={{ flex: 1 }} data-tour="pf.vesup">
            <label htmlFor="pf-vesup">{t('В упаковке')}, {t(u)} <span className="tag-cat">· {t('мешок, канистра')}</span></label>
            <NumberInput id="pf-vesup" value={value.vesUp ?? ''} onChange={(e) => setVesUp(e.target.value)} placeholder="—" />
            <span className="pf-hint">{vesKg ? t('цены — за упаковку') : t('пусто — продаётся только на вес')}</span>
          </div>
          {vesKg ? (
            <div className="field" style={{ flex: 1 }} data-tour="pf.piece">
              <label htmlFor="pf-piece">{t('Своя цена за 1')} {t(u)}</label>
              <NumberInput id="pf-piece" value={value.piecePrice ?? ''} onChange={(e) => set('piecePrice', e.target.value)} placeholder={autoPiece || '—'} />
              <span className="pf-hint">{t('пусто — по расчёту')}{autoPiece ? `: ${autoPiece}` : ''}</span>
            </div>
          ) : (
            <div className="field pf-spacer" style={{ flex: 1 }} aria-hidden="true" />
          )}
        </div>
      )}

      {/* Мешок сменили у товара с ценами или остатком: за что были прежние цены (1.5.12) */}
      {repackAsk(value) && (() => {
        const ask = repackAsk(value)
        const pack = (g) => (g > KG ? `${t('уп')} ${kgText(g)} ${t(u)}` : `1 ${t(u)}`)
        return (
          <div className={'note pf-repack' + (repackNeeded(value) ? ' warn' : ' info')} data-tour="pf.repack" role="radiogroup" aria-label={t('Прежние цены')}>
            <div>
              {t('Упаковка меняется')}: {pack(ask.was)} → {pack(ask.now)}. {t('Прежние цены товара')} ({t('закупочная')} {money(value.cost0)}, {t('продажи')} {money(value.price0)}) {t('были')}:
            </div>
            <label className="pf-repack-ch">
              <input type="radio" name="pf-repack" checked={value.repack === 'scale'} onChange={() => chooseRepack('scale')} />
              <span>{t('за прежнюю упаковку')} ({pack(ask.was)}) — {t('пересчитать')}: {t('закупочная')} {money(r2(Number(value.cost0) * ask.ratio))}, {t('продажи')} {money(r2(Number(value.price0) * ask.ratio))}</span>
            </label>
            <label className="pf-repack-ch">
              <input type="radio" name="pf-repack" checked={value.repack === 'keep'} onChange={() => chooseRepack('keep')} />
              <span>{t('уже за новую упаковку')} ({pack(ask.now)}) — {t('оставить')}: {t('закупочная')} {money(value.cost0)}, {t('продажи')} {money(value.price0)}</span>
            </label>
          </div>
        )
      })()}

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
