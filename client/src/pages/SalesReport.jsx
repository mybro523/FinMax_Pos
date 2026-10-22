import { useMemo, useState } from 'react'
import { LuWallet, LuTrendingUp, LuBoxes, LuReceipt } from 'react-icons/lu'
import Layout from '../components/Layout'
import { PAYMENTS } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { PeriodPicker, presetPeriod, periodRange, periodText, useDeepPeriod } from '../components/Period'
import { useCollection, money } from '../db/store'
import { getUser } from '../db/auth'
import { fmtDateTime, chekNomer } from '../lib/time'
import { useT } from '../lib/i18n'
import { skachatXlsx } from '../lib/excel'
import { prodazhiPoTovaram, vseProdazhi } from '../lib/otchety'
import { poiskZapros, tovarPodhodit } from '../lib/poisk'

// ── Отчёт продажи ──
// Две вкладки. «По товарам» — сколько продано каждого товара, выручка после скидок,
// себестоимость и прибыль: видно, что кормит магазин, а что лежит. «Все продажи» —
// каждая позиция каждого чека: когда, кто продал, что, сколько, скидка и оплата.
// Кассир выбирается в обеих вкладках: «По товарам» тогда считает только его продажи
// (что продаёт этот сотрудник). Карточки сверху — всегда по всем. Поиск — по названию
// и по штрихкоду, в том числе сканером.
// Расчёты — в lib/otchety.js; Excel и печать берут те же строки, что на экране.

const VKLADKA = 'apteka_otchet_prodazh_vkladka'
const payLabel = (p, t) => t(PAYMENTS[p]?.label || 'Наличные')

export default function SalesReport() {
  const t = useT()
  const salesCached = useCollection('sales')
  const products = useCollection('products')
  const [tab, setTabRaw] = useState(() => {
    try {
      return localStorage.getItem(VKLADKA) === 'all' ? 'all' : 'products'
    } catch {
      return 'products'
    }
  })
  const setTab = (v) => {
    setTabRaw(v)
    try {
      localStorage.setItem(VKLADKA, v)
    } catch {
      /* приватный режим */
    }
  }
  const [period, setPeriod] = useState(() => presetPeriod('month'))
  const range = useMemo(() => periodRange(period), [period])
  const { deep, loading } = useDeepPeriod(['sales'], range)
  const sales = deep.sales || salesCached

  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [cashier, setCashier] = useState('')
  const [pay, setPay] = useState('')

  const poTov = useMemo(() => prodazhiPoTovaram({ sales, products, from: range.from, to: range.to, t }), [sales, products, range, t])
  const vse = useMemo(() => vseProdazhi({ sales, products, from: range.from, to: range.to, t }), [sales, products, range, t])
  // «По товарам» у одного кассира — та же сводка, только по его чекам
  const poTovKassira = useMemo(
    () => (cashier ? prodazhiPoTovaram({ sales: sales.filter((s) => (s.user?.name || '') === cashier), products, from: range.from, to: range.to, t }) : poTov),
    [cashier, sales, products, range, t, poTov],
  )

  const z = useMemo(() => poiskZapros(q), [q])
  const tovRows = useMemo(
    () => poTovKassira.rows.filter((r) => tovarPodhodit(z, r.name, r.barcode) && (!cat || r.category === cat)),
    [poTovKassira.rows, z, cat],
  )
  const vseRows = useMemo(
    () =>
      vse.rows.filter(
        (r) =>
          tovarPodhodit(z, r.name, r.barcode) &&
          (!cashier || r.cashier === cashier) &&
          (!pay || r.payment === pay),
      ),
    [vse.rows, z, cashier, pay],
  )
  const reset = `${tab}|${q.trim()}|${cat}|${cashier}|${pay}|${period.from}|${period.to}`
  const pgT = usePagination(tovRows, 20, reset)
  const pgV = usePagination(vseRows, 20, reset)

  const categories = useMemo(() => [...new Set(poTov.rows.map((r) => r.category).filter(Boolean))].sort(), [poTov.rows])
  const cashiers = useMemo(() => [...new Set(vse.rows.map((r) => r.cashier).filter(Boolean))].sort(), [vse.rows])

  const sum = (rows, k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100
  const tovItogo = { revenue: sum(tovRows, 'revenue'), cost: sum(tovRows, 'cost'), profit: sum(tovRows, 'profit') }
  const vseItogo = { sum: sum(vseRows, 'sum'), discount: sum(vseRows, 'discount') }

  // ── Excel и печать: активная вкладка, с учётом фильтров ──
  // Выбран кассир — он виден и в подзаголовке листа: иначе цифры выглядели бы общими
  const podzag = periodText(period, t) + (cashier ? ` · ${t('Кассир')}: ${cashier}` : '')
  const ex =
    tab === 'products'
      ? {
          fayl: t('Продажи по товарам'),
          title: t('Продажи по товарам'),
          cols: [
            { header: t('Товар'), key: 'name', width: 40 },
            { header: t('Категория'), key: 'category', width: 18 },
            { header: t('Продано'), key: 'qty', width: 16 },
            { header: t('Выручка'), key: 'revenue', width: 14, money: true },
            { header: t('Себестоимость'), key: 'cost', width: 14, money: true },
            { header: t('Прибыль'), key: 'profit', width: 14, money: true },
            { header: t('Маржа, %'), key: 'margin', width: 10, num: true },
          ],
          rows: tovRows.map((r) => ({ name: r.name, category: r.category ? t(r.category) : '—', qty: r.qty, revenue: r.revenue, cost: r.cost, profit: r.profit, margin: r.margin })),
          itogi: { name: t('Итого'), revenue: tovItogo.revenue, cost: tovItogo.cost, profit: tovItogo.profit },
        }
      : {
          fayl: t('Все продажи'),
          title: t('Все продажи'),
          cols: [
            { header: t('Дата'), key: 'date', width: 17 },
            { header: t('Чек'), key: 'chek', width: 13 },
            { header: t('Кассир'), key: 'cashier', width: 14 },
            { header: t('Товар'), key: 'name', width: 36 },
            { header: t('Кол-во'), key: 'qty', width: 14 },
            { header: t('Цена'), key: 'price', width: 12, money: true },
            { header: t('Скидка'), key: 'discount', width: 11, money: true },
            { header: t('Сумма'), key: 'sum', width: 13, money: true },
            { header: t('Оплата'), key: 'pay', width: 14 },
          ],
          rows: vseRows.map((r) => ({
            date: fmtDateTime(r.date), chek: chekNomer(r.date), cashier: r.cashier || '—', name: r.name, qty: r.qty,
            price: r.price, discount: r.discount, sum: r.sum, pay: payLabel(r.payment, t) + (r.payVia ? ` · ${r.payVia}` : ''),
          })),
          itogi: { date: t('Итого'), discount: vseItogo.discount, sum: vseItogo.sum },
        }
  const exportExcel = () =>
    skachatXlsx({ fayl: ex.fayl, zagolovok: `${getUser()?.pharmacy?.name || ''} — ${ex.title}`, podzag, cols: ex.cols, rows: ex.rows, itogi: ex.itogi })

  return (
    <Layout title={t('Отчёт продажи')} subtitle={podzag} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={ex.title} podzag={podzag} cols={ex.cols} rows={ex.rows} itogi={ex.itogi} />

      <div className="chips" data-tour="sr.tabs" style={{ marginBottom: 14 }}>
        <button className={'chip ' + (tab === 'products' ? 'active' : '')} data-tour="sr.tab-products" onClick={() => setTab('products')}>{t('По товарам')}</button>
        <button className={'chip ' + (tab === 'all' ? 'active' : '')} data-tour="sr.tab-all" onClick={() => setTab('all')}>{t('Все продажи')}</button>
      </div>

      <PeriodPicker value={period} onChange={setPeriod} tour="sr.period" />

      <div className="cards" data-tour="sr.cards" style={{ margin: '14px 0 16px' }}>
        <Metric label={t('Выручка')} value={money(poTov.itogo.revenue)} Icon={LuWallet} />
        <Metric label={t('Себестоимость')} value={money(poTov.itogo.cost)} Icon={LuBoxes} />
        <Metric label={t('Прибыль')} value={money(poTov.itogo.profit)} Icon={LuTrendingUp} good />
        <Metric label={t('Чеков')} value={vse.itogo.cheki} sub={`${poTov.itogo.positions} ${t('наименований')}`} Icon={LuReceipt} />
      </div>

      <div className="panel" data-tour="sr.table" style={{ padding: 0 }}>
        <div style={{ padding: '16px 16px 0' }}>
          <div className="toolbar">
            <input className="search" data-tour="sr.search" placeholder={t('Поиск по товару или штрихкоду…')} value={q} onChange={(e) => setQ(e.target.value)} />
            {tab === 'products' && (
              <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('Категория')} style={{ maxWidth: 220 }}>
                <option value="">{t('Все категории')}</option>
                {categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}
              </select>
            )}
            <select value={cashier} onChange={(e) => setCashier(e.target.value)} aria-label={t('Кассир')} data-tour="sr.cashier" style={{ maxWidth: 200 }}>
              <option value="">{t('Все кассиры')}</option>
              {cashiers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {tab === 'all' && (
              <select value={pay} onChange={(e) => setPay(e.target.value)} aria-label={t('Оплата')} style={{ maxWidth: 200 }}>
                <option value="">{t('Любая оплата')}</option>
                {Object.entries(PAYMENTS).map(([k, m]) => <option key={k} value={k}>{t(m.label)}</option>)}
              </select>
            )}
            {loading && <span className="tag-cat">{t('загружаем…')}</span>}
          </div>
        </div>

        <div className="table-cards-wrap">
          {tab === 'products' ? (
            <table className="table-cards">
              <thead>
                <tr>
                  <th>{t('Товар')}</th><th className="num">{t('Продано')}</th><th className="num">{t('Выручка')}</th>
                  <th className="num">{t('Себестоимость')}</th><th className="num">{t('Прибыль')}</th><th className="num">{t('Маржа')}</th>
                </tr>
              </thead>
              <tbody>
                {pgT.slice.map((r) => (
                  <tr key={r.key}>
                    <td className="cell-main"><b>{r.name}</b>{r.category ? <div className="tag-cat">{t(r.category)}</div> : null}</td>
                    <td className="num" data-label={t('Продано')}>{r.qty}</td>
                    <td className="num" data-label={t('Выручка')}><b>{money(r.revenue)}</b></td>
                    <td className="num" data-label={t('Себестоимость')}>{money(r.cost)}</td>
                    <td className="num" data-label={t('Прибыль')} style={{ color: r.profit < 0 ? 'var(--danger)' : 'var(--green)' }}>{money(r.profit)}</td>
                    <td className="num" data-label={t('Маржа')}>{String(r.margin).replace('.', ',')}%</td>
                  </tr>
                ))}
                {tovRows.length === 0 && <tr><td colSpan="6" className="empty">{loading ? t('Загружаем…') : t('За этот период продаж нет')}</td></tr>}
              </tbody>
              {tovRows.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="2">{t('Итого')}</td>
                    <td className="num">{money(tovItogo.revenue)}</td>
                    <td className="num">{money(tovItogo.cost)}</td>
                    <td className="num">{money(tovItogo.profit)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table className="table-cards">
              <thead>
                <tr>
                  <th>{t('Дата')}</th><th>{t('Чек')}</th><th>{t('Кассир')}</th><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th>
                  <th className="num">{t('Цена')}</th><th className="num">{t('Скидка')}</th><th className="num">{t('Сумма')}</th><th>{t('Оплата')}</th>
                </tr>
              </thead>
              <tbody>
                {pgV.slice.map((r, n) => (
                  <tr key={r.saleId + ':' + n}>
                    <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                    <td data-label={t('Чек')} className="tag-cat">{chekNomer(r.date)}</td>
                    <td data-label={t('Кассир')}>{r.cashier || '—'}</td>
                    <td className="cell-main"><b>{r.name}</b></td>
                    <td className="num" data-label={t('Кол-во')}>{r.qty}</td>
                    <td className="num" data-label={t('Цена')}>{money(r.price)}</td>
                    <td className="num" data-label={t('Скидка')}>{r.discount > 0 ? '−' + money(r.discount) : '—'}</td>
                    <td className="num" data-label={t('Сумма')}><b>{money(r.sum)}</b></td>
                    <td data-label={t('Оплата')}>{payLabel(r.payment, t)}{r.payVia ? <span className="tag-cat"> · {r.payVia}</span> : null}</td>
                  </tr>
                ))}
                {vseRows.length === 0 && <tr><td colSpan="9" className="empty">{loading ? t('Загружаем…') : t('За этот период продаж нет')}</td></tr>}
              </tbody>
              {vseRows.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="6">{t('Итого')}</td>
                    <td className="num">{vseItogo.discount > 0 ? '−' + money(vseItogo.discount) : '—'}</td>
                    <td className="num">{money(vseItogo.sum)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
        {tab === 'products' ? <Pagination {...pgT} /> : <Pagination {...pgV} />}
      </div>
    </Layout>
  )
}

function Metric({ label, value, sub, Icon, good }) {
  return (
    <div className="metric">
      <div className="metric-head">
        <div className="label">{label}</div>
        <div className="ic-box" style={good ? { background: 'var(--green-soft, var(--accent-soft))', color: 'var(--green)' } : undefined}><Icon size={19} /></div>
      </div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}
