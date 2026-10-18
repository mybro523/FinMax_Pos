import { LuPlus } from 'react-icons/lu'
import { db } from '../../db/store'
import { translate as tr } from '../../lib/i18n'

// ── Новый поставщик — не бросая приёмку ──
// Название и телефон в коротком окне. Такой уже есть — выбирается он, второй не
// заводится. Возвращает номер поставщика или '' (передумали, ошибка)
export async function addSupplier({ suppliers, dialog, toast }) {
  const r = await dialog.prompt({
    title: tr('Новый поставщик'),
    fields: [
      { name: 'name', label: tr('Название'), placeholder: tr('Напр. Опт-Маркет') },
      { name: 'phone', label: tr('Телефон') },
    ],
    confirmText: tr('Добавить'),
  })
  const name = (r?.name || '').trim()
  if (!r || !name) return ''
  const same = suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (same) return same.id
  try {
    const created = await db.push('suppliers', { name, phone: (r.phone || '').trim() })
    toast(tr('Поставщик добавлен'))
    return created.id
  } catch (e) {
    toast(tr(e.message), 'err')
    return ''
  }
}

// ── Поставщик прихода ──
// Из справочника, а не свободным текстом: только так приход в долг ляжет на нужного
// поставщика. Нового заводят тут же — кнопкой «+», если есть право на справочник
export function SupplierPick({ suppliers, value, onChange, dialog, toast, tour, canAdd = true }) {
  async function add() {
    const id = await addSupplier({ suppliers, dialog, toast })
    if (id) onChange(id)
  }
  return (
    <div className="field" data-tour={tour}>
      <label>{tr('Поставщик')}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{tr('— без поставщика —')}</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {canAdd && (
          <button type="button" className="btn ghost icon" onClick={add} title={tr('Новый поставщик')} aria-label={tr('Новый поставщик')}>
            <LuPlus size={17} />
          </button>
        )}
      </div>
    </div>
  )
}
