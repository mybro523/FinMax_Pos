import { useMemo, useState } from 'react'
import { LuLayers, LuPlus, LuSearch } from 'react-icons/lu'
import { money } from '../../db/store'
import { useT } from '../../lib/i18n'
import { n2 } from '../../lib/prihod'
import { addSupplier } from './SupplierPick'

// ── Поставщики — колонкой слева ──
// Выбрали поставщика — все вкладки показывают только его, и новый приход оформляется
// на него. «Все поступления» — снять выбор. У кого есть долг — красным, с суммой
// (долги видит только тот, кому разрешены поставщики: остальным сервер их не отдаёт)
export default function SupplierColumn({ suppliers, value, onChange, showDebt, canAdd, dialog, toast }) {
  const t = useT()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return suppliers.filter((s) => !needle || s.name.toLowerCase().includes(needle) || String(s.phone || '').includes(needle))
  }, [suppliers, q])
  const total = useMemo(() => suppliers.reduce((s, x) => s + Math.max(0, Number(x.debt) || 0), 0), [suppliers])

  async function add() {
    const id = await addSupplier({ suppliers, dialog, toast })
    if (id) onChange(id)
  }

  return (
    <aside className="prh-side" data-tour="arr.side" aria-label={t('Поставщики')}>
      <button type="button" className={'prh-side-btn' + (!value ? ' active' : '')} onClick={() => onChange('')}>
        <LuLayers size={16} /> {t('Все поступления')}
      </button>
      {canAdd && (
        <button type="button" className="prh-side-btn new" onClick={add}>
          <LuPlus size={16} /> {t('Новый поставщик')}
        </button>
      )}
      <label className="prh-side-search">
        <LuSearch size={15} aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Список поставщиков…')} aria-label={t('Поиск поставщика')} />
      </label>
      <ul className="prh-side-list">
        {list.map((s) => {
          const debt = showDebt ? Number(s.debt) || 0 : 0
          return (
            <li key={s.id}>
              <button
                type="button"
                className={(value === s.id ? 'active' : '') + (debt > 0 ? ' debt' : '')}
                onClick={() => onChange(value === s.id ? '' : s.id)}
                title={debt > 0 ? `${s.name} — ${t('долг')} ${money(debt)}` : s.name}
                aria-pressed={value === s.id}
              >
                <span className="prh-side-name">{s.name}</span>
                {debt > 0 && <span className="prh-side-debt">{n2(debt)}</span>}
              </button>
            </li>
          )
        })}
        {!list.length && <li className="prh-side-empty">{suppliers.length ? t('Ничего не найдено') : t('Поставщиков пока нет')}</li>}
      </ul>
      {showDebt && total > 0 && (
        <div className="prh-side-foot">{t('Должны всего')}: <b>{money(total)}</b></div>
      )}
    </aside>
  )
}
