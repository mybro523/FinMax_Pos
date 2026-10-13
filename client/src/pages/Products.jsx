import { useState, useMemo, lazy, Suspense } from 'react'
import { LuPlus, LuPencil, LuTrash2, LuTag, LuHistory } from 'react-icons/lu'
import ProductHistory from '../components/ProductHistory'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money, db, stockText } from '../db/store'
import { normalizeScan, canonBarcode } from '../lib/scan'
import { expiryStatus, expiryLabel } from '../lib/expiry'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import { useCan } from '../db/auth'
import { useCategories, categoryNames } from '../lib/categories'
import { sellsBelowCost } from '../lib/pricing'
import ProductForm, { emptyProduct, productPayload } from '../components/ProductForm'
import Lightbox from '../components/Lightbox'
import { editPatch, stockAtOpen } from '../lib/productEdit'
import { isVesovoy, stockUnits, stockValue } from '../lib/units'

// Печать этикеток нужна редко — грузим по требованию, чтобы не утяжелять страницу
const LabelPrint = lazy(() => import('../components/LabelPrint'))

// Поля карточки живут в общем компоненте: ту же форму показывает касса, когда
// сканер поймал незнакомый штрихкод. Раньше это были два разных куска кода, и они
// разъехались — в «Товары» поля добавляли, в кассу забывали.
const empty = emptyProduct

const EXP_COLOR = { expired: 'var(--danger)', soon: 'var(--warn)', ok: 'var(--muted)' }

export default function Products() {
  const products = useCollection('products')
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  // Кассир видит список и остатки, но не правит карточки: цену можно тихо снизить,
  // продать и вернуть обратно, а удаление стирает товар вместе со следами недостачи.
  // Сервер такие запросы всё равно отклонит — кнопки убраны, чтобы кассир не упирался
  // в отказ там, где кнопка выглядит рабочей.
  const can = useCan()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('Все')
  const [edit, setEdit] = useState(null) // объект формы или null
  const [labelFor, setLabelFor] = useState(null) // товар, для которого печатаем этикетки
  const [historyFor, setHistoryFor] = useState(null) // товар, чью историю движения смотрим
  const [foto, setFoto] = useState(null) // товар, чьё фото смотрим на весь экран

  // Курсор в штрихкод под сканер ставит сама форма — там же, где поле



  // Чипы-фильтры — тот же список, что и в форме товара (без дублей из старых данных)
  const catList = useCategories()
  const categories = useMemo(() => ['Все', ...categoryNames(catList)], [catList])

  const filtered = products.filter((p) => {
    const okCat = cat === 'Все' || p.category === cat
    const okQ = !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.barcode.includes(q)
    return okCat && okQ
  })
  const pg = usePagination(filtered, 10, q + '|' + cat)

  async function save() {
    const f = edit
    if (!f.name || !f.barcode) return toast(t('Укажите название и штрихкод'), 'err')
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
      message: `«${p.name}» будет удалён из базы.`,
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
      // Весовой товар правится в килограммах: 12 кг 350 г -> «12.35»
      stock: isVesovoy(p) ? String(stockUnits(p) / 1000) : String(p.stock),
      unit: p.unit || '',
      unitsPerPack: String(p.unitsPerPack ?? 1), looseUnits: isVesovoy(p) ? '0' : String(p.looseUnits ?? 0),
      dosage: p.dosage || '',
      expiryDate: p.expiryDate ? String(p.expiryDate).slice(0, 10) : '',
      analogIds: Array.isArray(p.analogIds) ? p.analogIds : [],
      stockWas: stockAtOpen(p),
    })
  }

  const totalValue = products.reduce((s, p) => s + stockValue(p), 0)


  return (
    <Layout
      title={t('Товары')}
      subtitle={`${products.length} ${t('наименований · склад на')} ${money(totalValue)}`}
      actions={can('products.create') && <button className="btn" data-tour="prod.add" onClick={() => setEdit({ ...empty })}><span className="ic"><LuPlus size={16} /></span> {t('Добавить товар')}</button>}
    >
      <div className="toolbar">
        <input className="search" data-tour="prod.search" placeholder={t('Поиск по названию или штрихкоду…')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips" data-tour="prod.chips" style={{ marginBottom: 16 }}>
        {categories.map((c) => (
          <button key={c} className={'chip ' + (cat === c ? 'active' : '')} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>{t('Наименование')}</th><th>{t('Штрихкод')}</th><th>{t('Категория')}</th>
              <th className="num">{t('Продажа')}</th><th className="num">{t('Остаток')}</th><th>{t('Годен до')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {pg.slice.map((p) => {
              const e = expiryStatus(p)
              return (
                <tr key={p.id}>
                  <td>
                    <span className="prod-name-cell">
                      {p.image && <img className="foto-mini" src={p.image} alt="" onClick={() => setFoto(p)} />}
                      <span><b>{p.name}</b>{p.dosage ? <div className="tag-cat">{p.dosage}</div> : null}</span>
                    </span>
                  </td>
                  <td className="tag-cat">{p.barcode}</td>
                  <td>{p.category}</td>
                  <td className="num"><b>{money(p.price)}</b></td>
                  <td className="num">
                    <span className={'badge ' + (p.stock <= p.minStock ? 'low' : 'ok')}>{stockText(p)}</span>
                  </td>
                  <td>
                    {e.has ? (
                      <span style={{ color: EXP_COLOR[e.level], fontWeight: e.level === 'ok' ? 400 : 600, fontSize: 13 }}>
                        {fmtDate(p.expiryDate)}
                        {e.level !== 'ok' && <div className="tag-cat" style={{ color: EXP_COLOR[e.level] }}>{expiryLabel(e.days)}</div>}
                      </span>
                    ) : <span className="tag-cat">—</span>}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {can('products.labels') && (
                      <><button className="btn ghost sm icon" data-tour="prod.label" onClick={() => setLabelFor(p)} title={t('Печать этикетки')}><LuTag size={15} /></button>{' '}</>
                    )}
                    {can('products.history') && (
                      <><button className="btn ghost sm icon" data-tour="prod.history" onClick={() => setHistoryFor(p)} title={t('Движение товара')} aria-label={`${t('Движение товара')}: ${p.name}`}><LuHistory size={15} /></button>{' '}</>
                    )}
                    {can('products.edit') && (
                      <><button className="btn ghost sm icon" data-tour="prod.row-actions" onClick={() => openEdit(p)} title={t('Изменить')} aria-label={`${t('Изменить')}: ${p.name}`}><LuPencil size={15} /></button>{' '}</>
                    )}
                    {can('products.delete') && (
                      <button className="btn ghost sm icon" data-tour="prod.row-actions" onClick={() => del(p)} title={t('Удалить')} aria-label={`${t('Удалить')}: ${p.name}`}><LuTrash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && <tr><td colSpan="7" className="empty">{t('Ничего не найдено')}</td></tr>}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

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

      {labelFor && (
        <Suspense fallback={null}>
          <LabelPrint product={labelFor} onClose={() => setLabelFor(null)} />
        </Suspense>
      )}
    </Layout>
  )
}
