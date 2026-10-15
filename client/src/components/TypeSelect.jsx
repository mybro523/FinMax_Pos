import { useState } from 'react'
import { LuPlus } from 'react-icons/lu'
import { db } from '../db/store'
import { useCan } from '../db/auth'
import { useT } from '../lib/i18n'
import { Modal } from './ui'

// ── Тип товара: заведение прямо из карточки ──
// «+» рядом со списком типов заводит новый тип — это тот же список, что в Настройках,
// поэтому там он появится сразу. Сразу же можно отметить «с аналогами»: тогда в
// карточке откроется поле аналогов. Кнопка видна тем, кому разрешены настройки
// категорий: типы и категории — одна и та же настройка склада.
export function AddTypeBtn({ toast, options, onPicked }) {
  const can = useCan()
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!can('settings.categories')) return null
  return (
    <>
      <button type="button" className="btn icon" style={{ flexShrink: 0 }} title={t('Новый тип товара')} aria-label={t('Новый тип товара')} data-tour="pf.type-add" onClick={() => setOpen(true)}>
        <LuPlus size={16} />
      </button>
      {open && <NewTypeModal toast={toast} options={options} onPicked={onPicked} onClose={() => setOpen(false)} />}
    </>
  )
}

function NewTypeModal({ toast, options, onPicked, onClose }) {
  const t = useT()
  const [name, setName] = useState('')
  const [analogs, setAnalogs] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    const value = name.trim().slice(0, 40)
    if (!value) return toast(t('Укажите название типа товара'), 'err')
    const same = (options || []).find((x) => x.toLowerCase() === value.toLowerCase())
    if (same) {
      onPicked(same)
      return onClose()
    }
    setSaving(true)
    try {
      await db.push('productTypes', { name: value, analogs })
      onPicked(value)
      toast(t('Тип товара добавлен — он появился и в настройках'))
      onClose()
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('Новый тип товара')} onClose={onClose}>
      <div className="field">
        <label htmlFor="newTypeName">{t('Название')}</label>
        <input id="newTypeName" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder={t('Напр. Детские товары')} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 14 }}>
        <input type="checkbox" checked={analogs} onChange={(e) => setAnalogs(e.target.checked)} style={{ width: 17, height: 17 }} />
        {t('с аналогами — в карточке появится поле «Аналоги»')}
      </label>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>{t('Отмена')}</button>
        <button type="button" className="btn" onClick={save} disabled={saving}>{t('Добавить')}</button>
      </div>
    </Modal>
  )
}
