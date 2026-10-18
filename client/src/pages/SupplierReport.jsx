import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuScale, LuReceipt, LuWallet, LuTruck, LuUndo2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { PeriodPicker, presetPeriod, periodRange, periodText, useDeepPeriod } from '../components/Period'
import { useCollection, money } from '../db/store'
import { getUser } from '../db/auth'
import { useT } from '../lib/i18n'
import { skachatXlsx } from '../lib/excel'
import { sverkaPostavshikov } from '../lib/otchety'

// ── Отчёт поставщиков ──
// Сверка за период по каждому поставщику: долг на начало, сколько закуплено,
// сколько возвращено ему товаром, сколько оплачено (сразу при приходе и погашениями
// долга) и долг на конец.
// Такую таблицу показывают поставщику при сверке. Подробности — что именно купили
// и какими оплатами гасили — в разделе «Поставщики».
//
// Долг на начало и конец считается от нынешнего долга назад, поэтому приходы и
// оплаты нужны от начала периода до сегодняшнего дня (см. lib/otchety.js).

export default function SupplierReport() {
  const t = useT()
  const suppliers = useCollection('suppliers')
  const arrivalsCached = useCollection('arrivals')
  const paymentsCached = useCollection('supplierPayments')
  const returnsCached = useCollection('supplierReturns')
  const [period, setPeriod] = useState(() => presetPeriod('month'))
  const range = useMemo(() => periodRange(period), [period])
  const { deep, loading } = useDeepPeriod(['arrivals', 'supplierPayments', 'supplierReturns'], range, { untilNow: true })

  const r = useMemo(
    () =>
      sverkaPostavshikov({
        suppliers,
        arrivals: deep.arrivals || arrivalsCached,
        supplierPayments: deep.supplierPayments || paymentsCached,
        supplierReturns: deep.supplierReturns || returnsCached,
        from: range.from,
        to: range.to,
      }),
    [suppliers, deep, arrivalsCached, paymentsCached, returnsCached, range],
  )

  const podzag = periodText(period, t)
  const nameOf = (x) => x.name || (x.supplierId ? '—' : t('Без поставщика'))
  const cols = [
    { header: t('Поставщик'), key: 'name', width: 34 },
    { header: t('Долг на начало'), key: 'nachalo', width: 16, money: true },
    { header: t('Закуплено'), key: 'zakupleno', width: 16, money: true },
    { header: t('Возвращено'), key: 'vozvrat', width: 16, money: true },
    { header: t('Оплачено'), key: 'oplacheno', width: 16, money: true },
    { header: t('Долг на конец'), key: 'konec', width: 16, money: true },
  ]
  const rows = r.rows.map((x) => ({ name: nameOf(x), nachalo: x.nachalo, zakupleno: x.zakupleno, vozvrat: x.vozvrat, oplacheno: x.oplacheno, konec: x.konec }))
  const itogi = { name: t('Итого'), ...r.itogo }
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Отчёт поставщиков'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Отчёт поставщиков')}`, podzag, cols, rows, itogi })

  return (
    <Layout title={t('Отчёт поставщиков')} subtitle={podzag} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('Отчёт поставщиков')} podzag={podzag} cols={cols} rows={rows} itogi={itogi} />

      <PeriodPicker value={period} onChange={setPeriod} tour="spr.period" />

      <div className="cards" data-tour="spr.cards" style={{ margin: '14px 0 16px' }}>
        <Metric label={t('Долг на начало')} value={money(r.itogo.nachalo)} Icon={LuScale} />
        <Metric label={t('Закуплено')} value={money(r.itogo.zakupleno)} Icon={LuReceipt} />
        {r.itogo.vozvrat > 0 && <Metric label={t('Возвращено')} value={money(r.itogo.vozvrat)} Icon={LuUndo2} />}
        <Metric label={t('Оплачено')} value={money(r.itogo.oplacheno)} Icon={LuWallet} good />
        <Metric label={t('Долг на конец')} value={money(r.itogo.konec)} Icon={LuTruck} bad={r.itogo.konec > 0} />
      </div>

      <div className="panel" data-tour="spr.table" style={{ padding: 0 }}>
        <div className="table-cards-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th>{t('Поставщик')}</th><th className="num">{t('Долг на начало')}</th><th className="num">{t('Закуплено')}</th><th className="num">{t('Возвращено')}</th>
                <th className="num">{t('Оплачено')}</th><th className="num">{t('Долг на конец')}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.supplierId || 'none'}>
                  <td className="cell-main"><b>{nameOf(x)}</b></td>
                  <td className="num" data-label={t('Долг на начало')}>{money(x.nachalo)}</td>
                  <td className="num" data-label={t('Закуплено')}>{money(x.zakupleno)}</td>
                  <td className="num" data-label={t('Возвращено')}>{x.vozvrat > 0 ? '−' + money(x.vozvrat) : money(0)}</td>
                  <td className="num" data-label={t('Оплачено')} style={{ color: x.oplacheno > 0 ? 'var(--green)' : undefined }}>{money(x.oplacheno)}</td>
                  <td className="num" data-label={t('Долг на конец')}><b style={{ color: x.konec > 0 ? 'var(--danger)' : undefined }}>{money(x.konec)}</b></td>
                </tr>
              ))}
              {r.rows.length === 0 && <tr><td colSpan="6" className="empty">{loading ? t('Загружаем…') : t('За этот период движений по поставщикам нет')}</td></tr>}
            </tbody>
            {r.rows.length > 0 && (
              <tfoot>
                <tr className="zak-total">
                  <td>{t('Итого')}</td>
                  <td className="num">{money(r.itogo.nachalo)}</td>
                  <td className="num">{money(r.itogo.zakupleno)}</td>
                  <td className="num">{r.itogo.vozvrat > 0 ? '−' + money(r.itogo.vozvrat) : money(0)}</td>
                  <td className="num">{money(r.itogo.oplacheno)}</td>
                  <td className="num">{money(r.itogo.konec)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      <div className="tag-cat" style={{ marginTop: 12 }}>
        {t('Долг на конец = долг на начало + закуплено − возвращено − оплачено. Что именно купили, вернули и какими оплатами гасили — в разделе')}{' '}
        <Link to="/suppliers" className="linklike">{t('Поставщики')}</Link>.
      </div>
    </Layout>
  )
}

function Metric({ label, value, Icon, good, bad }) {
  const style = good
    ? { background: 'var(--green-soft, var(--accent-soft))', color: 'var(--green)' }
    : bad
      ? { background: 'var(--danger-soft)', color: 'var(--danger)' }
      : undefined
  return (
    <div className="metric">
      <div className="metric-head">
        <div className="label">{label}</div>
        <div className="ic-box" style={style}><Icon size={19} /></div>
      </div>
      <div className="value">{value}</div>
    </div>
  )
}
