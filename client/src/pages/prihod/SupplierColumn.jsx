import { useMemo, useState } from 'react'
import { LuChevronDown, LuChevronUp, LuLayers, LuPlus, LuSearch, LuWarehouse } from 'react-icons/lu'
import { money } from '../../db/store'
import { useT } from '../../lib/i18n'
import { n2 } from '../../lib/prihod'
import { useTelefon } from '../../components/StickyBar'
import { addSupplier } from './SupplierPick'

// Телефон: сколько поставщиков видно в колонке сразу (остальные — по кнопке «Ещё»)
const MALO = 5

// ── Поставщики — колонкой слева ──
// Выбрали поставщика — все вкладки показывают только его, и новый приход оформляется
// на него. «Все поступления» — снять выбор. У кого есть долг — красным, с суммой
// (долги видит только тот, кому разрешены поставщики: остальным сервер их не отдаёт)
// «Свой склад» (1.8.0) — первым пунктом: приход со своего склада, то есть перенос
// товара со склада в магазин (onSvoySklad; нет права — пункта нет)
//
// На телефоне (17.11.2026) колонка стоит над вкладками, а своя прокрутка списка внутри
// страницы пальцем неудобна (прокрутка в прокрутке). Поэтому там видно первых пятерых —
// и выбранного, если он дальше, — остальные по «Ещё». Поиск показывает всех найденных
export default function SupplierColumn({ suppliers, value, onChange, showDebt, canAdd, dialog, toast, svoySklad = false, onSvoySklad = null }) {
  const t = useT()
  const telefon = useTelefon()
  const [q, setQ] = useState('')
  const [vse, setVse] = useState(false)
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return suppliers.filter((s) => !needle || s.name.toLowerCase().includes(needle) || String(s.phone || '').includes(needle))
  }, [suppliers, q])
  const total = useMemo(() => suppliers.reduce((s, x) => s + Math.max(0, Number(x.debt) || 0), 0), [suppliers])
  // Сворачивать есть что, только если за «Ещё» спрячется больше одного: кнопка вместо одного
  // поставщика места не сбережёт
  const dlinnyi = telefon && !q.trim() && list.length > MALO + 1
  const shown = dlinnyi && !vse ? list.filter((s, i) => i < MALO || s.id === value) : list

  async function add() {
    const id = await addSupplier({ suppliers, dialog, toast })
    if (id) onChange(id)
  }

  return (
    <aside className="prh-side" data-tour="arr.side" aria-label={t('Поставщики')}>
      {onSvoySklad && (
        <button type="button" className={'prh-side-btn sklad' + (svoySklad ? ' active' : '')} data-testid="svoy-sklad" aria-pressed={svoySklad} onClick={onSvoySklad}>
          <LuWarehouse size={16} /> {t('Свой склад')}
        </button>
      )}
      <button type="button" className={'prh-side-btn' + (!value && !svoySklad ? ' active' : '')} onClick={() => onChange('')}>
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
        {shown.map((s) => {
          const debt = showDebt ? Number(s.debt) || 0 : 0
          return (
            <li key={s.id}>
              <button
                type="button"
                className={(value === s.id ? 'active' : '') + (debt > 0 ? ' debt' : '')}
                onClick={() => {
                  onChange(value === s.id ? '' : s.id)
                  // Выбрали — список снова короткий (выбранный в нём остаётся): вкладки ближе
                  setVse(false)
                }}
                title={debt > 0 ? `${s.name} — ${t('долг')} ${money(debt)}` : s.name}
                aria-pressed={value === s.id}
              >
                <span className="prh-side-name">{s.name}</span>
                {debt > 0 && <span className="prh-side-debt">{n2(debt)}</span>}
              </button>
            </li>
          )
        })}
        {dlinnyi && (
          <li>
            <button type="button" className="prh-side-more" aria-expanded={vse} onClick={() => setVse((v) => !v)} data-testid="prh-side-more">
              {vse ? <LuChevronUp size={15} /> : <LuChevronDown size={15} />}
              {vse ? t('Свернуть') : `${t('Ещё')} (${list.length - shown.length})`}
            </button>
          </li>
        )}
        {!list.length && <li className="prh-side-empty">{suppliers.length ? t('Ничего не найдено') : t('Поставщиков пока нет')}</li>}
      </ul>
      {showDebt && total > 0 && (
        <div className="prh-side-foot">{t('Должны всего')}: <b>{money(total)}</b></div>
      )}
    </aside>
  )
}
