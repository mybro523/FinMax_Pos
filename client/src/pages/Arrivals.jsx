import { useState, useMemo, useEffect } from 'react'
import { LuTrash2, LuPencil, LuList, LuPackagePlus, LuWallet, LuChartColumn, LuSearch, LuRotateCcw, LuUndo2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import { isVesovoy, uppOf, gramsOfKg, kgText, edinica } from '../lib/units'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { presetPeriod, periodRange, periodText, useDeepPeriod } from '../components/Period'
import { useCollection, money } from '../db/store'
import { getArrival, updateArrival, deleteArrival } from '../db/ops'
import { useCan, getUser } from '../db/auth'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import NumberInput from '../components/NumberInput'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { qtyText as unitsText } from '../lib/otchety'
import { pct } from '../lib/prihod'
import { useDolgiPostavshikam } from './SupplierDebts'
import { usePrihod, setPrihod } from './prihod/store'
import SupplierColumn from './prihod/SupplierColumn'
import { SupplierPick } from './prihod/SupplierPick'
import NewArrival from './prihod/NewArrival'
import Balance, { useBalance } from './prihod/Balance'
import Reports, { useReports } from './prihod/Reports'
import ReturnTab, { REFUNDS } from './prihod/ReturnTab'

// ── Приход товара ──
// Один экран, как в привычных программах приёмки: слева — поставщики, сверху — период
// и вкладки «Поступления · Новое поступление · Платежи и баланс · Отчёты». Выбрали
// поставщика слева — все вкладки показывают только его, и новый приход оформляется
// на него. «Все поступления» — снять выбор.
//
// Новое поступление — вкладка, а не всплывающее окно: набранная накладная живёт в
// prihod/store.js и не пропадает от переключения вкладок или случайного Esc.

const num = (v) => Number(v) || 0
const inRange = (d, r) => {
  const ts = new Date(d).getTime()
  return Number.isFinite(ts) && (!r.from || ts >= r.from.getTime()) && (!r.to || ts < r.to.getTime())
}
// Свежее из кэша устройства поверх догруженного с сервера: только что записанная
// оплата или приход видны сразу, даже когда смотрят давний период
function mergeById(deep, cached) {
  if (!deep) return cached
  const byId = new Map(deep.map((x) => [x.id, x]))
  for (const x of cached) byId.set(x.id, x)
  return [...byId.values()]
}
const byDateDesc = (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()

// Строка уже оформленного прихода: сколько пришло — «2 уп + 5 шт», «12,35 кг».
// Товар удалили из справочника — штук в упаковке берём из строки (её присылает
// подробный приход), а нет и их — по граммам видно, что товар был весовым
function productOf(i, products) {
  const p = products.find((x) => x.id === i.productId)
  if (p) return p
  const upp = num(i.unitsPerPack) || (num(i.pieces) > 0 ? 1000 : 1)
  return { unitsPerPack: upp, unit: upp === 1000 ? 'кг' : 'уп' }
}
const itemUnits = (i, p) => num(i.qty) * uppOf(p) + num(i.pieces)
const itemSum = (i, p) => num(i.cost) * (itemUnits(i, p) / uppOf(p))
// Цена поставщика до скидки: закупочная хранится уже со скидкой
const itemBase = (i) => (num(i.discount) > 0 && num(i.discount) < 100 ? Math.round((num(i.cost) / (1 - num(i.discount) / 100)) * 100) / 100 : num(i.cost))

export default function Arrivals() {
  const t = useT()
  const can = useCan()
  const toast = useToast()
  const dialog = useDialog()
  const st = usePrihod()
  const products = useCollection('products')
  const suppliers = useCollection('suppliers')
  const arrivalsCached = useCollection('arrivals')
  const paymentsCached = useCollection('supplierPayments')
  const returnsCached = useCollection('supplierReturns')
  const supView = can('suppliers.view')

  // ── Период сверху — общий для всех вкладок ──
  const period = st.period || presetPeriod('month')
  const setPeriod = (p) => setPrihod({ period: p })
  const range = useMemo(() => periodRange(period), [period])
  const periodLabel = periodText(period, t)
  // От начала периода до сегодня: сверке нужны и оплаты после периода
  const { deep, loading } = useDeepPeriod(supView ? ['arrivals', 'supplierPayments', 'supplierReturns'] : ['arrivals', 'supplierReturns'], range, { untilNow: true })
  const arrivals = useMemo(() => mergeById(deep.arrivals, arrivalsCached).sort(byDateDesc), [deep.arrivals, arrivalsCached])
  const payments = useMemo(() => (supView ? mergeById(deep.supplierPayments, paymentsCached) : []), [supView, deep.supplierPayments, paymentsCached])
  const supReturns = useMemo(() => mergeById(deep.supplierReturns, returnsCached), [deep.supplierReturns, returnsCached])

  // ── Поставщик слева ──
  const sup = suppliers.find((s) => s.id === st.supplierId) || null
  // Поставщика удалили, пока он был выбран, — снимаем выбор
  useEffect(() => {
    if (st.supplierId && suppliers.length && !sup) setPrihod({ supplierId: '' })
  }, [st.supplierId, suppliers.length, sup])

  // ── Вкладки ──
  const TABS = [
    { key: 'journal', label: t('Поступления'), Icon: LuList, tour: 'arr.tab-journal', ok: true },
    { key: 'new', label: t('Новое поступление'), Icon: LuPackagePlus, tour: 'arr.new', ok: can('arrivals.create'), badge: st.lines.length },
    { key: 'return', label: t('Возврат'), Icon: LuUndo2, tour: 'arr.tab-return', ok: true, badge: st.ret.lines.length },
    { key: 'balance', label: t('Платежи и баланс'), Icon: LuWallet, tour: 'arr.tab-balance', ok: supView },
    { key: 'reports', label: t('Отчёты'), Icon: LuChartColumn, tour: 'arr.tab-reports', ok: supView },
  ].filter((x) => x.ok)
  const tab = TABS.some((x) => x.key === st.tab) ? st.tab : 'journal'

  // ── Поступления: журнал ──
  const [jq, setJq] = useState('')
  const journal = useMemo(() => {
    const needle = jq.trim().toLowerCase()
    return arrivals.filter(
      (a) =>
        inRange(a.date, range) &&
        (!st.supplierId || a.supplierId === st.supplierId) &&
        (!needle || `${a.supplier || ''} ${(a.items || []).map((i) => i.name).join(' ')}`.toLowerCase().includes(needle)),
    )
  }, [arrivals, range, st.supplierId, jq])
  const pg = usePagination(journal, 15, `${jq}|${st.supplierId}|${period.from}|${period.to}`)
  const journalSum = useMemo(() => journal.reduce((s, a) => s + num(a.total), 0), [journal])

  const [view, setView] = useState(null)
  const [edit, setEdit] = useState(null) // приход, загруженный для правки
  const [busy, setBusy] = useState(false)

  // Для правки нужен не тот приход, что лежит в списке, а подробный: с ним
  // приходит, сколько от каждой строки уже продано и ниже чего нельзя опускать
  async function openEdit(a) {
    setBusy(true)
    try {
      setEdit(await getArrival(a.id))
      setView(null)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function askDelete(a) {
    const позиций = a.items?.length || 0
    const ok = await dialog.confirm({
      title: t('Удалить приход?'),
      message:
        `${t('Поставщик')}: ${a.supplier} · ${money(a.total)} · ${позиций} ${t('поз.')}\n` +
        t('Со склада снимется всё, что от этого прихода ещё не продано, а закупочная цена товаров пересчитается по оставшимся партиям. Проданное останется в чеках как есть.'),
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    setView(null)
    try {
      await deleteArrival(a.id)
      toast(t('Приход удалён, склад пересчитан'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const sposob = (a) =>
    a.payMethod === 'cash' ? t('Из кассы')
      : a.payMethod === 'own' ? t('Наличными')
        : a.payMethod === 'card' ? t('Картой')
          : num(a.debt) > 0 ? `${t('В долг')} (${money(a.debt)})` : '—'

  // ── Платежи и баланс, отчёты ──
  const bal = useBalance({ supplier: sup, arrivals, payments, returns: supReturns, range })
  const dolgi = useDolgiPostavshikam({ enabled: supView })
  const rep = useReports({ suppliers, arrivals, payments, returns: supReturns, products, range, supplierId: st.supplierId, t })

  // ── Excel и печать — того, что на открытой вкладке ──
  const shop = getUser()?.pharmacy?.name || ''
  const podzag = `${periodLabel}${sup ? ' · ' + sup.name : ''}`
  let sheet = null
  if (tab === 'journal') {
    const cols = [
      { header: t('Дата'), key: 'date', width: 18 },
      { header: t('Поставщик'), key: 'supplier', width: 30 },
      { header: t('Оплата'), key: 'pay', width: 20 },
      { header: t('Позиций'), key: 'poz', width: 10, num: true },
      { header: t('Сумма'), key: 'total', width: 14, money: true },
    ]
    const rows = journal.map((a) => ({ date: fmtDateTime(a.date), supplier: a.supplier || '—', pay: sposob(a), poz: (a.items || []).length, total: num(a.total) }))
    const itogi = { date: t('Итого'), poz: journal.reduce((s, a) => s + (a.items || []).length, 0), total: journalSum }
    sheet = { zagolovok: t('Приход товара'), podzag: `${podzag} · ${t('Найдено записей')}: ${journal.length}`, cols, rows, itogi }
  } else if (tab === 'return') {
    const list = supReturns.filter((r) => inRange(r.date, range) && (!st.supplierId || r.supplierId === st.supplierId)).sort(byDateDesc)
    const cols = [
      { header: t('Дата'), key: 'date', width: 18 },
      { header: t('Поставщик'), key: 'supplier', width: 28 },
      { header: t('Позиций'), key: 'poz', width: 10, num: true },
      { header: t('Сумма'), key: 'total', width: 14, money: true },
      { header: t('Как вернули деньги'), key: 'refund', width: 18 },
      { header: t('Причина'), key: 'note', width: 26 },
      { header: t('Принял'), key: 'user', width: 14 },
    ]
    const rows = list.map((r) => ({ date: fmtDateTime(r.date), supplier: r.supplier || '—', poz: (r.items || []).length, total: num(r.total), refund: t(REFUNDS[r.refund]?.[0] || '—'), note: r.note || '', user: r.user?.name || '' }))
    sheet = { zagolovok: t('Возвраты поставщикам'), podzag: `${podzag} · ${t('Найдено записей')}: ${list.length}`, cols, rows, itogi: { date: t('Итого'), total: Math.round(list.reduce((s, r) => s + num(r.total), 0) * 100) / 100 } }
  } else if (tab === 'balance' && sup && bal) {
    const cols = [
      { header: t('Дата'), key: 'date', width: 18 },
      { header: t('Позиций'), key: 'poz', width: 10, num: true },
      { header: t('Сумма'), key: 'total', width: 14, money: true },
      { header: t('В долг'), key: 'debt', width: 14, money: true },
      { header: t('Принял'), key: 'user', width: 16 },
    ]
    const rows = bal.arrivals.map((a) => ({ date: fmtDateTime(a.date), poz: (a.items || []).length, total: num(a.total), debt: num(a.debt), user: a.user?.name || '' }))
    const payCols = [
      { header: t('Дата'), key: 'date', width: 18 },
      { header: t('Сумма'), key: 'amount', width: 14, money: true },
      { header: t('Из кассы'), key: 'cash', width: 10 },
      { header: t('Примечание'), key: 'note', width: 30 },
      { header: t('Кто'), key: 'user', width: 16 },
    ]
    const payRows = bal.payments.map((p) => ({ date: fmtDateTime(p.date), amount: num(p.amount), cash: p.fromCash ? t('да') : '', note: p.note || '', user: p.user?.name || '' }))
    sheet = {
      zagolovok: `${t('Платежи и баланс')} · ${sup.name}`,
      podzag: `${periodLabel} · ${t('Долг сейчас')}: ${money(sup.debt)} · ${t('Закуплено')}: ${money(bal.zakupleno)} · ${t('Оплачено')}: ${money(bal.oplacheno)}`,
      cols,
      rows,
      itogi: { date: t('Итого'), total: Math.round(bal.zakupleno * 100) / 100 },
      listy: [{ zagolovok: t('Оплаты'), list: t('Оплаты'), cols: payCols, rows: payRows }],
    }
  } else if (tab === 'balance' && !sup) {
    sheet = { zagolovok: t('Долги поставщикам'), podzag: `${t('Всего должны')}: ${money(dolgi.s.total)}`, cols: dolgi.exCols, rows: dolgi.exRows, itogi: dolgi.exItogi }
  } else if (tab === 'reports') {
    const nameOf = (x) => x.name || (x.supplierId ? '—' : t('Без поставщика'))
    const svCols = [
      { header: t('Поставщик'), key: 'name', width: 34 },
      { header: t('Долг на начало'), key: 'nachalo', width: 16, money: true },
      { header: t('Закуплено'), key: 'zakupleno', width: 16, money: true },
      { header: t('Возвращено'), key: 'vozvrat', width: 16, money: true },
      { header: t('Оплачено'), key: 'oplacheno', width: 16, money: true },
      { header: t('Долг на конец'), key: 'konec', width: 16, money: true },
    ]
    const svRows = rep.sverka.rows.map((x) => ({ name: nameOf(x), nachalo: x.nachalo, zakupleno: x.zakupleno, vozvrat: x.vozvrat, oplacheno: x.oplacheno, konec: x.konec }))
    const zCols = [
      { header: t('Дата'), key: 'date', width: 17 },
      { header: t('Поставщик'), key: 'supplier', width: 24 },
      { header: t('Товар'), key: 'name', width: 36 },
      { header: t('Кол-во'), key: 'qty', width: 14 },
      { header: t('Цена'), key: 'price', width: 12, money: true },
      { header: t('Сумма'), key: 'sum', width: 13, money: true },
      { header: t('Оплачено'), key: 'paid', width: 13, money: true },
      { header: t('Долг'), key: 'debt', width: 13, money: true },
      { header: t('Принял'), key: 'user', width: 14 },
    ]
    const supName = (r) => r.supplier || (r.supplierId ? suppliers.find((s) => s.id === r.supplierId)?.name : '') || t('без поставщика')
    const zRows = rep.zak.rows.map((r) => ({ date: fmtDateTime(r.date), supplier: supName(r), name: r.name, qty: r.qty, price: r.kind !== 'pay' ? r.price : '', sum: r.kind !== 'pay' ? r.sum : '', paid: r.paid, debt: r.debt, user: r.user || '' }))
    sheet = {
      zagolovok: t('Закупки и оплаты поставщикам'),
      podzag,
      cols: zCols,
      rows: zRows,
      itogi: { date: t('Итого'), sum: rep.zak.itogo.sum, paid: rep.zak.itogo.paid, debt: rep.zak.itogo.debt },
      svodka: { zagolovok: t('Сверка с поставщиками'), list: t('Сверка'), cols: svCols, rows: svRows, itogi: { name: t('Итого'), ...rep.sverka.itogo } },
    }
  }
  const exportExcel = () =>
    skachatXlsx({
      fayl: sheet.zagolovok,
      zagolovok: `${shop} — ${sheet.zagolovok}`,
      podzag: sheet.podzag,
      cols: sheet.cols,
      rows: sheet.rows,
      itogi: sheet.itogi,
      ...(sheet.svodka ? { svodka: { ...sheet.svodka, zagolovok: `${shop} — ${sheet.svodka.zagolovok}`, podzag: sheet.podzag } } : {}),
      ...(sheet.listy ? { listy: sheet.listy } : {}),
    })

  const subtitle = sup ? `${t('Поставщик')}: ${sup.name}` : `${t('Все поставщики')} · ${periodLabel}`

  return (
    <Layout title={t('Приход товара')} subtitle={subtitle} actions={sheet ? <ExportPechat onExcel={exportExcel} /> : null}>
      {sheet && (
        <PrintSheet
          zagolovok={sheet.zagolovok}
          podzag={sheet.podzag}
          cols={sheet.cols}
          rows={sheet.rows}
          itogi={sheet.itogi}
          svodka={sheet.svodka}
          listy={sheet.listy}
        />
      )}
      <div className="prh">
        <SupplierColumn
          suppliers={suppliers}
          value={st.supplierId}
          onChange={(id) => setPrihod({ supplierId: id })}
          showDebt={supView}
          canAdd={can('suppliers.edit')}
          dialog={dialog}
          toast={toast}
        />

        <div className="prh-main">
          <PeriodBar value={period} onChange={setPeriod} loading={loading} />

          <div className="prh-tabs" role="tablist" data-tour="arr.tabs">
            {TABS.map(({ key, label, Icon, tour, badge }) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} data-tour={tour} onClick={() => setPrihod({ tab: key })}>
                <Icon size={16} /> {label}
                {badge ? <span className="prh-badge">{badge}</span> : null}
              </button>
            ))}
          </div>

          {tab === 'journal' && (
            <div className="panel prh-journal" style={{ padding: 0 }}>
              <div className="prh-panel-head">
                <label className="prh-sheet-search">
                  <LuSearch size={15} aria-hidden="true" />
                  <input value={jq} onChange={(e) => setJq(e.target.value)} placeholder={t('Поиск по поставщику или товару…')} aria-label={t('Поиск по поставщику или товару…')} />
                </label>
                <span className="tag-cat">
                  {loading ? t('Загружаем историю за выбранный период…') : `${t('Найдено записей')}: ${journal.length} · ${money(journalSum)}`}
                </span>
              </div>
              <div className="table-cards-wrap">
                <table className="table-cards">
                  <thead>
                    <tr><th>{t('Дата')}</th><th>{t('Поставщик')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th>{t('Принял')}</th><th></th></tr>
                  </thead>
                  <tbody>
                    {pg.slice.map((a) => (
                      <tr key={a.id}>
                        <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.date)}</td>
                        <td className="cell-main">
                          <b>{a.supplier}</b>
                          {num(a.debt) > 0 && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('в долг')} {money(a.debt)}</div>}
                          {a.payMethod === 'cash' && <div className="tag-cat">{t('оплачен из кассы')}</div>}
                          {a.payMethod === 'own' && <div className="tag-cat">{t('наличными')}</div>}
                          {a.payMethod === 'card' && <div className="tag-cat">{t('картой')}</div>}
                        </td>
                        <td className="num" data-label={t('Позиций')}>{(a.items || []).length}</td>
                        <td className="num" data-label={t('Сумма')}><b>{money(a.total)}</b></td>
                        <td data-label={t('Принял')} className="tag-cat">{a.user?.name || '—'}</td>
                        <td className="num"><button type="button" className="btn ghost sm" data-tour="arr.details" onClick={() => setView(a)}>{t('Подробно')}</button></td>
                      </tr>
                    ))}
                    {!journal.length && !loading && (
                      <tr><td colSpan="6" className="empty">{arrivals.length ? t('За выбранный период ничего не найдено') : t('Приходов пока нет. Откройте вкладку «Новое поступление».')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <Pagination {...pg} />
            </div>
          )}

          {tab === 'new' && <NewArrival products={products} suppliers={suppliers} onSaved={() => setPrihod({ tab: 'journal' })} />}

          {tab === 'return' && (
            <ReturnTab products={products} suppliers={suppliers} sup={sup} arrivals={arrivals} returns={supReturns} range={range} loading={loading} periodLabel={periodLabel} />
          )}

          {tab === 'balance' && (
            <Balance supplier={sup} bal={bal} dolgi={dolgi} periodLabel={periodLabel} loading={loading} onSelect={(id) => setPrihod({ supplierId: id })} onOpenArrival={setView} />
          )}

          {tab === 'reports' && <Reports rep={rep} suppliers={suppliers} loading={loading} periodLabel={sup ? `${periodLabel} · ${sup.name}` : periodLabel} />}
        </div>
      </div>

      {view && (
        <ArrivalDetails
          a={view}
          products={products}
          sposob={sposob}
          busy={busy}
          canEdit={can('arrivals.edit')}
          onClose={() => setView(null)}
          onEdit={() => openEdit(view)}
          onDelete={() => askDelete(view)}
        />
      )}

      {edit && (
        <EditArrival
          arrival={edit}
          suppliers={suppliers}
          products={products}
          canAddSupplier={can('suppliers.edit')}
          onClose={() => setEdit(null)}
          onSave={async (data) => {
            try {
              await updateArrival(edit.id, data)
              toast(t('Приход изменён, склад пересчитан'))
              setEdit(null)
            } catch (e) {
              toast(e.message, 'err')
            }
          }}
        />
      )}
    </Layout>
  )
}

// ── Период сверху: «с … по …», «Показать», «Сброс» и быстрые кнопки ──
// Даты применяются по «Показать»: пока человек набирает год, списки не должны прыгать
const PRESETS = [
  ['today', 'Сегодня'],
  ['week', 'Неделя'],
  ['month', 'Месяц'],
  ['all', 'Всё время'],
]
function PeriodBar({ value, onChange, loading }) {
  const t = useT()
  const [from, setFrom] = useState(value?.from || '')
  const [to, setTo] = useState(value?.to || '')
  useEffect(() => {
    setFrom(value?.from || '')
    setTo(value?.to || '')
  }, [value?.from, value?.to])
  const dirty = from !== (value?.from || '') || to !== (value?.to || '')
  return (
    <div className="prh-period" data-tour="arr.filter">
      <span className="prh-period-label">{t('Период')}</span>
      <label className="prh-period-f">
        <span>{t('с')}</span>
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="prh-period-f">
        <span>{t('по')}</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </label>
      <button type="button" className={'btn sm' + (dirty ? '' : ' ghost')} onClick={() => onChange({ kind: 'custom', from, to })}>
        <span className="ic"><LuSearch size={14} /></span> {t('Показать')}
      </button>
      <button type="button" className="btn ghost sm" onClick={() => onChange(presetPeriod('month'))} title={t('Вернуть текущий месяц')}>
        <span className="ic"><LuRotateCcw size={14} /></span> {t('Сброс')}
      </button>
      <div className="chips prh-period-chips">
        {PRESETS.map(([k, label]) => (
          <button key={k} type="button" className={'chip ' + (value?.kind === k ? 'active' : '')} onClick={() => onChange(presetPeriod(k))}>
            {t(label)}
          </button>
        ))}
      </div>
      {loading && <span className="tag-cat">{t('загружаем…')}</span>}
    </div>
  )
}

// ── Приход · подробно ──
function ArrivalDetails({ a, products, sposob, busy, canEdit, onClose, onEdit, onDelete }) {
  const t = useT()
  const items = a.items || []
  const withDisc = items.some((i) => num(i.discount) > 0)
  return (
    <Modal title={t('Приход · детали')} onClose={onClose} wide={withDisc}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>
        {a.supplier} · {fmtDateTime(a.date)} · {t('Оплата')}: {sposob(a)}
        {a.user?.name ? ` · ${t('Принял')}: ${a.user.name}` : ''}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('Товар')}</th>
              <th className="num">{t('Кол-во')}</th>
              {withDisc && <th className="num">{t('Цена')}</th>}
              {withDisc && <th className="num">{t('Скидка')}</th>}
              <th className="num">{withDisc ? t('Цена со скидкой') : t('Закуп.')}</th>
              <th className="num">{t('Сумма')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => {
              const p = productOf(i, products)
              return (
                <tr key={i.id || n}>
                  <td>{i.name}</td>
                  <td className="num">{unitsText(itemUnits(i, p), p, t)}</td>
                  {withDisc && <td className="num">{money(itemBase(i))}</td>}
                  {withDisc && <td className="num">{num(i.discount) > 0 ? pct(i.discount) : '—'}</td>}
                  <td className="num">{money(i.cost)}</td>
                  <td className="num">{money(itemSum(i, p))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="total-row big"><span>{t('Итого')}</span><span>{money(a.total)}</span></div>
      {num(a.debt) > 0 && (
        <>
          <div className="total-row"><span>{t('Оплачено при получении')}</span><span>{money(num(a.total) - num(a.debt))}</span></div>
          <div className="total-row"><span>{t('В долг поставщику')}</span><span style={{ color: 'var(--danger)' }}>{money(a.debt)}</span></div>
        </>
      )}

      {/* Кассиру этих кнопок не видно, и запрос от него сервер тоже отклонит */}
      {canEdit && (
        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={onDelete} disabled={busy}>
            <span className="ic"><LuTrash2 size={16} /></span> {t('Удалить')}
          </button>
          <button className="btn" onClick={onEdit} disabled={busy}>
            <span className="ic"><LuPencil size={16} /></span> {t('Изменить')}
          </button>
        </div>
      )}
    </Modal>
  )
}

// ── Правка прихода ──
//
// Тут важно не то, что можно поменять, а то, чего поменять уже нельзя. Приход
// не запись в журнале: он положил товар на полку, и часть этого товара мог
// забрать покупатель. Ниже проданного количество не опустить — упаковок нет
// физически. Поэтому у каждой строки написано, сколько от неё уже ушло.
//
// Количество — как при оформлении: «упаковки + штуки» у делимой упаковки,
// килограммы с дробью у весового. Единицу берём из справочника товаров: сервер
// присылает строку без неё, и весовая строка раньше правилась целыми килограммами —
// граммы при сохранении терялись.
function EditArrival({ arrival, suppliers, products, canAddSupplier, onClose, onSave }) {
  const t = useT()
  const dialog = useDialog()
  const toast = useToast()
  const [supplierId, setSupplierId] = useState(arrival.supplierId || '')
  const [credit, setCredit] = useState(num(arrival.debt) > 0)
  const [paid, setPaid] = useState(String(Math.max(0, num(arrival.total) - num(arrival.debt))))
  const [lines, setLines] = useState(() =>
    arrival.items.map((i) => {
      const p = products.find((x) => x.id === i.productId)
      const upp = p ? uppOf(p) : Math.max(1, num(i.unitsPerPack))
      const ves = p ? isVesovoy(p) : upp === 1000
      const div = !ves && upp > 1
      return {
        id: i.id,
        name: i.name,
        unit: p ? edinica(p) : ves ? 'кг' : 'уп',
        upp,
        ves,
        div,
        // Весовая строка правится в килограммах одним числом; делимая — упаковки и штуки
        qty: ves ? String((num(i.qty) * 1000 + num(i.pieces)) / 1000) : String(num(i.qty)),
        pieces: div ? String(num(i.pieces) || '') : '',
        cost: String(i.cost),
        discount: num(i.discount),
        expiryDate: i.expiryDate || '',
        soldUnits: i.soldUnits || 0,
        minQty: i.minQty || 0,
        exists: i.exists !== false,
      }
    }),
  )
  const [saving, setSaving] = useState(false)

  const set = (n, k, v) => setLines(lines.map((l, i) => (i === n ? { ...l, [k]: v } : l)))
  const unitsOf = (l) => (l.ves ? gramsOfKg(l.qty) : Math.max(0, Math.trunc(num(l.qty))) * l.upp + (l.div ? Math.max(0, Math.trunc(num(l.pieces))) : 0))
  const total = lines.reduce((s, l) => s + num(l.cost) * (unitsOf(l) / (l.ves ? 1000 : l.upp)), 0)
  const soldText = (l) => (l.ves ? `${kgText(l.soldUnits)} ${t(l.unit)}` : `${l.soldUnits} ${t('шт')}`)

  // Проданное вернуть нельзя — эту строку сервер отвергнет, поэтому
  // не даём даже нажать и объясняем почему. Товар двумя строками сверяет сервер
  const плохо = lines.find((l) => l.minQty > 0 && unitsOf(l) < l.soldUnits)
  const пусто = !lines.some((l) => unitsOf(l) > 0)

  async function save() {
    setSaving(true)
    try {
      const sup = suppliers.find((s) => s.id === supplierId)
      if (credit && !sup) {
        toast(t('Для прихода в долг выберите поставщика'), 'err')
        return
      }
      await onSave({
        supplier: sup?.name || '',
        supplierId: sup?.id || '',
        debt: credit ? Math.max(0, total - Math.max(0, num(paid))) : 0,
        items: lines.map((l) => {
          const units = unitsOf(l)
          const upp = l.ves ? 1000 : l.upp
          return {
            id: l.id,
            qty: Math.floor(units / upp),
            ...(l.ves || l.div ? { pieces: units % upp } : {}),
            cost: num(l.cost),
            ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}),
          }
        }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('Изменить приход')} onClose={onClose} wide>
      <div className="note info" style={{ marginBottom: 14 }}>
        {t('Склад и закупочная цена пересчитаются сразу. Прибыль по уже пробитым чекам не изменится: каждый чек хранит себестоимость на момент продажи, иначе вчерашние отчёты менялись бы задним числом.')}
      </div>

      <SupplierPick suppliers={suppliers} value={supplierId} onChange={setSupplierId} dialog={dialog} toast={toast} canAdd={canAddSupplier} />

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('Товар')}</th>
              <th className="num">{t('Кол-во')}</th>
              <th className="num">{t('Закуп.')}</th>
              <th>{t('Срок годности')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, n) => (
              <tr key={l.id}>
                <td>
                  <b>{l.name}</b>
                  {l.discount > 0 && <div className="tag-cat">{t('скидка поставщика')} {pct(l.discount)}</div>}
                  {l.soldUnits > 0 && <div className="tag-cat">{t('уже продано')}: {soldText(l)}{l.minQty > 0 ? ` · ${t('меньше нельзя')}` : ''}</div>}
                  {!l.exists && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('товар удалён из базы')}</div>}
                  {unitsOf(l) === 0 && <div className="tag-cat" style={{ color: 'var(--warn)' }}>{t('строка будет убрана')}</div>}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <span className="prh-edit-qty">
                    <NumberInput integer={!l.ves} className="disc-input" value={l.qty} onChange={(e) => set(n, 'qty', e.target.value)} aria-label={t('Количество')} />
                    <span className="tag-cat">{t(l.unit)}</span>
                    {l.div && (
                      <>
                        <NumberInput integer className="disc-input" value={l.pieces} placeholder="0" onChange={(e) => set(n, 'pieces', e.target.value)} aria-label={t('Штук сверх упаковок')} />
                        <span className="tag-cat">{t('шт')}</span>
                      </>
                    )}
                  </span>
                </td>
                <td className="num" style={{ width: 104 }}>
                  <NumberInput className="disc-input" value={l.cost} onChange={(e) => set(n, 'cost', e.target.value)} />
                </td>
                <td style={{ width: 168 }}>
                  <input type="date" style={{ width: '100%' }} value={l.expiryDate} onChange={(e) => set(n, 'expiryDate', e.target.value)} title={t('Пусто — срок останется прежним')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="total-row big"><span>{t('Итого')}</span><span>{money(total)}</span></div>
      <CreditBlock credit={credit} setCredit={setCredit} paid={paid} setPaid={setPaid} total={total} />

      {плохо && (
        <div className="note err" style={{ marginTop: 10 }}>
          «{плохо.name}»: {t('уже продано')} {soldText(плохо)} — {t('меньше проданного поставить нельзя')}
        </div>
      )}
      {пусто && (
        <div className="note err" style={{ marginTop: 10 }}>
          {t('В приходе не осталось ни одной позиции. Чтобы убрать его целиком, удалите приход.')}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={save} disabled={saving || !!плохо || пусто}>
          {saving ? t('Сохранение…') : t('Сохранить')}
        </button>
      </div>
    </Modal>
  )
}

// Правка прихода: оплачено ли сразу. Не всё — остаток становится долгом перед поставщиком
function CreditBlock({ credit, setCredit, paid, setPaid, total }) {
  const t = useT()
  const debt = Math.max(0, total - Math.max(0, num(paid)))
  return (
    <div style={{ margin: '10px 0 4px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} style={{ width: 17, height: 17 }} />
        {t('В долг (оплачено не полностью)')}
      </label>
      {credit && (
        <div className="prh-debt-row">
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>{t('Оплачено сейчас (сомони)')}</label>
            <NumberInput value={paid} placeholder="0" onChange={(e) => setPaid(e.target.value)} />
          </div>
          <div className="total-row" style={{ flex: 1, margin: '0 0 6px' }}>
            <span>{t('В долг поставщику')}</span>
            <span style={{ color: 'var(--danger)' }}>{money(debt)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
