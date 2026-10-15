import { useRef, useState, useMemo, useEffect } from 'react'
import { LuWallet, LuTrendingUp, LuBoxes, LuReceipt, LuUndo2, LuHandCoins, LuPiggyBank, LuTruck, LuUsers, LuCalculator } from 'react-icons/lu'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { Modal, PayBadge } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money, loadRange, needsServerFor } from '../db/store'
import { stockUnits, stockValue, stockCost, lineUnits } from '../lib/units'
import { startOfDay, startOfDaysAgo, fmtShort, fmtDateTime } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'
import { periodFinance } from '../lib/finance'
import { opuFinance } from '../lib/opu'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { useCan, getUser } from '../db/auth'

const PERIODS = [
  { key: 'today', label: 'Сегодня', days: 0 },
  { key: '7', label: '7 дней', days: 6 },
  { key: '30', label: '30 дней', days: 29 },
  { key: 'all', label: 'Всё время', days: 100000 },
]

// Формулы упаковок и штук — общие, из lib/units
const valueOf = stockValue
const costValOf = stockCost

function MC({ label, v, color }) {
  return <div className="mini-card"><div className="m-label">{label}</div><div className="m-value sm" style={color ? { color } : undefined}>{v}</div></div>
}

function SalesTable({ list }) {
  if (!list.length) return <div className="empty">{tr('Продаж нет')}</div>
  return (
    <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
      <table>
        <thead><tr><th>{tr('Время')}</th><th>{tr('Товары')}</th><th className="num">{tr('Сумма')}</th><th className="num">{tr('Прибыль')}</th><th>{tr('Оплата')}</th></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>{fmtShort(s.date)}</td>
              <td>{s.items.map((i) => i.name).join(', ').slice(0, 40)}</td>
              <td className="num"><b>{money(s.total)}</b></td>
              <td className="num" style={{ color: 'var(--green)' }}>{money(s.profit || 0)}</td>
              <td><PayBadge type={s.payment} via={s.payVia} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Отчёт ОПУ (прибыли и убытки) ──
// Карточки и таблица «Показатель — Сумма» — вид, к которому привыкли владельцы
// магазинов. Формулы в lib/opu.js; кнопка «Печать» выводит лист с шапкой магазина.
// ── Модалка карточки ОПУ: из чего сложилось число и как оно считается ──
function OpuModal({ kind, d, onClose }) {
  const t = useT()
  const fin = d.fin
  const VIDY = {
    vyruchka: {
      title: 'Выручка',
      rows: [
        ['Продано на', fin.revenueGross],
        ...(fin.refunds > 0 ? [['Возвращено покупателям', -fin.refunds]] : []),
      ],
      total: ['Выручка', d.prodazha],
      text: 'Все продажи за период минус деньги, возвращённые покупателям.',
    },
    sebest: {
      title: 'Себестоимость',
      rows: [],
      total: ['Себестоимость', d.sebestoimost],
      text: 'Во сколько магазину обошёлся проданный за период товар — по закупочной цене.',
    },
    valovoy: {
      title: 'Валовой доход',
      rows: [
        ['Наценка с продаж', fin.profitGross],
        ...(fin.refunds > 0 ? [['Возвращено покупателям', -fin.refunds]] : []),
        ...(fin.returnedCost > 0 ? [['Товар вернулся на склад (закупочная)', fin.returnedCost]] : []),
        ...(fin.writeOffCost > 0 ? [['Списано (просрочка, бой, недостача)', -fin.writeOffCost]] : []),
      ],
      total: ['Валовой доход', d.valovoy],
      text: 'Заработок на товаре: продажи минус их закупочная цена, минус потери на возвратах и списаниях.',
    },
    postavshik: {
      title: 'Поставщик',
      rows: [
        ['Оплаты поставщикам (долги и «из кассы»)', d.paidZapisi],
        ['Оплачено сразу при приходе', d.paidPriPrihode],
      ],
      total: ['Отдано поставщикам', d.supplierPaid],
      text: 'Все деньги, отданные поставщикам за период: оплаты из раздела «Поставщики» и приходы, оплаченные сразу. Долг перед поставщиком попадает сюда только после оплаты.',
    },
    zarplata: {
      title: 'Зарплата',
      rows: [],
      total: ['Зарплата', d.zarplata],
      text: 'Расходы по статье «Зарплата» за период. Записывайте зарплату в разделе «Расходы» со статьёй «Зарплата» — и она попадёт в эту строку.',
    },
    drugie: {
      title: 'Другие расходы',
      rows: [
        ['Налоги', d.nalogi],
        ['Расход магазина', d.magazin],
        ['Прочие статьи', d.other],
      ],
      total: ['Другие расходы', d.allExpenses - d.zarplata],
      text: 'Все расходы, кроме зарплаты. Налоги и расходы магазина записывайте в одноимённые статьи раздела «Расходы» — остальное попадает в «Прочие».',
    },
    vse: {
      title: 'Все расходы',
      rows: [
        ['Зарплата', d.zarplata],
        ['Налоги', d.nalogi],
        ['Расход магазина', d.magazin],
        ['Прочие статьи', d.other],
      ],
      total: ['Все расходы', d.allExpenses],
      text: 'Всё, что магазин потратил за период помимо закупки товара, — по статьям раздела «Расходы».',
    },
    chistiy: {
      title: 'Чистый доход',
      rows: [
        ['Валовой доход', d.valovoy],
        ['Все расходы', -d.allExpenses],
        ['Отдано поставщикам', -d.supplierPaid],
      ],
      total: ['Чистый доход', d.chistiy],
      text: 'Сколько денег на самом деле осталось: валовой доход минус все расходы и минус деньги, отданные поставщикам за товар.',
    },
    kassa: {
      title: 'Касса',
      rows: [
        ['Продажи наличными', d.cashSales],
        ['Погашения долгов клиентов', d.debtPaid],
        ...(d.refundsCash > 0 ? [['Возвраты наличными', -d.refundsCash]] : []),
      ],
      total: ['Касса', d.kassa],
      text: 'Наличные, пришедшие за период: продажи налом и погашения долгов клиентов минус возвраты, выданные наличными.',
    },
  }
  const v = VIDY[kind]
  if (!v) return null
  return (
    <Modal title={t(v.title)} onClose={onClose}>
      {v.rows.map(([label, val]) => (
        <div className="total-row" key={label}>
          <span>{t(label)}</span>
          <span style={val < 0 ? { color: 'var(--danger)' } : undefined}>{val < 0 ? '−' + money(-val) : money(val)}</span>
        </div>
      ))}
      <div className="total-row big">
        <span>{t(v.total[0])}</span>
        <span style={{ color: v.total[1] < 0 ? 'var(--danger)' : undefined }}>{money(v.total[1])}</span>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>{t(v.text)}</p>
    </Modal>
  )
}

const OPU_KEYS = ['sales', 'returns', 'writeoffs', 'expenses', 'payments', 'supplierPayments', 'arrivals']
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function Opu({ onExcelRef }) {
  const t = useT()
  const sales = useCollection('sales')
  const returns = useCollection('returns')
  const writeOffs = useCollection('writeoffs')
  const expenses = useCollection('expenses')
  const debtPayments = useCollection('payments')
  const supplierPayments = useCollection('supplierPayments')
  const arrivals = useCollection('arrivals')

  // По умолчанию — текущий месяц: даты сразу видны в полях, цифры считаются сразу.
  // «Показать» применяет то, что введено, — цифры не прыгают при каждом нажатии клавиши
  const now = new Date()
  const [fromDate, setFromDate] = useState(dstr(new Date(now.getFullYear(), now.getMonth(), 1)))
  const [toDate, setToDate] = useState(dstr(now))
  const [applied, setApplied] = useState({ from: dstr(new Date(now.getFullYear(), now.getMonth(), 1)), to: dstr(now) })
  const range = useMemo(
    () => ({
      from: applied.from ? startOfDay(applied.from) : new Date(0),
      to: applied.to ? new Date(startOfDay(applied.to).getTime() + 86400000) : null,
    }),
    [applied],
  )

  // Период глубже кэша устройства — догружаем всю историю отрезка с сервера,
  // ровно как во вкладке «Подробно»
  const needsServer = OPU_KEYS.some((k) => needsServerFor(k, range.from))
  const [deep, setDeep] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  useEffect(() => {
    if (!needsServer) {
      setDeep(null)
      return
    }
    let cancelled = false
    setLoadingOlder(true)
    Promise.all(OPU_KEYS.map((k) => (needsServerFor(k, range.from) ? loadRange(k, range.from, range.to) : Promise.resolve(null))))
      .then((arr) => { if (!cancelled) setDeep(Object.fromEntries(OPU_KEYS.map((k, i) => [k, arr[i]]))) })
      .catch(() => { if (!cancelled) setDeep(null) })
      .finally(() => { if (!cancelled) setLoadingOlder(false) })
    return () => { cancelled = true }
  }, [needsServer, range.from, range.to])

  const d = useMemo(
    () =>
      opuFinance({
        sales: (deep && deep.sales) || sales,
        returns: (deep && deep.returns) || returns,
        writeOffs: (deep && deep.writeoffs) || writeOffs,
        expenses: (deep && deep.expenses) || expenses,
        debtPayments: (deep && deep.payments) || debtPayments,
        supplierPayments: (deep && deep.supplierPayments) || supplierPayments,
        arrivals: (deep && deep.arrivals) || arrivals,
        from: range.from,
        to: range.to,
      }),
    [deep, sales, returns, writeOffs, expenses, debtPayments, supplierPayments, arrivals, range],
  )

  const apt = getUser()?.pharmacy?.name || ''
  const [modal, setModal] = useState(null) // карточка, чью разбивку смотрим
  const rows = [
    [t('Продажа'), d.prodazha],
    [t('Себестоимость'), d.sebestoimost],
    [t('Валовой доход'), d.valovoy, 'b'],
    [t('Оплата поставщику'), d.supplierPaid],
    [t('Расход магазина'), d.magazin],
    [t('Налоги'), d.nalogi],
    [t('Зарплата'), d.zarplata],
    [t('Другие расходы'), d.other],
    [t('Все расходы'), d.allExpenses, 'b'],
    [t('Чистый доход'), d.chistiy, 'big'],
  ]

  // Экспорт таблицы ОПУ в Excel — кнопка живёт в шапке раздела
  const opuExcel = () =>
    skachatXlsx({
      fayl: t('Отчёт ОПУ'),
      zagolovok: `${apt} — ${t('Отчёт ОПУ')}`,
      podzag: `${applied.from} — ${applied.to}`,
      cols: [
        { header: t('Показатель'), key: 'p', width: 32 },
        { header: t('Сумма'), key: 's', width: 18, money: true },
      ],
      rows: rows.map(([label, v]) => ({ p: label, s: Number(v) || 0 })),
    })
  if (onExcelRef) onExcelRef.current = opuExcel

  return (
    <div className="printable opu">
      {/* Шапка видна только на бумаге: чей магазин и за какой период отчёт */}
      <div className="opu-print-head">
        <b>{apt}</b>
        <div>{t('Отчёт ОПУ')} · {applied.from} — {applied.to}</div>
      </div>

      <div className="row no-print" data-tour="opu.period" style={{ maxWidth: 620, marginBottom: 14, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
          <label>{t('С даты')}</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
          <label>{t('По дату')}</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <button className="btn" data-tour="opu.show" onClick={() => setApplied({ from: fromDate, to: toDate })}>{t('Показать')}</button>
      </div>

      {loadingOlder && <div className="note info no-print" style={{ marginBottom: 12 }}>{t('Загружаем историю за выбранный период…')}</div>}

      <div className="cards six opu-cards" data-tour="opu.cards">
        <Metric label={t('Выручка')} value={money(d.prodazha)} Icon={LuWallet} tint="accent" sub={t('подробнее')} onClick={() => setModal('vyruchka')} />
        <Metric label={t('Себестоимость')} value={money(d.sebestoimost)} Icon={LuBoxes} tint="blue" sub={t('подробнее')} onClick={() => setModal('sebest')} />
        <Metric label={t('Валовой доход')} value={money(d.valovoy)} Icon={LuTrendingUp} tint="green" sub={t('подробнее')} onClick={() => setModal('valovoy')} />
        <Metric label={t('Поставщик')} value={money(d.supplierPaid)} Icon={LuTruck} tint="blue" sub={t('подробнее')} onClick={() => setModal('postavshik')} />
        <Metric label={t('Зарплата')} value={money(d.zarplata)} Icon={LuUsers} tint="accent" sub={t('подробнее')} onClick={() => setModal('zarplata')} />
        <Metric label={t('Другие расходы')} value={money(d.allExpenses - d.zarplata)} Icon={LuHandCoins} tint="danger" sub={t('подробнее')} onClick={() => setModal('drugie')} />
        <Metric label={t('Все расходы')} value={money(d.allExpenses)} Icon={LuReceipt} tint="danger" sub={t('подробнее')} onClick={() => setModal('vse')} />
        <Metric label={t('Чистый доход')} value={money(d.chistiy)} Icon={LuPiggyBank} tint={d.chistiy < 0 ? 'danger' : 'green'} sub={t('подробнее')} onClick={() => setModal('chistiy')} />
        <Metric label={t('Касса')} value={money(d.kassa)} Icon={LuCalculator} tint="accent" sub={t('подробнее')} onClick={() => setModal('kassa')} />
      </div>

      <div className="panel mt opu-panel" data-tour="opu.table" style={{ padding: 0 }}>
        <table className="opu-table">
          <thead><tr><th>{t('Показатель')}</th><th className="num">{t('Сумма')}</th></tr></thead>
          <tbody>
            {rows.map(([label, v, kind]) => (
              <tr key={label} className={kind ? 'opu-' + kind : ''}>
                <td>{label}</td>
                <td className="num">
                  {kind === 'big'
                    ? <b style={{ color: v < 0 ? 'var(--danger)' : 'var(--green)' }}>{money(v)}</b>
                    : kind ? <b>{money(v)}</b> : money(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tag-cat no-print" style={{ marginTop: 10, lineHeight: 1.6, maxWidth: 720 }}>
        {t('Чистый доход — кассовый: валовой доход минус все расходы и деньги, отданные поставщикам за товар.')}{' '}
        {t('Чтобы зарплата и налоги попали в свои строки, записывайте их в разделе «Расходы» в статьи «Зарплата», «Налоги» и «Расход магазина».')}
      </p>

      {modal && <OpuModal kind={modal} d={d} onClose={() => setModal(null)} />}
    </div>
  )
}

export default function Reports() {
  const can = useCan()
  const sales = useCollection('sales')
  const products = useCollection('products')
  // Возвраты и списания — это деньги и товар, ушедшие обратно. Без них
  // выручка и прибыль в отчёте завышены
  const returns = useCollection('returns')
  const writeOffs = useCollection('writeoffs')
  // Расходы магазина — аренда, зарплата и прочее. Без них видна только прибыль на
  // товаре, а не то, что магазин заработал на самом деле
  const expenses = useCollection('expenses')
  const t = useT()
  // Вкладки: «Отчёт ОПУ» открывается первой, подробная аналитика — рядом.
  // Выбор запоминается: кто живёт в ОПУ, тот в нём и остаётся
  // Экспорт ОПУ собирает сам компонент вкладки — шапка зовёт его через реф
  const opuExcelRef = useRef(() => {})
  const [tab, setTabRaw] = useState(() => {
    try { return localStorage.getItem('apteka_otchet_vkladka') || 'opu' } catch { return 'opu' }
  })
  const setTab = (v) => {
    setTabRaw(v)
    try { localStorage.setItem('apteka_otchet_vkladka', v) } catch { /* без хранилища просто не запомнится */ }
  }
  const [period, setPeriod] = useState('7')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [modal, setModal] = useState(null)
  const close = () => setModal(null)

  // Границы выбранного периода
  const range = useMemo(() => {
    if (period === 'custom') {
      return {
        from: fromDate ? startOfDay(fromDate) : new Date(0),
        to: toDate ? new Date(startOfDay(toDate).getTime() + 86400000) : null,
      }
    }
    const p = PERIODS.find((x) => x.key === period)
    return { from: startOfDaysAgo(p.days), to: null }
  }, [period, fromDate, toDate])

  // Устройство держит в памяти только недавние записи: продажи за два месяца,
  // журналы за полгода. Если период уходит глубже — догружаем отрезок с сервера,
  // иначе отчёт был бы неполным, причём молча.
  //
  // Догружать надо и журналы, а не только продажи: без возвратов и списаний за тот
  // же период выручка и прибыль оказались бы завышены — ровно та ошибка, ради
  // которой их сюда и добавляли.
  const needSales = needsServerFor('sales', range.from)
  const needJournals = needsServerFor('returns', range.from)
  const needsServer = needSales || needJournals
  const [deep, setDeep] = useState(null) // отрезок, загруженный с сервера
  const [loadingOlder, setLoadingOlder] = useState(false)

  useEffect(() => {
    if (!needsServer) {
      setDeep(null)
      return
    }
    let cancelled = false
    setLoadingOlder(true)
    const some = (need, key) => (need ? loadRange(key, range.from, range.to) : Promise.resolve(null))
    Promise.all([
      some(needSales, 'sales'),
      some(needJournals, 'returns'),
      some(needJournals, 'writeoffs'),
      some(needJournals, 'expenses'),
    ])
      .then(([s, r, w, x]) => { if (!cancelled) setDeep({ sales: s, returns: r, writeoffs: w, expenses: x }) })
      .catch(() => { if (!cancelled) setDeep(null) })
      .finally(() => { if (!cancelled) setLoadingOlder(false) })
    return () => { cancelled = true }
  }, [needsServer, needSales, needJournals, range.from, range.to])

  const data = useMemo(
    () =>
      periodFinance({
        sales: (deep && deep.sales) || sales,
        returns: (deep && deep.returns) || returns,
        writeOffs: (deep && deep.writeoffs) || writeOffs,
        expenses: (deep && deep.expenses) || expenses,
        from: range.from,
        to: range.to,
      }),
    [sales, returns, writeOffs, expenses, deep, range],
  )

  // Снимок склада (не зависит от периода)
  const stock = useMemo(() => {
    const value = products.reduce((s, p) => s + valueOf(p), 0)
    const cost = products.reduce((s, p) => s + costValOf(p), 0)
    const low = products.filter((p) => p.stock <= p.minStock).length
    const out = products.filter((p) => stockUnits(p) <= 0).length
    const margin = value > 0 ? Math.round(((value - cost) / value) * 100) : 0
    const catMap = {}
    products.forEach((p) => {
      const k = p.category || 'Прочее'
      catMap[k] = catMap[k] || { cat: k, count: 0, value: 0 }
      catMap[k].count += 1
      catMap[k].value += valueOf(p)
    })
    const categories = Object.values(catMap).sort((a, b) => b.value - a.value)
    return { value, cost, margin, low, out, categories }
  }, [products])

  const pg = usePagination(data.list, 10, period + fromDate + toDate)

  const rangeLabel = period === 'custom'
    ? `${fromDate || '…'} — ${toDate || '…'}`
    : t(PERIODS.find((x) => x.key === period)?.label || '')

  // Excel вместо сжатого CSV: тот же список продаж, но с шапкой и форматами
  const salesCols = [
    { header: 'Дата', key: 'date', width: 18 },
    { header: 'Товары', key: 'items', width: 60 },
    { header: 'Кол-во', key: 'qty', width: 10, num: true },
    { header: 'Сумма', key: 'total', width: 13, money: true },
    { header: 'Прибыль', key: 'profit', width: 13, money: true },
    { header: 'Оплата', key: 'pay', width: 14 },
  ].map((c) => ({ ...c, header: t(c.header) }))
  const salesRows = data.list.map((s) => ({
    date: fmtDateTime(s.date),
    items: s.items.map((i) => `${i.name} ×${i.qty || 0}${i.pieces ? '+' + i.pieces + 'шт' : ''}`).join('; '),
    qty: s.items.reduce((a, i) => a + lineUnits(i), 0),
    total: Number(s.total) || 0,
    profit: Number(s.profit) || 0,
    pay: s.payment === 'transfer' ? t('Перевод') + (s.payVia ? ` (${s.payVia})` : '') : t({ cash: 'Наличные', card: 'Карта', debt: 'Долг' }[s.payment] || '—'),
  }))
  const salesItogi = { date: t('Итого'), total: data.revenueGross, profit: data.profitGross, qty: '' }
  const detPodzag = `${rangeLabel} · ${t('Выручка')}: ${money(data.revenue)} · ${t('Прибыль')}: ${money(data.profit)} · ${t('Чистая прибыль')}: ${money(data.netProfit)} · ${t('Чеков')}: ${data.count}`
  function exportExcel() {
    return skachatXlsx({
      fayl: t('Отчёты'),
      zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Отчёты')}`,
      podzag: detPodzag,
      cols: salesCols,
      rows: salesRows,
      itogi: salesItogi,
    })
  }


  function renderModal() {
    if (modal === 'revenue' || modal === 'checks') {
      return (
        <Modal wide title={`${t('Продажи')} · ${rangeLabel}`} onClose={close}>
          <div className="mini-cards">
            <MC label={t('Продано на')} v={money(data.revenueGross)} />
            <MC label={t('Возвраты')} v={data.refunds > 0 ? '−' + money(data.refunds) : money(0)} color={data.refunds > 0 ? 'var(--danger)' : undefined} />
            <MC label={t('Выручка')} v={money(data.revenue)} />
            <MC label={t('Чеков')} v={data.count} />
            <MC label={t('Наличные')} v={money(data.byPay.cash)} />
            <MC label={t('Карта')} v={money(data.byPay.card)} />
            <MC label={t('В долг')} v={money(data.byPay.debt)} />
          </div>
          <SalesTable list={data.list} />
        </Modal>
      )
    }
    if (modal === 'expenses') {
      return (
        <Modal title={`${t('Расходы')} · ${rangeLabel}`} onClose={close}>
          {data.expensesByCategory.map((c) => (
            <div className="total-row" key={c.category}>
              <span>{t(c.category)} <span className="tag-cat">· {c.count}</span></span>
              <span style={{ color: 'var(--danger)' }}>−{money(c.amount)}</span>
            </div>
          ))}
          {data.expenseCount === 0 && <div className="empty">{t('За период расходов нет')}</div>}
          <div className="total-row big"><span>{t('Всего расходов')}</span><span style={{ color: 'var(--danger)' }}>{money(data.expenses)}</span></div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
            {t('Расходы вносятся в разделе «Расходы».')} <Link to="/expenses" className="linklike">{t('Открыть раздел')}</Link>
          </p>
        </Modal>
      )
    }
    if (modal === 'profit' || modal === 'cost' || modal === 'net') {
      return (
        <Modal title={`${t('Финансы')} · ${rangeLabel}`} onClose={close}>
          <div className="total-row"><span>{t('Продано на')}</span><span>{money(data.revenueGross)}</span></div>
          <div className="total-row"><span>{t('Себестоимость проданного')}</span><span>−{money(data.cost)}</span></div>
          <div className="total-row"><span>{t('Прибыль с продаж')}</span><span>{money(data.profitGross)}</span></div>
          {data.refunds > 0 && (
            <div className="total-row">
              <span>{t('Возвращено покупателям')} <span className="tag-cat">· {data.refundCount}</span></span>
              <span style={{ color: 'var(--danger)' }}>−{money(data.refunds)}</span>
            </div>
          )}
          {data.returnedCost > 0 && (
            <div className="total-row">
              <span>{t('Товар вернулся на склад (закупочная)')}</span>
              <span style={{ color: 'var(--green)' }}>+{money(data.returnedCost)}</span>
            </div>
          )}
          {data.writeOffCost > 0 && (
            <div className="total-row">
              <span>{t('Списано (просрочка, бой, недостача)')} <span className="tag-cat">· {data.writeOffCount}</span></span>
              <span style={{ color: 'var(--danger)' }}>−{money(data.writeOffCost)}</span>
            </div>
          )}
          <div className="total-row big"><span>{t('Осталось прибыли')}</span><span style={{ color: 'var(--green)' }}>{money(data.profit)}</span></div>
          <div className="total-row"><span>{t('Маржа')}</span><span>{data.margin}%</span></div>
          {/* Чистая прибыль — отдельным итогом: прибыль на товаре минус всё, что магазин
              потратила помимо товара */}
          <div className="total-row">
            <span>{t('Расходы магазина')} <span className="tag-cat">· {data.expenseCount}</span></span>
            <span style={{ color: data.expenses > 0 ? 'var(--danger)' : undefined }}>−{money(data.expenses)}</span>
          </div>
          <div className="total-row big">
            <span>{t('Чистая прибыль')}</span>
            <span style={{ color: data.netProfit < 0 ? 'var(--danger)' : 'var(--green)' }}>{money(data.netProfit)}</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
            {t('За период')} {rangeLabel}: {data.count} {t('чек(ов)')}.{' '}
            {t('Товар, вернувшийся на полку, прибыль не уменьшает — потеряны только деньги за него.')}{' '}
            {t('Чистая прибыль — это прибыль минус расходы магазина: аренда, зарплата и прочее.')}
          </p>
        </Modal>
      )
    }
    return null
  }

  return (
    <Layout title={t('Отчёт ОПУ')} subtitle={t('Продажи, прибыль, выручка и склад')}
      actions={can('reports.export') && <span data-tour="rep.export" style={{ display: 'inline-flex', gap: 8 }}>
        <ExportPechat onExcel={tab === 'opu' ? opuExcelRef.current : exportExcel} />
      </span>}>

      <div className="chips" data-tour="rep.tabs" style={{ marginBottom: 14 }}>
        <button className={'chip ' + (tab === 'opu' ? 'active' : '')} data-tour="rep.tab-opu" onClick={() => setTab('opu')}>{t('Отчёт ОПУ')}</button>
        <button className={'chip ' + (tab === 'detail' ? 'active' : '')} data-tour="rep.tab-detail" onClick={() => setTab('detail')}>{t('Подробно')}</button>
      </div>

      {tab === 'detail' && <PrintSheet zagolovok={t('Отчёты')} podzag={detPodzag} cols={salesCols} rows={salesRows} itogi={salesItogi} />}

      {tab === 'opu' && <Opu onExcelRef={opuExcelRef} />}

      {tab === 'detail' && <>
      <div className="chips" data-tour="rep.period" style={{ marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <button key={p.key} className={'chip ' + (period === p.key ? 'active' : '')} onClick={() => setPeriod(p.key)}>{t(p.label)}</button>
        ))}
      </div>
      <div className="row" data-tour="rep.period" style={{ maxWidth: 440, marginBottom: 16, gap: 10, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>{t('С даты')}</label>
          <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPeriod('custom') }} />
        </div>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>{t('По дату')}</label>
          <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPeriod('custom') }} />
        </div>
      </div>

      {loadingOlder && (
        <div className="note info" style={{ marginBottom: 12 }}>{t('Загружаем историю за выбранный период…')}</div>
      )}

      {/* Ячеек шесть — три в ряд: пять в ряд оставляли бы шестую одну на строке */}
      <div className="cards six">
        <Metric
          tour="rep.revenue"
          label={t('Выручка')}
          value={money(data.revenue)}
          Icon={LuWallet}
          tint="accent"
          sub={data.refunds > 0 ? `${t('возвраты')} −${money(data.refunds)}` : t('подробнее')}
          warn={data.refunds > 0}
          onClick={() => setModal('revenue')}
        />
        <Metric
          tour="rep.profit"
          label={t('Прибыль')}
          value={money(data.profit)}
          Icon={LuTrendingUp}
          tint="green"
          sub={data.writeOffCost > 0 ? `${t('маржа')} ${data.margin}% · ${t('списано')} −${money(data.writeOffCost)}` : `${t('маржа')} ${data.margin}%`}
          warn={data.writeOffCost > 0}
          onClick={() => setModal('profit')}
        />
        <Metric
          tour="rep.expenses"
          label={t('Расходы')}
          value={money(data.expenses)}
          Icon={LuHandCoins}
          tint="danger"
          sub={data.expenseCount > 0 ? `${t('записей')}: ${data.expenseCount}` : t('подробнее')}
          onClick={() => setModal('expenses')}
        />
        <Metric
          tour="rep.net"
          label={t('Чистая прибыль')}
          value={money(data.netProfit)}
          Icon={LuPiggyBank}
          tint={data.netProfit < 0 ? 'danger' : 'green'}
          sub={t('прибыль минус расходы')}
          warn={data.netProfit < 0}
          onClick={() => setModal('net')}
        />
        <Metric tour="rep.cost" label={t('Себестоимость')} value={money(data.cost)} Icon={LuBoxes} tint="blue" sub={t('подробнее')} onClick={() => setModal('cost')} />
        <Metric tour="rep.checks" label={t('Чеков')} value={data.count} Icon={LuReceipt} tint="accent" sub={t('список')} onClick={() => setModal('checks')} />
      </div>

      {data.hasLosses && (
        <div className="panel mt" data-tour="rep.losses">
          <h2><span className="h2-title"><span className="ic"><LuUndo2 size={17} /></span>{t('Возвраты и потери')}</span></h2>
          <div className="mini-cards">
            <MC label={t('Продано на')} v={money(data.revenueGross)} />
            <MC label={t('Возвращено покупателям')} v={money(data.refunds)} color={data.refunds > 0 ? 'var(--danger)' : undefined} />
            <MC label={t('Списано по себестоимости')} v={money(data.writeOffCost)} color={data.writeOffCost > 0 ? 'var(--danger)' : undefined} />
            <MC label={t('Товар вернулся на склад')} v={money(data.returnedCost)} color={data.returnedCost > 0 ? 'var(--green)' : undefined} />
            <MC label={t('Прибыль с продаж')} v={money(data.profitGross)} />
            <MC label={t('Осталось прибыли')} v={money(data.profit)} color="var(--green)" />
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>
            {t('Возвраты уменьшают выручку на возвращённые деньги. Списания — просрочка, бой и недостача — уменьшают прибыль по закупочной цене.')}
          </p>
        </div>
      )}

      <div className="panel mt" data-tour="rep.paystruct">
        <h2>{t('Структура оплат')}</h2>
        {['cash', 'card', 'transfer', 'debt'].map((k) => {
          const pct = data.revenueGross ? Math.round((data.byPay[k] / data.revenueGross) * 100) : 0
          return (
            <div key={k} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5 }}>
                <PayBadge type={k} />
                <span><b>{money(data.byPay[k])}</b> · {pct}%</span>
              </div>
              <div style={{ height: 8, background: 'var(--track)', borderRadius: 6 }}>
                <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', borderRadius: 6 }} />
              </div>
              {/* Переводы — по сервисам: так их сверяют с выпиской каждого банка */}
              {k === 'transfer' && data.transferBy.length > 0 && (
                <div className="tag-cat" data-tour="rep.transfer-by" style={{ marginTop: 5 }}>
                  {data.transferBy.map((x) => `${x.via}: ${money(x.amount)}`).join(' · ')}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Отчёт по складу (текущий снимок) ── */}
      <div className="panel mt" data-tour="rep.stock">
        <h2><span className="h2-title"><span className="ic"><LuBoxes size={17} /></span>{t('Отчёт по складу (на сейчас)')}</span></h2>
        <div className="mini-cards">
          <MC label={t('Стоимость склада')} v={money(stock.value)} />
          <MC label={t('Наименований')} v={products.length} />
          <MC label={t('Заканчивается')} v={stock.low} color={stock.low ? 'var(--warn)' : undefined} />
          <MC label={t('Нет в наличии')} v={stock.out} color={stock.out ? 'var(--danger)' : undefined} />
          <MC label={t('Ср. маржа склада')} v={stock.margin + '%'} />
        </div>
        <h2 style={{ fontSize: 14, margin: '16px 0 8px' }}>{t('Стоимость по категориям')}</h2>
        {stock.categories.slice(0, 8).map((c) => {
          const pct = stock.value ? Math.round((c.value / stock.value) * 100) : 0
          return (
            <div key={c.cat} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span>{c.cat} <span className="tag-cat">· {c.count} {t('поз.')}</span></span>
                <span><b>{money(c.value)}</b> · {pct}%</span>
              </div>
              <div style={{ height: 7, background: 'var(--track)', borderRadius: 6 }}>
                <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', borderRadius: 6 }} />
              </div>
            </div>
          )
        })}
        {stock.categories.length === 0 && <div className="empty">{t('Товаров нет')}</div>}
      </div>

      <div className="panel mt" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>{t('Дата')}</th><th>{t('Товары')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('Прибыль')}</th><th>{t('Оплата')}</th></tr></thead>
          <tbody>
            {pg.slice.map((s) => (
              <tr key={s.id}>
                <td>{fmtShort(s.date)}</td>
                <td>{s.items.map((i) => `${i.name} ×${i.qty || 0}${i.pieces ? '+' + i.pieces + 'шт' : ''}`).join(', ').slice(0, 55)}</td>
                <td className="num"><b>{money(s.total)}</b></td>
                <td className="num" style={{ color: 'var(--green)' }}>{money(s.profit || 0)}</td>
                <td><PayBadge type={s.payment} via={s.payVia} /></td>
              </tr>
            ))}
            {data.list.length === 0 && <tr><td colSpan="5" className="empty">{t('За период продаж нет')}</td></tr>}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

      {modal && renderModal()}
      </>}
    </Layout>
  )
}
