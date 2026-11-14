import { useMemo, useState } from 'react'
import { LuTag, LuPercent } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { Modal, PayBadge, PAYMENTS } from '../components/ui'
import { ChekiOkno } from '../components/Cheki'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'
import { SALES_CACHE_DAYS } from '../db/store'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money } from '../db/store'
import { fmtDateTime } from '../lib/time'
import { lineUnits, lineGross, lineDiscount, isDivisible, isVesovoy, kgText, edinica } from '../lib/units'
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
            // Весовой в мешке (1.5.12) — всего килограммов, а не граммов «штуками»
            unitsText: isVesovoy(i) ? `${kgText(lineUnits(i))} ${edinica(i)}` : '',
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
  // Карточки открывают подробности: скидки по товарам и чеки со скидкой
  const [okno, setOkno] = useState(null)
  const poTovaram = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const x = m.get(r.name) || { name: r.name, count: 0, gross: 0, discount: 0 }
      x.count += 1
      x.gross += r.gross
      x.discount += r.discount
      m.set(r.name, x)
    }
    return [...m.values()].sort((a, b) => b.discount - a.discount)
  }, [rows])
  const chekiSoSkidkoy = useMemo(
    () => sales.filter((s) => s && Array.isArray(s.items) && s.items.some((i) => lineDiscount(i) > 0)),
    [sales],
  )

  // ── Выгрузка и печать: все операции со скидкой, что видны здесь ──
  const qtyText = (r) => [r.qty > 0 ? `${r.qty} ${t('уп')}` : '', r.pieces > 0 ? `${r.pieces} ${t('шт')}` : ''].filter(Boolean).join(' + ')
  const kop = (x) => Math.round(x * 100) / 100
  const exCols = [
    { header: t('Дата и время'), key: 'date', width: 18 },
    { header: t('Товар'), key: 'name', width: 32 },
    { header: t('Кол-во'), key: 'qty', width: 14 },
    { header: t('Без скидки'), key: 'gross', width: 14, money: true },
    { header: t('Скидка'), key: 'discount', width: 13, money: true },
    { header: t('Итог'), key: 'net', width: 14, money: true },
    { header: t('Оплата'), key: 'pay', width: 13 },
  ]
  const exRows = rows.map((r) => ({
    date: fmtDateTime(r.date), name: r.name, qty: qtyText(r),
    gross: kop(r.gross), discount: kop(r.discount), net: kop(r.net), pay: t(PAYMENTS[r.payment]?.label || 'Наличные'),
  }))
  const exItogi = {
    date: t('Итого'),
    gross: kop(rows.reduce((s, r) => s + r.gross, 0)), discount: kop(totalDiscount), net: kop(rows.reduce((s, r) => s + r.net, 0)),
  }
  const exPodzag = `${t('Продажи за последние')} ${SALES_CACHE_DAYS} ${t('дней')} · ${t('Операций со скидкой')}: ${rows.length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('История скидок'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('История скидок')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout title={t('История скидок')} subtitle={`${rows.length} ${t('операций со скидкой')}`} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('История скидок')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      <div className="cards" data-tour="disc.cards" style={{ gridTemplateColumns: 'repeat(2,1fr)', marginBottom: 16 }}>
        <Metric label={t('Всего скидок выдано')} value={money(totalDiscount)} Icon={LuTag} sub={t('по товарам')} onClick={() => setOkno('tovary')} testid="card-disc-total" />
        <Metric label={t('Операций со скидкой')} value={rows.length} Icon={LuPercent} sub={`${chekiSoSkidkoy.length} ${t('чек(ов)')}`} onClick={() => setOkno('cheki')} testid="card-disc-count" />
      </div>
      {okno === 'cheki' && (
        <ChekiOkno title={t('Чеки со скидкой')} sales={chekiSoSkidkoy} returns={[]} onClose={() => setOkno(null)} empty={t('Скидок ещё не было')} />
      )}
      {okno === 'tovary' && (
        <Modal wide title={t('Скидки по товарам')} onClose={() => setOkno(null)}>
          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            <table data-testid="disc-tovary">
              <thead>
                <tr><th>{t('Товар')}</th><th className="num">{t('Операций')}</th><th className="num">{t('Без скидки')}</th><th className="num">{t('Скидка')}</th></tr>
              </thead>
              <tbody>
                {poTovaram.map((x) => (
                  <tr key={x.name}>
                    <td><b>{x.name}</b></td>
                    <td className="num">{x.count}</td>
                    <td className="num">{money(x.gross)}</td>
                    <td className="num" style={{ color: 'var(--danger)' }}>−{money(x.discount)}</td>
                  </tr>
                ))}
                {poTovaram.length === 0 && <tr><td colSpan="4" className="empty">{t('Скидок ещё не было')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="total-row big"><span>{t('Всего скидок выдано')}</span><span style={{ color: 'var(--danger)' }}>−{money(totalDiscount)}</span></div>
          <div className="modal-actions"><button className="btn" onClick={() => setOkno(null)}>{t('Закрыть')}</button></div>
        </Modal>
      )}

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
                  {r.divisible && <div className="tag-cat">{r.unitsText || `${r.units} ${t('шт')}`}</div>}
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
