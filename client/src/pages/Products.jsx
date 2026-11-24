import { useState, useMemo, useEffect, useSyncExternalStore, lazy, Suspense } from 'react'
import { LuPlus, LuPencil, LuTrash2, LuTag, LuHistory, LuReceiptText, LuX } from 'react-icons/lu'
import ProductHistory from '../components/ProductHistory'
import Layout from '../components/Layout'
import StickyBar from '../components/StickyBar'
import ChipsMore from '../components/ChipsMore'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money, db, stockText } from '../db/store'
import { normalizeScan, canonBarcode } from '../lib/scan'
import { expiryStatus, expiryLabel } from '../lib/expiry'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import KameraKnopka from '../components/KameraKnopka'
import { poiskZapros, tovarPodhodit } from '../lib/poisk'
import { getUser, useCan } from '../db/auth'
import { useModul } from '../lib/useModul'
import { useCategories, categoryNames } from '../lib/categories'
import { sellsBelowCost } from '../lib/pricing'
import ProductForm, { emptyProduct, productPayload, vesUpText, repackNeeded } from '../components/ProductForm'
import Lightbox from '../components/Lightbox'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { editPatch, stockAtOpen } from '../lib/productEdit'
import { edinica, isVesovoy, stockUnits, stockValue } from '../lib/units'
import { isComposite, compositeBuildable, recipeQtyText } from '../lib/recipe'

// Печать этикеток нужна редко — грузим по требованию, чтобы не утяжелять страницу
const LabelPrint = lazy(() => import('../components/LabelPrint'))
const CennikiModal = lazy(() => import('../components/Cenniki'))

// Поля карточки живут в общем компоненте: ту же форму показывает касса, когда
// сканер поймал незнакомый штрихкод. Раньше это были два разных куска кода, и они
// разъехались — в «Товары» поля добавляли, в кассу забывали.
const empty = emptyProduct

const EXP_COLOR = { expired: 'var(--danger)', soon: 'var(--warn)', ok: 'var(--muted)' }

// Телефон — окно уже 601 px (как в стилях): там у отмеченных товаров своя полоса внизу экрана
const UZKO = '(max-width: 600px)'
const mqUzko = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(UZKO) : null)
const sledUzko = (cb) => {
  const mq = mqUzko()
  mq?.addEventListener?.('change', cb)
  return () => mq?.removeEventListener?.('change', cb)
}
const uzko = () => !!mqUzko()?.matches
const useTelefon = () => useSyncExternalStore(sledUzko, uzko, () => false)

export default function Products() {
  const products = useCollection('products')
  // Для составных товаров «остаток» = сколько можно собрать из ингредиентов (1.8.5)
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  // Кассир видит список и остатки, но не правит карточки: цену можно тихо снизить,
  // продать и вернуть обратно, а удаление стирает товар вместе со следами недостачи.
  // Сервер такие запросы всё равно отклонит — кнопки убраны, чтобы кассир не упирался
  // в отказ там, где кнопка выглядит рабочей.
  const can = useCan()
  // Модуль «Срок годности» выключен у магазина — столбца «Годен до» нет ни в таблице, ни в выгрузке
  const srokOn = useModul('expiry')
  // Модуль «Сырьё и состав» (1.8.11): выключен — вкладок «Сырьё»/«Все» нет, показываем
  // только товары для продажи (как было до появления сырья)
  const rawOn = useModul('raw')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('Все')
  // Сырьё отдельно от обычных товаров (1.8.7): 'sale' — для продажи (по умолчанию, сырьё
  // скрыто), 'raw' — только сырьё («не для продажи»), 'all' — всё вместе
  const [scope, setScope] = useState('sale')
  const [edit, setEdit] = useState(null) // объект формы или null
  const [labelFor, setLabelFor] = useState(null) // товар, для которого печатаем этикетки
  // Отмеченные галочками — для ценников сразу на несколько товаров (1.7.8)
  const [sel, setSel] = useState(() => new Set())
  const [cenniki, setCenniki] = useState(false)
  const toggle = (id) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const [historyFor, setHistoryFor] = useState(null) // товар, чью историю движения смотрим
  const [foto, setFoto] = useState(null) // товар, чьё фото смотрим на весь экран
  const telefon = useTelefon()
  // Ряд категорий с «Ещё» (ChipsMore) помнит «раскрыт» сам: новый key — новый ряд, свёрнутый
  const [chipsKey, setChipsKey] = useState(0)
  const svernutKategorii = () => setChipsKey((k) => k + 1)

  // Курсор в штрихкод под сканер ставит сама форма — там же, где поле

  // Чипы-фильтры — тот же список, что и в форме товара (без дублей из старых данных)
  const catList = useCategories()
  const categories = useMemo(() => ['Все', ...categoryNames(catList)], [catList])
  // Телефон: выбрали категорию — ряд новый, свёрнутый и с начала. ChipsMore сворачивает ряд и
  // сам, но прокрутка раскрытого ряда при этом оставалась: выбранная кнопка, которая в
  // свёрнутом ряду первая, уезжала вверх за край
  function pickCat(c) {
    setCat(c)
    if (telefon) svernutKategorii()
  }
  // Телефон: начали листать список при раскрытом «Ещё» — ряд сворачивается (как выпадающий
  // список при касании мимо), иначе раскрытая полоса закрывала бы полсписка. Листание внутри
  // полосы (самого ряда категорий) не в счёт. Только жесты пальца и колесо: прокрутку, которую
  // делает сам браузер, когда полоса растёт, жестом не считаем — иначе ряд сворачивался бы,
  // едва раскрывшись
  useEffect(() => {
    if (!telefon) return undefined
    const raskryt = () => !!document.querySelector('.prod-stick .chips-more.open')
    const mimo = (e) => !e.target?.closest?.('.prod-stick, .overlay')
    let y0 = null
    const start = (e) => { y0 = mimo(e) ? e.touches[0]?.clientY ?? null : null }
    const move = (e) => {
      if (y0 === null || Math.abs((e.touches[0]?.clientY ?? y0) - y0) < 12) return
      y0 = null
      if (raskryt()) svernutKategorii()
    }
    const wheel = (e) => { if (mimo(e) && raskryt()) svernutKategorii() }
    window.addEventListener('touchstart', start, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('wheel', wheel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', start)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('wheel', wheel)
    }
  }, [telefon])

  // Поиск — по названию или штрихкоду, в том числе сканером (и маркировкой DataMatrix)
  const z = useMemo(() => poiskZapros(q), [q])
  // Модуль сырья выключен — вкладки не показываем, остаёмся на «Товары» (для продажи)
  const scopeEff = rawOn ? scope : 'sale'
  const filtered = products.filter((p) => {
    // Сырьё («не для продажи») и обычные товары — на разных вкладках (1.8.7)
    const okScope = scopeEff === 'all' || (scopeEff === 'raw' ? p.forSale === false : p.forSale !== false)
    const okCat = cat === 'Все' || p.category === cat
    const okQ = tovarPodhodit(z, p.name, p.barcode)
    return okScope && okCat && okQ
  })
  const pg = usePagination(filtered, 10, q + '|' + cat + '|' + scopeEff)

  async function save() {
    const f = edit
    if (!f.name || !f.barcode) return toast(t('Укажите название и штрихкод'), 'err')
    // Сменили мешок — сначала ответ, за что были прежние цены (ProductForm, repackAsk)
    if (repackNeeded(f)) return toast(t('Укажите, за что были прежние цены: за прежнюю упаковку или уже за новую'), 'err')
    // DataMatrix -> GTIN(EAN-13); обычный штрихкод как есть
    const data = productPayload(f, { normalizeBarcode: normalizeScan })
    const dup = products.find((p) => canonBarcode(p.barcode) === canonBarcode(data.barcode) && p.id !== f.id)
    if (dup) return toast(t('Такой штрихкод уже есть') + ': ' + dup.name, 'err')

    // Продажа дешевле закупки бывает нужна, но чаще это опечатка в цене
    if (sellsBelowCost(data.cost, data.price)) {
      const ok = await dialog.confirm({
        title: t('Цена продажи ниже закупочной'),
        message: `${t('Закупили по')} ${money(data.cost)}, ${t('продаёте по')} ${money(data.price)}. ${t('Каждая продажа принесёт убыток. Сохранить всё равно?')}`,
        danger: true,
        confirmText: t('Сохранить'),
      })
      if (!ok) return
    }

    if (f.id) {
      // Остаток — только если его правили (см. lib/productEdit.js)
      db.update('products', f.id, editPatch(f, data, f.stockWas)).catch((e) => toast(e.message, 'err'))
      toast(t('Товар обновлён'))
    } else {
      db.push('products', data).catch((e) => toast(e.message, 'err'))
      toast(t('Товар добавлен'))
    }
    setEdit(null)
  }

  async function del(p) {
    const ok = await dialog.confirm({
      title: t('Удалить товар?'),
      // Название — словом без пробелов бывает длиннее окна: на телефоне переносится (m-tovary.css)
      message: <span className="okno-slovo">«{p.name}» {t('будет удалён из базы.')}</span>,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    db.remove('products', p.id).catch((e) => toast(e.message, 'err'))
    toast(t('Удалено'))
  }

  function openEdit(p) {
    setEdit({
      ...p,
      cost: String(p.cost), price: String(p.price), minStock: String(p.minStock),
      piecePrice: Number(p.piecePrice) > 0 ? String(p.piecePrice) : '',
      // Весовой товар правится в килограммах: 12 кг 350 г -> «12.35»
      stock: isVesovoy(p) ? String(stockUnits(p) / 1000) : String(p.stock),
      unit: p.unit || '',
      type: p.type || '',
      unitsPerPack: String(p.unitsPerPack ?? 1), looseUnits: isVesovoy(p) ? '0' : String(p.looseUnits ?? 0),
      // Сколько кг (л, м) в мешке у дробного товара (1.5.12); без мешка — пусто. Какими были
      // упаковка, цены и остаток при открытии — по ним спросим, за что были цены, если мешок сменят
      vesUp: isVesovoy(p) ? vesUpText(p.unitsPerPack) : '',
      upp0: Number(p.unitsPerPack) || 1, cost0: String(p.cost), price0: String(p.price), stock0: stockUnits(p),
      dosage: p.dosage || '',
      expiryDate: p.expiryDate ? String(p.expiryDate).slice(0, 10) : '',
      analogIds: Array.isArray(p.analogIds) ? p.analogIds : [],
      // Сырьё/состав (1.8.5): форма держит строки состава с числом в единице ингредиента
      forSale: p.forSale !== false,
      recipe: (Array.isArray(p.recipe) ? p.recipe : []).map((r) => {
        const ing = products.find((x) => x.id === r.ingredientId)
        return { ingredientId: r.ingredientId, units: r.units, qty: recipeQtyText(ing, r.units) }
      }),
      stockWas: stockAtOpen(p),
    })
  }

  const totalValue = products.reduce((s, p) => s + stockValue(p), 0)


  // Выгрузка и печать: ВСЕГДА весь склад, независимо от поиска и фильтров —
  // так решил владелец. Итоги — в подзаголовке листа
  const exCols = [
    { header: t('Наименование'), key: 'name', width: 44 },
    { header: t('Штрихкод'), key: 'barcode', width: 17 },
    { header: t('Категория'), key: 'category', width: 18 },
    { header: t('Тип'), key: 'type', width: 16 },
    { header: t('Ед.'), key: 'unit', width: 9 },
    { header: t('Продажа'), key: 'price', width: 13, money: true },
    { header: t('Остаток'), key: 'ostatok', width: 13, num: true },
    ...(srokOn ? [{ header: t('Годен до'), key: 'exp', width: 13 }] : []),
  ]
  const exRows = useMemo(
    () =>
      [...products]
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map((p) => ({
          name: p.name + (p.dosage ? ` (${p.dosage})` : ''),
          barcode: p.barcode || '',
          category: p.category || '—',
          type: p.type || '—',
          unit: edinica(p),
          price: Number(p.price) || 0,
          ostatok: stockText(p),
          exp: p.expiryDate ? String(p.expiryDate).slice(0, 10) : '—',
        })),
    [products],
  )
  const exPodzag = `${t('Наименований')}: ${products.length} · ${t('Стоимость склада')}: ${money(products.reduce((s, p) => s + stockValue(p), 0))}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Товары'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Товары')}`, podzag: exPodzag, cols: exCols, rows: exRows })

  return (
    <Layout
      title={t('Товары')}
      note={`${products.length} ${t('наименований · склад на')} ${money(totalValue)}`}
      actions={<>
        <ExportPechat onExcel={exportExcel} />
        {can('products.labels') && sel.size > 0 && (
          <button className="btn ghost prod-cenniki-top" onClick={() => setCenniki(true)} data-testid="prod-cenniki">
            <span className="ic"><LuReceiptText size={16} /></span> {t('Ценники')} ({sel.size})
          </button>
        )}
        {can('products.create') && <button className="btn" data-tour="prod.add" onClick={() => setEdit({ ...empty })}><span className="ic"><LuPlus size={16} /></span> {t('Добавить товар')}</button>}
      </>}
    >
      <PrintSheet zagolovok={t('Товары')} podzag={exPodzag} cols={exCols} rows={exRows} />
      {/* Поиск и категории закреплены вверху: при прокрутке списка не уезжают (1.5.11) */}
      <StickyBar className="prod-stick">
        <div className="toolbar">
          <div className="search kamera-pole">
            {/* На телефоне подсказка короче: длинная в узкое поле не помещалась */}
            <input className="tovar-poisk" data-tour="prod.search" placeholder={telefon ? t('Название или штрихкод…') : t('Поиск по названию или штрихкоду…')} value={q} onChange={(e) => setQ(e.target.value)} />
            <KameraKnopka onCode={setQ} testid="kamera-tovary" />
          </div>
        </div>
        {/* Сырьё — отдельной вкладкой (1.8.7): по умолчанию «Товары» (сырьё скрыто),
            «Сырьё» — только «не для продажи», «Все» — вместе. Модуль «Сырьё и состав»
            выключен (1.8.11) — вкладок нет вовсе */}
        {rawOn && (
        <div className="prod-scope" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[['sale', t('Товары')], ['raw', t('Сырьё')], ['all', t('Все')]].map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={scope === v}
              className={'chip ' + (scope === v ? 'active' : '')}
              data-testid={'prod-scope-' + v}
              onClick={() => setScope(v)}
            >
              {label}
            </button>
          ))}
        </div>
        )}
        {/* Категорий бывает много: на телефоне — два ряда и «Ещё» (ChipsMore), в прилипшей
            полосе — один ряд и «Ещё» справа (m-tovary.css) */}
        <ChipsMore key={chipsKey} className="prod-chips" data-tour="prod.chips">
          {categories.map((c) => (
            <button key={c} className={'chip ' + (cat === c ? 'active' : '')} onClick={() => pickCat(c)}>{c}</button>
          ))}
        </ChipsMore>
      </StickyBar>

      {/* На телефоне строки — карточками (table-cards, m-tovary.css): вбок не листается */}
      <div className="panel" style={{ padding: 0 }}>
        <div className="table-cards-wrap">
          <table className="table-cards prod-table">
            <thead>
              <tr>
                {can('products.labels') && (
                  <th className="cell-check" style={{ width: 36 }}>
                    {/* Подпись из data-label видна только на телефоне: шапки таблицы там нет,
                        а «отметить все» для ценников нужно и там */}
                    <label className="sel-all" data-label={t('Отметить все')}>
                      <input
                        type="checkbox"
                        aria-label={t('Отметить все')}
                        title={t('Отметить все')}
                        data-testid="prod-sel-all"
                        checked={filtered.length > 0 && filtered.every((p) => sel.has(p.id))}
                        onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((p) => p.id)) : new Set())}
                      />
                    </label>
                  </th>
                )}
                <th>{t('Наименование')}</th><th>{t('Штрихкод')}</th><th>{t('Категория')}</th>
                <th className="num">{t('Продажа')}</th><th className="num">{t('Остаток')}</th>{srokOn && <th>{t('Годен до')}</th>}<th></th>
              </tr>
            </thead>
            <tbody>
              {pg.slice.map((p) => {
                const e = expiryStatus(p)
                return (
                  <tr key={p.id}>
                    {can('products.labels') && (
                      <td className="cell-check">
                        {/* Подпись вокруг галочки — место нажатия: на телефоне 44×44 (m-tovary.css),
                            на компьютере — ровно галочка */}
                        <label className="sel-box">
                          <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} aria-label={t('Отметить') + ': ' + p.name} data-testid="prod-sel" />
                        </label>
                      </td>
                    )}
                    <td className="cell-main">
                      <span className="prod-name-cell">
                        {p.image && <img className="foto-mini" src={p.image} alt="" onClick={() => setFoto(p)} />}
                        <span><b>{p.name}</b>{p.dosage ? <div className="tag-cat">{p.dosage}</div> : null}{p.forSale === false ? <div className="tag-cat">{t('сырьё — не для продажи')}</div> : null}</span>
                      </span>
                    </td>
                    <td className="tag-cat" data-label={t('Штрихкод')}>{p.barcode}</td>
                    <td data-label={t('Категория')}>{p.category}{p.type ? <div className="tag-cat">{t(p.type)}</div> : null}</td>
                    <td className="num" data-label={t('Продажа')}><b>{money(p.price)}</b></td>
                    <td className="num" data-label={t('Остаток')}>
                      {isComposite(p) ? (
                        <span className="badge ok" title={t('Собирается из состава — списывается сырьё')}>{t('собрать')} {compositeBuildable(p, byId)}</span>
                      ) : (
                        <span className={'badge ' + (p.stock <= p.minStock ? 'low' : 'ok')}>{stockText(p, t)}</span>
                      )}
                    </td>
                    {/* Без срока — на телефоне строки «Годен до —» нет: карточка короче */}
                    {srokOn && <td data-label={t('Годен до')} className={e.has ? undefined : 'cell-hide'}>
                      {e.has ? (
                        <span style={{ color: EXP_COLOR[e.level], fontWeight: e.level === 'ok' ? 400 : 600, fontSize: 13 }}>
                          {fmtDate(p.expiryDate)}
                          {e.level !== 'ok' && <div className="tag-cat" style={{ color: EXP_COLOR[e.level] }}>{expiryLabel(e.days, t)}</div>}
                        </span>
                      ) : <span className="tag-cat">—</span>}
                    </td>}
                    {/* На телефоне всплывающих подсказок нет — под значками подписи (prod-act-cap) */}
                    <td className="num cell-actions" style={{ whiteSpace: 'nowrap' }}>
                      {can('products.labels') && (
                        <><button className="btn ghost sm icon" data-tour="prod.label" onClick={() => setLabelFor(p)} title={t('Печать этикетки')} aria-label={`${t('Печать этикетки')}: ${p.name}`}><LuTag size={15} />{telefon && <span className="prod-act-cap" aria-hidden="true">{t('Этикетки')}</span>}</button>{' '}</>
                      )}
                      {can('products.history') && (
                        <><button className="btn ghost sm icon" data-tour="prod.history" onClick={() => setHistoryFor(p)} title={t('Движение товара')} aria-label={`${t('Движение товара')}: ${p.name}`}><LuHistory size={15} />{telefon && <span className="prod-act-cap" aria-hidden="true">{t('История')}</span>}</button>{' '}</>
                      )}
                      {can('products.edit') && (
                        <><button className="btn ghost sm icon" data-tour="prod.row-actions" onClick={() => openEdit(p)} title={t('Изменить')} aria-label={`${t('Изменить')}: ${p.name}`}><LuPencil size={15} />{telefon && <span className="prod-act-cap" aria-hidden="true">{t('Изменить')}</span>}</button>{' '}</>
                      )}
                      {can('products.delete') && (
                        <button className="btn ghost sm icon" data-tour="prod.row-actions" onClick={() => del(p)} title={t('Удалить')} aria-label={`${t('Удалить')}: ${p.name}`}><LuTrash2 size={15} />{telefon && <span className="prod-act-cap" aria-hidden="true">{t('Удалить')}</span>}</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && <tr><td colSpan="8" className="empty">{t('Ничего не найдено')}</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination {...pg} />
      </div>

      {/* Телефон: отмеченные — полоса внизу экрана с «Ценники». Отмечают, листая список, а кнопка
          вверху страницы при этом уезжает. На компьютере полосы нет: кнопка — в шапке раздела */}
      {telefon && can('products.labels') && sel.size > 0 && (
        <div className="prod-selbar" data-testid="prod-selbar">
          <button type="button" className="btn ghost icon" onClick={() => setSel(new Set())} title={t('Снять отметки')} aria-label={t('Снять отметки')}>
            <LuX size={18} />
          </button>
          <span className="prod-selbar-n">{t('Выбрано')}: <b>{sel.size}</b></span>
          <button type="button" className="btn" onClick={() => setCenniki(true)} data-testid="prod-selbar-cenniki">
            <span className="ic"><LuReceiptText size={16} /></span> {t('Ценники')}
          </button>
        </div>
      )}

      {historyFor && <ProductHistory product={products.find((p) => p.id === historyFor.id) || historyFor} onClose={() => setHistoryFor(null)} />}

      {edit && (
        <Modal title={edit.id ? t('Редактировать товар') : t('Новый товар')} onClose={() => setEdit(null)}>
          <ProductForm value={edit} onChange={setEdit} />

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEdit(null)}>{t('Отмена')}</button>
            <button className="btn" data-tour="prod.save" onClick={save}>{t('Сохранить')}</button>
          </div>
        </Modal>
      )}

      {foto && <Lightbox src={foto.image} alt={foto.name} onClose={() => setFoto(null)} />}

      {cenniki && (
        <Suspense fallback={null}>
          <CennikiModal products={products.filter((p) => sel.has(p.id))} onClose={() => setCenniki(false)} />
        </Suspense>
      )}
      {labelFor && (
        <Suspense fallback={null}>
          <LabelPrint product={labelFor} onClose={() => setLabelFor(null)} />
        </Suspense>
      )}
    </Layout>
  )
}
