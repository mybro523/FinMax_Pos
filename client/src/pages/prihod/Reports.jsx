import { useMemo, useState } from 'react'
import { LuScale, LuReceipt, LuBanknote } from 'react-icons/lu'
import { money } from '../../db/store'
import { fmtDateTime } from '../../lib/time'
import { useT } from '../../lib/i18n'
import { sverkaPostavshikov, zakupkiIOplaty } from '../../lib/otchety'
import { Pagination, usePagination } from '../../components/Pagination'

// ── Отчёты по поставщикам ──
// Сверка за период (долг на начало, закуплено, оплачено, долг на конец — такую
// таблицу показывают поставщику) и закупки по товарам: что у кого купили, сколько,
// почём, сколько оплачено сразу и сколько ушло в долг; погашения долга — отдельными
// строками. Поставщик выбран слева — только он.
//
// Долг на начало и конец считается от нынешнего долга назад, поэтому приходы и
// оплаты загружены от начала периода до сегодняшнего дня (см. lib/otchety.js).

export function useReports({ suppliers, arrivals, payments, products, range, supplierId, t }) {
  return useMemo(() => {
    const sv = sverkaPostavshikov({ suppliers, arrivals, supplierPayments: payments, from: range.from, to: range.to })
    const rows = supplierId ? sv.rows.filter((r) => r.supplierId === supplierId) : sv.rows
    const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100
    const sverka = { rows, itogo: { nachalo: sum('nachalo'), zakupleno: sum('zakupleno'), oplacheno: sum('oplacheno'), konec: sum('konec') } }
    const zak = zakupkiIOplaty({ arrivals, supplierPayments: payments, products, from: range.from, to: range.to, supplierId, t })
    return { sverka, zak }
  }, [suppliers, arrivals, payments, products, range, supplierId, t])
}

export default function Reports({ rep, suppliers, loading, periodLabel }) {
  const t = useT()
  const [q, setQ] = useState('')
  const nameOf = (x) => x.name || (x.supplierId ? '—' : t('Без поставщика'))
  const supName = (r) => r.supplier || (r.supplierId ? suppliers.find((s) => s.id === r.supplierId)?.name : '') || t('без поставщика')

  const zakRows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rep.zak.rows
    return rep.zak.rows.filter((r) => `${r.name} ${r.supplier}`.toLowerCase().includes(needle))
  }, [rep.zak.rows, q])
  const itogo = useMemo(() => zakRows.reduce((s, r) => ({ sum: s.sum + r.sum, paid: s.paid + r.paid, debt: s.debt + r.debt }), { sum: 0, paid: 0, debt: 0 }), [zakRows])
  const pg = usePagination(zakRows, 15, `${q}|${periodLabel}|${rep.zak.rows.length}`)

  return (
    <div className="prh-reports">
      <div className="panel" data-tour="rep.sverka" style={{ padding: 0, marginBottom: 16 }}>
        <div className="prh-panel-head">
          <h2><span className="h2-title"><span className="ic"><LuScale size={17} /></span>{t('Сверка с поставщиками')}</span></h2>
          <span className="tag-cat">{periodLabel}</span>
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th>{t('Поставщик')}</th><th className="num">{t('Долг на начало')}</th><th className="num">{t('Закуплено')}</th>
                <th className="num">{t('Оплачено')}</th><th className="num">{t('Долг на конец')}</th>
              </tr>
            </thead>
            <tbody>
              {rep.sverka.rows.map((x) => (
                <tr key={x.supplierId || 'none'}>
                  <td className="cell-main"><b>{nameOf(x)}</b></td>
                  <td className="num" data-label={t('Долг на начало')}>{money(x.nachalo)}</td>
                  <td className="num" data-label={t('Закуплено')}>{money(x.zakupleno)}</td>
                  <td className="num" data-label={t('Оплачено')} style={{ color: x.oplacheno > 0 ? 'var(--green)' : undefined }}>{money(x.oplacheno)}</td>
                  <td className="num" data-label={t('Долг на конец')}><b style={{ color: x.konec > 0 ? 'var(--danger)' : undefined }}>{money(x.konec)}</b></td>
                </tr>
              ))}
              {!rep.sverka.rows.length && <tr><td colSpan="5" className="empty">{loading ? t('Загружаем…') : t('За этот период движений по поставщикам нет')}</td></tr>}
            </tbody>
            {rep.sverka.rows.length > 1 && (
              <tfoot>
                <tr className="zak-total">
                  <td>{t('Итого')}</td>
                  <td className="num">{money(rep.sverka.itogo.nachalo)}</td>
                  <td className="num">{money(rep.sverka.itogo.zakupleno)}</td>
                  <td className="num">{money(rep.sverka.itogo.oplacheno)}</td>
                  <td className="num">{money(rep.sverka.itogo.konec)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="tag-cat" style={{ padding: '10px 16px 14px' }}>{t('Долг на конец = долг на начало + закуплено − оплачено.')}</div>
      </div>

      <div className="panel" data-tour="rep.zak" style={{ padding: 0 }}>
        <div className="prh-panel-head">
          <h2><span className="h2-title"><span className="ic"><LuReceipt size={17} /></span>{t('Закупки и оплаты')}</span></h2>
          <span className="tag-cat">{periodLabel}</span>
        </div>
        <div className="toolbar" style={{ padding: '0 16px 10px' }}>
          <input className="search" placeholder={t('Поиск по товару или поставщику…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards zak-table">
            <thead>
              <tr>
                <th>{t('Дата')}</th><th>{t('Поставщик')}</th><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th>
                <th className="num">{t('Цена')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('Оплачено')}</th><th className="num">{t('Долг')}</th><th>{t('Принял')}</th>
              </tr>
            </thead>
            <tbody>
              {pg.slice.map((r) => (
                <tr key={r.id} className={r.kind === 'pay' ? 'zak-pay' : ''}>
                  <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                  <td data-label={t('Поставщик')}>{supName(r)}</td>
                  <td className="cell-main">
                    {r.kind === 'pay' ? (
                      <span className="zak-pay-name"><LuBanknote size={14} /> {r.name}{r.fromCash && <span className="badge cash" style={{ marginLeft: 6 }}>{t('из кассы')}</span>}</span>
                    ) : <b>{r.name}</b>}
                  </td>
                  <td className="num" data-label={t('Кол-во')}>{r.qty || '—'}</td>
                  <td className="num" data-label={t('Цена')}>{r.kind === 'buy' ? money(r.price) : '—'}</td>
                  <td className="num" data-label={t('Сумма')}>{r.kind === 'buy' ? <b>{money(r.sum)}</b> : '—'}</td>
                  <td className="num" data-label={t('Оплачено')} style={{ color: r.paid > 0 ? 'var(--green)' : undefined }}>{money(r.paid)}</td>
                  <td className="num" data-label={t('Долг')} style={{ color: r.debt > 0 ? 'var(--danger)' : r.debt < 0 ? 'var(--green)' : undefined }}>
                    {r.debt < 0 ? '−' + money(-r.debt) : money(r.debt)}
                  </td>
                  <td data-label={t('Принял')} className="tag-cat">{r.user || '—'}</td>
                </tr>
              ))}
              {!zakRows.length && <tr><td colSpan="9" className="empty">{loading ? t('Загружаем…') : t('За этот период закупок и оплат нет')}</td></tr>}
            </tbody>
            {zakRows.length > 0 && (
              <tfoot>
                <tr className="zak-total">
                  <td colSpan="5">{t('Итого за период')}</td>
                  <td className="num">{money(itogo.sum)}</td>
                  <td className="num">{money(itogo.paid)}</td>
                  <td className="num">{itogo.debt < 0 ? '−' + money(-itogo.debt) : money(itogo.debt)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <Pagination {...pg} />
      </div>
    </div>
  )
}
