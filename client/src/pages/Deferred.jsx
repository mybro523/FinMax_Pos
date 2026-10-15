import { useState } from 'react'
import { LuClock, LuPackagePlus, LuTrash2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, db, money } from '../db/store'
import { fmtDateTime } from '../lib/time'
import { normalizeScan } from '../lib/scan'
import { useT, translate as tr } from '../lib/i18n'
import { useCan } from '../db/auth'
import { useCategories, categoryNames } from '../lib/categories'
import { sellsBelowCost } from '../lib/pricing'
import NumberInput from '../components/NumberInput'

export default function Deferred() {
  const deferred = useCollection('deferred')
  const toast = useToast()
  const dialog = useDialog()
  const t = useT()
  const [edit, setEdit] = useState(null) // {id, barcode} отложенного, который заводим
  // Карточку заводит владелец: он задаёт цену продажи и закупочную. Кассир
  // складывает сюда незнакомые штрихкоды с кассы и видит, что ещё не оформлено.
  const can = useCan()
  const isFounder = can('products.create')
  const pg = usePagination(deferred, 10)

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
        unit: form.unit || 'уп',
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
      subtitle={`${deferred.length} ${t('ожидают оформления')}`}
    >
      {deferred.length === 0 ? (
        <div className="panel" data-tour="def.list">
          <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <LuClock size={34} style={{ color: 'var(--muted-2)' }} />
            {t('Здесь появляются штрихкоды, отсканированные на кассе, которых ещё нет в базе. На кассе нажмите «Добавить позже» — и штрихкод попадёт сюда.')}
          </div>
        </div>
      ) : (
        <div className="panel" data-tour="def.list" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>{t('Штрихкод')}</th><th>{t('Добавлен')}</th><th></th></tr>
            </thead>
            <tbody>
              {pg.slice.map((d) => (
                <tr key={d.id}>
                  <td><b style={{ letterSpacing: 0.5 }}>{d.barcode}</b></td>
                  <td className="tag-cat">{d.createdAt ? fmtDateTime(d.createdAt) : '—'}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {isFounder && (
                      <>
                        <button className="btn sm" data-tour="def.create" onClick={() => setEdit({ id: d.id, barcode: d.barcode })}>
                          <span className="ic"><LuPackagePlus size={15} /></span> {t('Завести товар')}
                        </button>{' '}
                      </>
                    )}
                    {can('deferred.manage') && <button className="btn ghost sm icon" data-tour="def.delete" onClick={() => del(d)} title={t('Удалить')} aria-label={t('Удалить')}><LuTrash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination {...pg} />
        </div>
      )}

      {edit && <ProductForm barcode={edit.barcode} onSave={saveProduct} onClose={() => setEdit(null)} />}
    </Layout>
  )
}

function ProductForm({ barcode, onSave, onClose }) {
  const categories = categoryNames(useCategories())
  const [f, setF] = useState({ name: '', barcode, category: '', cost: '', price: '', stock: '1', minStock: '5', unit: 'уп', unitsPerPack: '1' })
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
        <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Напр. Индометацин 25мг №30" autoFocus />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{tr('Штрихкод')}</label><input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}>
          <label>{tr('Категория')}</label>
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">{tr('— выберите категорию —')}</option>
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
