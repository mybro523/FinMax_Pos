import { useMemo } from 'react'
import { LuTag, LuPercent } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { PayBadge } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money } from '../db/store'
import { fmtDateTime } from '../lib/time'
import { lineUnits, lineGross, lineDiscount, isDivisible } from '../lib/units'
import { useT } from '../lib/i18n'

export default function Discounts() {
  const sales = useCollection('sales')
  const t = useT()

  // История скидок берётся напрямую из продаж — чтобы отчёты не расходились.
  // Суммы считаются общей формулой из lib/units. Раньше здесь лежала своя копия
  // «цена × упаковки»: у товара, проданного поштучно из вскрытой пачки, упаковок
  // ноль — сумма позиции выходила нулевой, и «Итог» показывал минус скидку.
  const rows = useMemo(() => {
    const out = []
    sales
      .filter((s) => s && Array.isArray(s.items))
      .forEach((s) =>
        s.items.forEach((i, idx) => {
          const discount = lineDiscount(i)
          if (discount <= 0) return
          const gross = lineGross(i)
          out.push({
            date: s.date,
            name: i.name,
            qty: i.qty || 0,
            pieces: i.pieces || 0,
            units: lineUnits(i),
            divisible: isDivisible(i),
            gross,
            discount,
            net: gross - discount,
            payment: s.payment,
            key: s.id + '_' + idx, // уникален даже при одинаковых названиях в чеке
          })
        }),
      )
    return out.sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [sales])

  const totalDiscount = rows.reduce((s, r) => s + r.discount, 0)
  const pg = usePagination(rows, 10)

  return (
    <Layout title={t('История скидок')} subtitle={`${rows.length} ${t('операций со скидкой')}`}>
      <div className="cards" data-tour="disc.cards" style={{ gridTemplateColumns: 'repeat(2,1fr)', marginBottom: 16 }}>
        <Metric label={t('Всего скидок выдано')} value={money(totalDiscount)} Icon={LuTag} />
        <Metric label={t('Операций со скидкой')} value={rows.length} Icon={LuPercent} />
      </div>

      <div className="panel" data-tour="disc.list" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>{t('Дата и время')}</th><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th>
              <th className="num">{t('Без скидки')}</th><th className="num">{t('Скидка')}</th>
              <th className="num">{t('Итог')}</th><th>{t('Оплата')}</th>
            </tr>
          </thead>
          <tbody>
            {pg.slice.map((r) => (
              <tr key={r.key}>
                <td>{fmtDateTime(r.date)}</td>
                <td><b>{r.name}</b></td>
                <td className="num">
                  {r.qty > 0 && `${r.qty} ${t('уп')}`}
                  {r.qty > 0 && r.pieces > 0 && ' + '}
                  {r.pieces > 0 && `${r.pieces} ${t('шт')}`}
                  {r.divisible && <div className="tag-cat">{r.units} {t('шт')}</div>}
                </td>
                <td className="num tag-cat" style={{ textDecoration: 'line-through' }}>{money(r.gross)}</td>
                <td className="num" style={{ color: 'var(--danger)' }}>−{money(r.discount)}</td>
                <td className="num"><b>{money(r.net)}</b></td>
                <td><PayBadge type={r.payment} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="7" className="empty">{t('Скидок ещё не было. Укажите скидку на позицию в кассе — она появится здесь.')}</td></tr>
            )}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>
    </Layout>
  )
}
