import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { LuCalendarClock, LuTriangleAlert, LuCircleCheck, LuTrash2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import StickyBar from '../components/StickyBar'
import { Modal } from '../components/ui'
import { useCan } from '../db/auth'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, stockText } from '../db/store'
import { expiredUnits, sellableUnits, hasExpired } from '../lib/units'
import { expiryStatus, expiryLabel, EXPIRY_WARN_DAYS } from '../lib/expiry'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'

const LEVEL = { expired: 'Просрочен', soon: 'Скоро истекает', ok: 'В норме' }

const EXP_COLOR = { expired: 'var(--danger)', soon: 'var(--warn)', ok: 'var(--muted)' }

export default function Expiry() {
  const products = useCollection('products')
  const t = useT()
  const nav = useNavigate()
  const can = useCan()
  const isFounder = can('writeoffs.create')
  const [mode, setMode] = useState('warn') // warn | all
  // Карточка сверху открывает окно со своими товарами: expired | soon | all
  const [okno, setOkno] = useState(null)

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
    return { list, expired, soon, total: withExp.length, withExp }
  }, [products, mode])

  const pg = usePagination(rows.list, 10, mode)
  const kartochka = (vid) => ({
    role: 'button',
    tabIndex: 0,
    onClick: () => setOkno(vid),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOkno(vid) } },
  })

  // ── Выгрузка и печать: то, что выбрано вкладкой (требуют внимания или все) ──
  const exCols = [
    { header: t('Товар'), key: 'name', width: 34 },
    { header: t('Категория'), key: 'cat', width: 18 },
    { header: t('Остаток'), key: 'stock', width: 16 },
    { header: t('Негодно, шт'), key: 'bad', width: 12, num: true },
    { header: t('Годен до'), key: 'date', width: 13 },
    { header: t('Осталось'), key: 'left', width: 18 },
    { header: t('Статус'), key: 'level', width: 16 },
  ]
  const exRows = rows.list.map(({ p, s }) => ({
    name: p.name + (p.dosage ? ` · ${p.dosage}` : ''), cat: p.category || '', stock: stockText(p),
    bad: hasExpired(p) ? expiredUnits(p) : '', date: fmtDate(p.expiryDate), left: expiryLabel(s.days), level: t(LEVEL[s.level] || ''),
  }))
  const exPodzag = [
    mode === 'warn' ? t('Требуют внимания') : t('Все со сроком'),
    `${t('Просрочено')}: ${rows.expired}`,
    `${t('Скоро истекает')}: ${rows.soon}`,
    `${t('Строк')}: ${rows.list.length}`,
  ].join(' · ')
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Срок годности'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Срок годности товаров')}`, podzag: exPodzag, cols: exCols, rows: exRows })

  return (
    <Layout title={t('Срок годности товаров')} subtitle={`${t('Контроль сроков (предупреждение за')} ${EXPIRY_WARN_DAYS} ${t('дней)')}`} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('Срок годности товаров')} podzag={exPodzag} cols={exCols} rows={exRows} />
      <div className="cards" data-tour="exp.cards" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
        <div className="metric clickable" {...kartochka('expired')} data-testid="card-exp-expired">
          <div className="metric-head"><div className="label">{t('Просрочено')}</div><div className="ic-box" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}><LuTriangleAlert size={19} /></div></div>
          <div className="value" style={{ color: rows.expired ? 'var(--danger)' : undefined }}>{rows.expired}</div>
        </div>
        <div className="metric clickable" {...kartochka('soon')} data-testid="card-exp-soon">
          <div className="metric-head"><div className="label">{t('Истекает (≤')}{EXPIRY_WARN_DAYS}{t(' дн.)')}</div><div className="ic-box" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}><LuCalendarClock size={19} /></div></div>
          <div className="value" style={{ color: rows.soon ? 'var(--warn)' : undefined }}>{rows.soon}</div>
        </div>
        <div className="metric clickable" {...kartochka('all')} data-testid="card-exp-all">
          <div className="metric-head"><div className="label">{t('Всего со сроком')}</div><div className="ic-box" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><LuCircleCheck size={19} /></div></div>
          <div className="value">{rows.total}</div>
        </div>
      </div>

      {okno && (() => {
        const list = okno === 'all' ? rows.withExp : rows.withExp.filter((x) => x.s.level === okno)
        const title = okno === 'expired' ? t('Просрочено') : okno === 'soon' ? `${t('Истекает (≤')}${EXPIRY_WARN_DAYS}${t(' дн.)')}` : t('Всего со сроком')
        return (
          <Modal wide title={title} onClose={() => setOkno(null)}>
            <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
              <table data-testid="exp-okno">
                <thead><tr><th>{t('Товар')}</th><th className="num">{t('Остаток')}</th><th>{t('Годен до')}</th><th className="num">{t('Осталось')}</th>{isFounder && <th></th>}</tr></thead>
                <tbody>
                  {list.map(({ p, s }) => (
                    <tr key={p.id}>
                      <td><b>{p.name}</b>{p.dosage ? <span className="tag-cat"> · {p.dosage}</span> : null}{p.category ? <div className="tag-cat">{p.category}</div> : null}</td>
                      <td className="num">
                        {stockText(p)}
                        {hasExpired(p) && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('негодно')} {expiredUnits(p)} {t('шт')}</div>}
                      </td>
                      <td style={{ color: EXP_COLOR[s.level], fontWeight: s.level === 'ok' ? 400 : 600 }}>{fmtDate(p.expiryDate)}</td>
                      <td className="num" style={{ color: EXP_COLOR[s.level], fontWeight: s.level === 'ok' ? 400 : 600 }}>{expiryLabel(s.days)}</td>
                      {isFounder && (
                        <td className="num">
                          <button className="btn ghost sm" onClick={() => writeOff(p)} title={t('Списать просроченный товар')}><LuTrash2 size={14} /> {t('Списать')}</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {list.length === 0 && <tr><td colSpan={isFounder ? 5 : 4} className="empty">{t('Нет товаров')}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="modal-actions"><button className="btn" onClick={() => setOkno(null)}>{t('Закрыть')}</button></div>
          </Modal>
        )
      })()}

      <StickyBar>
        <div className="chips" data-tour="exp.chips">
          <button className={'chip ' + (mode === 'warn' ? 'active' : '')} onClick={() => setMode('warn')}>{t('Требуют внимания')}</button>
          <button className={'chip ' + (mode === 'all' ? 'active' : '')} onClick={() => setMode('all')}>{t('Все со сроком')}</button>
        </div>
      </StickyBar>

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
