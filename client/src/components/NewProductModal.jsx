import { useState } from 'react'
import { LuClock, LuPackagePlus } from 'react-icons/lu'
import { Modal } from './ui'
import ProductForm, { emptyProduct } from './ProductForm'
import { translate as tr } from '../lib/i18n'

// ── Заведение товара, не выходя из кассы или прихода ──
// Буквально ТА ЖЕ форма, что в разделе «Товары», — один компонент на всех.
// Прежде касса и приход держали свои укороченные копии: без фото, веса,
// дозировки и срока — владелец заводил товар и половины карточки не видел.
//
// hideStock — для прихода: сколько пришло, вводится в строке прихода
// (для весового — в килограммах), иначе остаток задвоился бы.
export default function NewProductModal({ barcode, note, confirmText, hideStock, stock = '', onSave, onDefer, onClose }) {
  const [f, setF] = useState({ ...emptyProduct, barcode, stock, minStock: '5' })
  const [saving, setSaving] = useState(false)

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
    <Modal title={<><span className="ic"><LuPackagePlus size={18} /></span>{tr(barcode ? 'Новый товар по штрихкоду' : 'Новый товар')}</>} onClose={onClose}>
      <div className="note info" style={{ marginBottom: 14 }}>
        {barcode ? <>{tr('Штрихкод')}: <b>{barcode}</b> — </> : null}
        {note}
      </div>

      <ProductForm value={f} onChange={setF} autoFocus={barcode ? 'name' : 'barcode'} hideStock={hideStock} />

      <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
        {onDefer ? (
          <button className="btn ghost" onClick={onDefer} disabled={saving} title={tr('Отложить штрихкод')}>
            <span className="ic"><LuClock size={16} /></span> {tr('Добавить позже')}
          </button>
        ) : <span />}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>{tr('Отмена')}</button>
          <button className="btn" onClick={submit} disabled={saving}>{saving ? tr('Сохранение…') : confirmText}</button>
        </div>
      </div>
    </Modal>
  )
}
