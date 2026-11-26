import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LuClock, LuPackagePlus, LuTrash2, LuBookmark } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, db, money, realId } from '../db/store'
import { fmtDateTime } from '../lib/time'
import { normalizeScan } from '../lib/scan'
import { useT, translate as tr } from '../lib/i18n'
import { useModul } from '../lib/useModul'
import KameraKnopka from '../components/KameraKnopka'
import { useCan } from '../db/auth'
import { useCategories, categoryNames } from '../lib/categories'
import { sellsBelowCost } from '../lib/pricing'
import NumberInput from '../components/NumberInput'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'
import { useTelefon } from '../components/StickyBar'
import { chitatOtlozh, pisatOtlozh, klyuchOtlozh, razobratOtlozh, vernutVChek } from '../lib/otlozhennye'
import { lineUnits, lineNet, unitsText } from '../lib/units'

export default function Deferred() {
  const deferred = useCollection('deferred')
  const products = useCollection('products')
  const toast = useToast()
  const dialog = useDialog()
  const t = useT()
  const nav = useNavigate()
  const [edit, setEdit] = useState(null) // {id, barcode} отложенного, который заводим
  // Карточку заводит владелец: он задаёт цену продажи и закупочную. Кассир
  // складывает сюда незнакомые штрихкоды с кассы и видит, что ещё не оформлено.
  const can = useCan()
  const isFounder = can('products.create')
  const pg = usePagination(deferred, 10)

  // ── Переключатель: штрихкоды / товары (1.8.17) ──
  // «Отложенные товары» (lib/otlozhennye.js) — товары, отложенные на кассе (значок/F7). Их
  // список и возврат живут здесь, а не в кассе. Хранятся на устройстве, поэтому читаем из
  // localStorage, а не из общего кэша сервера.
  const phCode = getUser()?.pharmacy?.code || ''
  // «Отложенные товары» — свой модуль (otlozhTovary, 1.8.20): владелец включает/выключает
  // вкладку (и значок/F7 в кассе) отдельным тумблером. Выключен — показываем только штрихкоды.
  const otlozhTovaryOn = useModul('otlozhTovary')
  const [vid, setVid] = useState('codes') // 'codes' | 'tovary'
  const [otlozh, setOtlozh] = useState(() => chitatOtlozh(phCode))
  // Модуль выключили, пока были на вкладке товаров — возвращаемся к штрихкодам
  useEffect(() => {
    if (!otlozhTovaryOn && vid === 'tovary') setVid('codes')
  }, [otlozhTovaryOn, vid])
  // Открыли вкладку товаров — перечитываем: могли отложить на кассе в этой же вкладке
  useEffect(() => {
    if (vid === 'tovary') setOtlozh(chitatOtlozh(phCode))
  }, [vid, phCode])
  // Другая вкладка браузера отложила/вернула товар — обновляемся
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === klyuchOtlozh(phCode)) setOtlozh(razobratOtlozh(e.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [phCode])

  function ubratTovar(id) {
    const next = otlozh.filter((x) => x.id !== id)
    setOtlozh(next)
    pisatOtlozh(phCode, next)
  }
  // Вернуть товар в активный чек кассы и перейти на кассу (сверка цены/остатка — в helper)
  function vernutTovar(item) {
    const r = vernutVChek(phCode, item, products, realId)
    if (!r.ok) {
      toast(`«${item.name}» — ${r.why === 'gone' ? t('товар удалён из базы') : t('закончился на складе')}`, 'err')
      return
    }
    ubratTovar(item.id)
    toast(`«${r.name}» ${t('возвращён в чек')}`)
    nav('/pos')
  }
  // Подсветка тура («Завести товар», «Удалить») на телефоне — только у первой карточки:
  // общая рамка вокруг кнопок всех карточек шла полосой через весь список
  const phone = useTelefon()
  const tourFirst = (key, n) => (!phone || n === 0 ? key : undefined)

  // ── Выгрузка и печать: штрихкоды, которые ждут карточки ──
  const exCols = [
    { header: t('Штрихкод'), key: 'barcode', width: 24 },
    { header: t('Добавлен'), key: 'added', width: 20 },
  ]
  const exRows = deferred.map((d) => ({ barcode: d.barcode, added: d.createdAt ? fmtDateTime(d.createdAt) : '' }))
  const exPodzag = `${t('Ожидают оформления')}: ${deferred.length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Отложенные штрихкоды'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Отложенные штрихкоды')}`, podzag: exPodzag, cols: exCols, rows: exRows })

  async function del(item) {
    const ok = await dialog.confirm({
      title: t('Удалить отложенный штрихкод?'),
      message: `${t('Штрихкод')} ${item.barcode} ${t('будет удалён из списка.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    db.remove('deferred', item.id).catch((e) => toast(e.message, 'err'))
    toast(t('Удалено из отложенных'))
  }

  async function saveProduct(form) {
    if (!form.name.trim()) return toast(t('Введите название'), 'err')
    if (!form.category.trim()) return toast(t('Выберите категорию'), 'err')
    // Продажа дешевле закупки бывает нужна, но чаще это опечатка в цене
    if (sellsBelowCost(form.cost, form.price)) {
      const ok = await dialog.confirm({
        title: t('Цена продажи ниже закупочной'),
        message: `${t('Закупили по')} ${money(Number(form.cost) || 0)}, ${t('продаёте по')} ${money(Number(form.price) || 0)}. ${t('Каждая продажа принесёт убыток. Сохранить всё равно?')}`,
        danger: true,
        confirmText: t('Сохранить'),
      })
      if (!ok) return
    }
    try {
      // Ждём подтверждение: сначала товар успешно создан, потом чистим отложенный
      await db.push('products', {
        name: form.name.trim(),
        barcode: normalizeScan(form.barcode),
        category: form.category.trim(),
        cost: Number(form.cost) || 0,
        price: Number(form.price) || 0,
        stock: Number(form.stock) || 0,
        minStock: Number(form.minStock) || 5,
        unit: form.unit || 'шт',
        // Без этого товар заводился неделимым, и продать из него штуку
        // поштучно было нельзя, пока не откроешь карточку и не исправишь вручную
        unitsPerPack: Math.max(1, Number(form.unitsPerPack) || 1),
      })
      // Сервер сам удаляет отложенный штрихкод при создании товара; чистим и локально
      if (edit?.id) db.remove('deferred', edit.id).catch(() => {})
      toast(`«${form.name.trim()}» ${t('заведён')}`)
      setEdit(null)
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  return (
    <Layout
      title={t('Отложенные штрихкоды')}
      note={vid === 'codes' ? `${deferred.length} ${t('ожидают оформления')}` : `${otlozh.length} ${t('отложено')}`}
      actions={vid === 'codes' ? <ExportPechat onExcel={exportExcel} /> : null}
    >
      <PrintSheet zagolovok={t('Отложенные штрихкоды')} podzag={exPodzag} cols={exCols} rows={exRows} />

      {/* Переключатель показываем только с модулем «Отложенные товары»: без него вкладка
          товаров недоступна, остаётся один раздел штрихкодов — переключать нечего */}
      {otlozhTovaryOn && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={'chip ' + (vid === 'codes' ? 'active' : '')} data-testid="def-tab-codes" onClick={() => setVid('codes')}>
            <LuClock size={13} style={{ verticalAlign: '-2px' }} /> {t('Отложенные штрихкоды')}
          </button>
          <button className={'chip ' + (vid === 'tovary' ? 'active' : '')} data-testid="def-tab-tovary" onClick={() => setVid('tovary')}>
            <LuBookmark size={13} style={{ verticalAlign: '-2px' }} /> {t('Отложенные товары')}{otlozh.length ? <span className="prh-badge" style={{ marginLeft: 6 }}>{otlozh.length}</span> : null}
          </button>
        </div>
      )}

      {vid === 'tovary' ? (
        <OtlozhennyeTovary list={otlozh} onVernut={vernutTovar} onUbrat={ubratTovar} t={t} />
      ) : deferred.length === 0 ? (
        <div className="panel" data-tour="def.list">
          <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <LuClock size={34} style={{ color: 'var(--muted-2)' }} />
            {t('Здесь появляются штрихкоды, отсканированные на кассе, которых ещё нет в базе. На кассе нажмите «Добавить позже» — и штрихкод попадёт сюда.')}
          </div>
        </div>
      ) : (
        <div className="panel" data-tour="def.list" style={{ padding: 0 }}>
          {/* На телефоне штрихкоды — карточками (index.css, .table-cards): кнопки — внизу карточки */}
          <div className="table-cards-wrap">
          <table className="table-cards def-list">
            <thead>
              <tr><th>{t('Штрихкод')}</th><th>{t('Добавлен')}</th><th></th></tr>
            </thead>
            <tbody>
              {pg.slice.map((d, n) => (
                <tr key={d.id}>
                  <td className="cell-main"><b style={{ letterSpacing: 0.5 }}>{d.barcode}</b></td>
                  <td className="tag-cat" data-label={t('Добавлен')}>{d.createdAt ? fmtDateTime(d.createdAt) : '—'}</td>
                  <td className="num cell-actions" style={{ whiteSpace: 'nowrap' }}>
                    {isFounder && (
                      <>
                        <button className="btn sm" data-tour={tourFirst('def.create', n)} onClick={() => setEdit({ id: d.id, barcode: d.barcode })}>
                          <span className="ic"><LuPackagePlus size={15} /></span> {t('Завести товар')}
                        </button>{' '}
                      </>
                    )}
                    {can('deferred.manage') && <button className="btn ghost sm icon" data-tour={tourFirst('def.delete', n)} onClick={() => del(d)} title={t('Удалить')} aria-label={t('Удалить')}><LuTrash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <Pagination {...pg} />
        </div>
      )}

      {edit && <ProductForm barcode={edit.barcode} onSave={saveProduct} onClose={() => setEdit(null)} />}
    </Layout>
  )
}

// ── Отложенные товары (1.8.17) ──
// Товары, отложенные на кассе (значок/F7). По каждому — «Вернуть в чек» (кладёт в активный
// чек кассы и переходит на кассу) или «Убрать». Количество и сумма — снимок на момент, когда
// отложили; при возврате строка сверяется с базой (vernutVChek).
function OtlozhennyeTovary({ list, onVernut, onUbrat, t }) {
  if (!list.length) {
    return (
      <div className="panel">
        <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <LuBookmark size={34} style={{ color: 'var(--muted-2)' }} />
          {t('Отложенных товаров нет. На кассе отложите товар значком-закладкой или клавишей F7 — он попадёт сюда.')}
        </div>
      </div>
    )
  }
  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="table-cards-wrap">
        <table className="table-cards" data-testid="def-tovary-list">
          <thead>
            <tr><th>{t('Товар')}</th><th className="num">{t('Количество')}</th><th className="num">{t('Сумма')}</th><th></th></tr>
          </thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id} data-testid="def-tovary-row">
                <td className="cell-main"><b>{it.name}</b></td>
                <td className="num" data-label={t('Количество')}>{unitsText(lineUnits(it), it, t)}</td>
                <td className="num" data-label={t('Сумма')}><b>{money(lineNet(it))}</b></td>
                <td className="num cell-actions" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" data-testid="def-tovary-vernut" onClick={() => onVernut(it)}>{t('Вернуть в чек')}</button>{' '}
                  <button className="btn ghost sm icon" data-testid="def-tovary-ubrat" onClick={() => onUbrat(it.id)} title={t('Убрать')} aria-label={t('Убрать')}><LuTrash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProductForm({ barcode, onSave, onClose }) {
  const categories = categoryNames(useCategories())
  // На телефоне пустой пункт «Категории» — без тире по краям: по-таджикски
  // «— категорияро интихоб кунед —» на 320 px обрезалось
  const phone = useTelefon()
  const [f, setF] = useState({ name: '', barcode, category: '', cost: '', price: '', stock: '1', minStock: '5', unit: 'шт', unitsPerPack: '1' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  async function submit() {
    if (saving) return
    setSaving(true)
    try {
      await onSave(f)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title={<><span className="ic"><LuPackagePlus size={18} /></span>{tr('Завести товар по штрихкоду')}</>} onClose={onClose}>
      <div className="note info" style={{ marginBottom: 14 }}>{tr('Штрихкод')}: <b>{barcode}</b></div>
      <div className="field"><label>{tr('Название')}</label>
        <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('Напр. Индометацин 25мг №30')} autoFocus />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{tr('Штрихкод')}</label><div className="kamera-pole"><input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /><KameraKnopka onCode={(c) => set('barcode', c)} testid="kamera-deferred" /></div></div>
        <div className="field" style={{ flex: 1 }}>
          <label>{tr('Категория')}</label>
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">{phone ? tr('Выберите категорию') : tr('— выберите категорию —')}</option>
            {categories.map((c) => <option key={c} value={c}>{tr(c)}</option>)}
          </select>
        </div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{tr('Закупочная')}</label><NumberInput value={f.cost} onChange={(e) => set('cost', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>{tr('Цена продажи')}</label><NumberInput value={f.price} onChange={(e) => set('price', e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{tr('Остаток')}</label><NumberInput integer value={f.stock} onChange={(e) => set('stock', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}>
          <label>{tr('Штук в упаковке')}</label>
          <NumberInput integer value={f.unitsPerPack} onChange={(e) => set('unitsPerPack', e.target.value)} title="Для продажи поштучно. 1 = только целиком" />
        </div>
        <div className="field" style={{ width: 90 }}><label>{tr('Ед.')}</label><input value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{tr('Отмена')}</button>
        <button className="btn" onClick={submit} disabled={saving}>{saving ? tr('Сохранение…') : tr('Завести товар')}</button>
      </div>
    </Modal>
  )
}
