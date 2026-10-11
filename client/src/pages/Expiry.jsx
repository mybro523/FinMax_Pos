import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { LuCalendarClock, LuTriangleAlert, LuCircleCheck, LuTrash2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import { useAuth } from '../db/auth'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, stockText } from '../db/store'
import { expiredUnits, sellableUnits, hasExpired } from '../lib/units'
import { expiryStatus, expiryLabel, EXPIRY_WARN_DAYS } from '../lib/expiry'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'

const EXP_COLOR = { expired: 'var(--danger)', soon: 'var(--warn)', ok: 'var(--muted)' }

export default function Expiry() {
  const products = useCollection('products')
  const t = useT()
  const nav = useNavigate()
  const user = useAuth()
  const isFounder = user?.role === 'founder'
  const [mode, setMode] = useState('warn') // warn | all

  // Списание доступно только основателю — переносим товар на страницу списания
  function writeOff(p) {
    try {
      sessionStorage.setItem('writeoff_product', p.id)
    } catch {
      /* приватный режим */
    }
    nav('/writeoffs')
  }

  const rows = useMemo(() => {
    const withExp = products
      .map((p) => ({ p, s: expiryStatus(p) }))
      .filter((x) => x.s.has)
      .sort((a, b) => a.s.days - b.s.days)
    const expired = withExp.filter((x) => x.s.level === 'expired').length
    const soon = withExp.filter((x) => x.s.level === 'soon').length
    const list = mode === 'warn' ? withExp.filter((x) => x.s.level !== 'ok') : withExp
    return { list, expired, soon, total: withExp.length }
  }, [products, mode])

  const pg = usePagination(rows.list, 10, mode)

  return (
    <Layout title={t('Срок годности товаров')} subtitle={`${t('Контроль сроков (предупреждение за')} ${EXPIRY_WARN_DAYS} ${t('дней)')}`}>
      <div className="cards" data-tour="exp.cards" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
        <div className="metric">
          <div className="metric-head"><div className="label">{t('Просрочено')}</div><div className="ic-box" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}><LuTriangleAlert size={19} /></div></div>
          <div className="value" style={{ color: rows.expired ? 'var(--danger)' : undefined }}>{rows.expired}</div>
        </div>
        <div className="metric">
          <div className="metric-head"><div className="label">{t('Истекает (≤')}{EXPIRY_WARN_DAYS}{t(' дн.)')}</div><div className="ic-box" style={{ background: '#fdf0dc', color: 'var(--warn)' }}><LuCalendarClock size={19} /></div></div>
          <div className="value" style={{ color: rows.soon ? 'var(--warn)' : undefined }}>{rows.soon}</div>
        </div>
        <div className="metric">
          <div className="metric-head"><div className="label">{t('Всего со сроком')}</div><div className="ic-box" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><LuCircleCheck size={19} /></div></div>
          <div className="value">{rows.total}</div>
        </div>
      </div>

      <div className="chips" data-tour="exp.chips" style={{ marginBottom: 16 }}>
        <button className={'chip ' + (mode === 'warn' ? 'active' : '')} onClick={() => setMode('warn')}>{t('Требуют внимания')}</button>
        <button className={'chip ' + (mode === 'all' ? 'active' : '')} onClick={() => setMode('all')}>{t('Все со сроком')}</button>
      </div>

      <div className="panel" data-tour="exp.table" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>{t('Товар')}</th><th>{t('Категория')}</th><th className="num">{t('Остаток')}</th><th>{t('Годен до')}</th><th className="num">{t('Осталось')}</th>{isFounder && <th></th>}</tr>
          </thead>
          <tbody>
            {pg.slice.map(({ p, s }) => (
              <tr key={p.id}>
                <td><b>{p.name}</b>{p.dosage ? <span className="tag-cat"> · {p.dosage}</span> : null}</td>
                <td>{p.category}</td>
                <td className="num">
                  {stockText(p)}
                  {hasExpired(p) && (
                    <div className="tag-cat" style={{ color: 'var(--danger)' }}>
                      {t('негодно')} {expiredUnits(p)} {t('шт')} · {t('годно')} {sellableUnits(p)} {t('шт')}
                    </div>
                  )}
                </td>
                <td style={{ color: EXP_COLOR[s.level], fontWeight: s.level === 'ok' ? 400 : 600 }}>{fmtDate(p.expiryDate)}</td>
                <td className="num" style={{ color: EXP_COLOR[s.level], fontWeight: s.level === 'ok' ? 400 : 600 }}>{expiryLabel(s.days)}</td>
                {isFounder && (
                  <td className="num">
                    <button className="btn ghost sm" data-tour="exp.writeoff" onClick={() => writeOff(p)} title={t('Списать просроченный товар')}>
                      <LuTrash2 size={14} /> {t('Списать')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows.list.length === 0 && (
              <tr><td colSpan={isFounder ? 6 : 5} className="empty">{mode === 'warn' ? t('Нет товаров с истекающим сроком — всё в порядке') : t('Ни у одного товара не указан срок годности')}</td></tr>
            )}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>
    </Layout>
  )
}
