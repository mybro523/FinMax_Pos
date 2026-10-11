import { useEffect, useState } from 'react'
import { LuHistory } from 'react-icons/lu'
import { Modal } from './ui'
import { api } from '../db/api'
import { money, stockText } from '../db/store'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'

// ── История движения товара ──
// «Куда делись пять упаковок?» — все движения одного товара одним списком: приход,
// продажа, возврат, списание, пересчёт, правка остатка. У каждой строки — дата,
// сколько штук, кто сделал и остаток после неё. Считает сервер (products/history.ts),
// здесь только показ.

const PERIODS = [
  { key: '30', label: '30 дней' },
  { key: '90', label: '3 месяца' },
  { key: '365', label: 'Год' },
  { key: '0', label: 'Всё время' },
]

const KIND = {
  arrival: 'Приход',
  sale: 'Продажа',
  return: 'Возврат',
  writeoff: 'Списание',
  inventory: 'Пересчёт',
  edit: 'Правка остатка',
}

const REASON = { expired: 'просрочен', damaged: 'брак', lost: 'недостача', other: 'другое' }

// Подробности строки — словами, на выбранном языке
function details(r, t) {
  switch (r.kind) {
    case 'arrival':
      return [r.supplier && r.supplier !== '—' ? r.supplier : '', r.cost != null ? `${t('закуп.')} ${money(r.cost)}` : ''].filter(Boolean).join(' · ')
    case 'sale':
      return r.price != null ? `${t('цена')} ${money(r.price)}` : ''
    case 'return':
      return [r.restock ? t('обратно в продажу') : t('не в продажу — списан'), r.note].filter(Boolean).join(' · ')
    case 'writeoff':
      return [
        t(REASON[r.reason] || r.reason || ''),
        r.source === 'return' ? t('при возврате') : r.source === 'inventory' ? t('по пересчёту') : '',
        r.note,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'inventory':
      return `${t('по учёту')} ${r.expected} ${t('шт')}, ${t('насчитано')} ${r.actual} ${t('шт')}${r.note ? ' · ' + r.note : ''}`
    case 'edit':
      return `${t('было')} ${r.expected} ${t('шт')} → ${t('стало')} ${r.actual} ${t('шт')}`
    default:
      return ''
  }
}

export default function ProductHistory({ product, onClose }) {
  const t = useT()
  const [period, setPeriod] = useState('90')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .get(`/products/${product.id}/history?days=${period}`)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [product.id, period])

  const rows = data?.rows || []
  const upp = data?.unitsPerPack || 1
  const packs = (units) => (upp > 1 ? ` (${Math.floor(units / upp)} ${t('уп')}${units % upp ? ' + ' + (units % upp) + ' ' + t('шт') : ''})` : '')

  return (
    <Modal wide title={<><span className="ic"><LuHistory size={18} /></span>{t('Движение товара')}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 10, fontSize: 13 }}>
        <b style={{ color: 'var(--text)' }}>{product.name}</b> · {t('сейчас на складе')}: <b style={{ color: 'var(--text)' }}>{stockText(product)}</b>
      </div>
      <div className="chips" data-tour="ph.period" style={{ marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <button key={p.key} className={'chip ' + (period === p.key ? 'active' : '')} onClick={() => setPeriod(p.key)}>{t(p.label)}</button>
        ))}
      </div>
      {error && <div className="note err" style={{ marginBottom: 10 }}>{t(error)}</div>}
      {loading && !data && <div className="note info" style={{ marginBottom: 10 }}>{t('Загружаем историю…')}</div>}
      <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
        <table className="table-cards" data-tour="ph.rows">
          <thead>
            <tr><th>{t('Дата')}</th><th>{t('Что')}</th><th className="num">{t('Штук')}</th><th className="num">{t('Остаток после')}</th><th>{t('Кто')}</th></tr>
          </thead>
          <tbody>
            {rows.map((r, n) => (
              <tr key={r.kind + r.docId + n} style={r.moves ? undefined : { color: 'var(--muted)' }}>
                <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                <td className="cell-main">
                  <b>{t(KIND[r.kind] || r.kind)}</b>
                  {details(r, t) ? <div className="tag-cat">{details(r, t)}</div> : null}
                </td>
                <td className="num" data-label={t('Штук')} style={{ whiteSpace: 'nowrap', color: !r.moves ? 'var(--muted-2)' : r.delta > 0 ? 'var(--green)' : r.delta < 0 ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                  {!r.moves ? '—' : (r.delta > 0 ? '+' : '') + r.delta}
                </td>
                <td className="num" data-label={t('Остаток после')} style={{ whiteSpace: 'nowrap' }}>{r.after}{packs(r.after)}</td>
                <td data-label={t('Кто')}>{r.who || '—'}</td>
              </tr>
            ))}
            {data && rows.length === 0 && <tr><td colSpan="5" className="empty">{t('За этот период движений не было')}</td></tr>}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
        {t('Остаток после каждой строки считается от нынешнего назад. Серые строки остаток не двигают: списание при возврате и недостача по пересчёту — только записи об убытке.')}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t('Готово')}</button>
      </div>
    </Modal>
  )
}
