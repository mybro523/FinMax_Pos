import { useMemo, useState } from 'react'
import {
  LuClock, LuWallet, LuBanknote, LuCreditCard, LuTrendingUp,
  LuCircleCheck, LuTriangleAlert, LuCalculator, LuReceipt, LuUsers,
  LuArrowDownToLine, LuArrowUpFromLine, LuTrash2, LuQrCode,
} from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money } from '../db/store'
import { useAuth } from '../db/auth'
import { openShift, closeShift, cashMove, removeCashMove } from '../db/ops'
import { fmtDateTime, fmtShort, fmtTime, dayKey } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'
import { restockedCost, shiftTotals } from '../lib/finance'
import NumberInput from '../components/NumberInput'
import { shiftTicket } from '../lib/ticket'
import { printTicket } from '../lib/print'

export default function Shift() {
  const shifts = useCollection('shifts')
  const sales = useCollection('sales')
  const payments = useCollection('payments')
  const returns = useCollection('returns')
  // Внесения и изъятия наличных — чтобы показать, кто и сколько, по этой смене
  const cashMoves = useCollection('cashMoves')
  const toast = useToast()
  const dialog = useDialog()
  const t = useT()
  const [openCash, setOpenCash] = useState('')
  const [view, setView] = useState(null)

  const user = useAuth()
  const isFounder = user?.role === 'founder'
  const current = shifts.find((s) => !s.closedAt)
  const history = shifts.filter((s) => s.closedAt)
  const pg = usePagination(history, 10)

  // Разбивка сегодняшних продаж по кассирам — для владельца
  const byCashier = useMemo(() => {
    if (!isFounder) return []
    const today = dayKey()
    const map = {}
    sales.filter((s) => s && s.date && dayKey(s.date) === today).forEach((s) => {
      const id = s.userId || 'none'
      map[id] = map[id] || { id, name: s.user?.name || '—', count: 0, total: 0, cash: 0, card: 0, debt: 0 }
      const m = map[id]
      m.count += 1
      m.total += s.total || 0
      if (s.payment === 'cash') m.cash += s.total || 0
      else if (s.payment === 'card') m.card += s.total || 0
      else m.debt += s.total || 0
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [isFounder, sales])

  // Живой подсчёт по текущей смене — по shiftId (а не по времени), как на сервере
  const live = useMemo(() => {
    if (!current) return null
    const ss = sales.filter((s) => s.shiftId === current.id)
    let cash = 0, card = 0, debt = 0, transfer = 0, discount = 0, profit = 0
    // Переводы — ещё и по сервисам: кассир сверяет их с приложением каждого банка
    const transferBy = {}
    ss.forEach((s) => {
      if (s.payment === 'cash') cash += s.total
      else if (s.payment === 'card') card += s.total
      else if (s.payment === 'transfer') {
        transfer += s.total
        const via = s.payVia || '—'
        transferBy[via] = (transferBy[via] || 0) + s.total
      } else debt += s.total
      profit += s.profit || 0
      if (Array.isArray(s.items)) discount += s.items.reduce((a, i) => a + (i.discount || 0), 0)
    })
    // Погашения долгов наличными за смену — тоже деньги в кассе
    const debtPaid = payments
      .filter((p) => p.shiftId === current.id)
      .reduce((sum, p) => sum + (p.amount || 0), 0)
    // Возвраты: наличные ушли из кассы, картой и списанием долга — нет
    const rr = returns.filter((r) => r.shiftId === current.id)
    const refundTotal = rr.reduce((sum, r) => sum + (r.total || 0), 0)
    const refundCash = rr.filter((r) => r.refund === 'cash').reduce((sum, r) => sum + (r.total || 0), 0)
    // Себестоимость товара, вернувшегося на полку: он снова в продаже,
    // поэтому прибыль смены на неё не уменьшается
    const refundCost = rr.reduce((sum, r) => sum + restockedCost(r), 0)
    // Расходы аптеки, оплаченные из этой кассы: сумму ведёт сервер прямо в смене.
    // Самих расходов страница не читает — раздел открыт только владельцу, а сколько
    // денег должно лежать в ящике, обязан видеть и кассир
    const expenseCash = Number(current.expenseCash) || 0
    // Внесено, изъято и оплачено поставщикам из кассы — тоже суммы самой смены
    const cashIn = Number(current.cashIn) || 0
    const cashOut = Number(current.cashOut) || 0
    const supplierCash = Number(current.supplierCash) || 0
    const total = cash + card + debt + transfer
    return {
      cash, card, debt, transfer, transferBy, debtPaid, discount, profit, refundCash, refundTotal, refundCost, expenseCash,
      cashIn, cashOut, supplierCash,
      total,
      netSales: total - refundTotal,
      netProfit: profit - refundTotal + refundCost,
      count: ss.length,
      expectedCash: (current.openingCash || 0) + cash + debtPaid + cashIn - refundCash - expenseCash - supplierCash - cashOut,
    }
  }, [current, sales, payments, returns])

  // Движения наличных этой смены, новые сверху
  const moves = useMemo(() => (current ? cashMoves.filter((m) => m.shiftId === current.id) : []), [cashMoves, current])

  // ── Внести размен или изъять выручку ──
  async function doCash(kind) {
    const r = await dialog.prompt({
      title: kind === 'in' ? t('Внести наличные в кассу') : t('Изъять наличные из кассы'),
      message: kind === 'in'
        ? t('Размен или деньги, положенные в ящик помимо продаж. Сумма прибавится к «Ожидается в кассе».')
        : t('Выручка, забранная из ящика до закрытия смены. Сумма вычтется из «Ожидается в кассе».'),
      fields: [
        { name: 'amount', label: t('Сумма (сомони)'), type: 'number' },
        { name: 'note', label: t('Примечание (необязательно)'), placeholder: kind === 'in' ? t('напр. размен') : t('напр. забрал владелец') },
      ],
      confirmText: kind === 'in' ? t('Внести') : t('Изъять'),
    })
    if (!r) return
    const amount = Number(r.amount)
    if (!(amount > 0)) return toast(t('Укажите сумму'), 'err')
    try {
      await cashMove({ kind, amount, note: r.note })
      toast(kind === 'in' ? t('Наличные внесены') : t('Наличные изъяты'))
    } catch (e) {
      toast(t(e.message), 'err')
    }
  }

  async function undoCash(m) {
    const ok = await dialog.confirm({
      title: t('Отменить операцию?'),
      message: `${m.kind === 'in' ? t('Внесение') : t('Изъятие')} ${money(m.amount)} · ${fmtDateTime(m.date)}`,
      danger: true,
      confirmText: t('Отменить'),
    })
    if (!ok) return
    try {
      await removeCashMove(m.id)
      toast(t('Операция отменена'))
    } catch (e) {
      toast(t(e.message), 'err')
    }
  }

  function doOpen() {
    try {
      // Смена открывается мгновенно, запись уходит в фоне
      const { synced } = openShift(Number(openCash) || 0, user)
      setOpenCash('')
      toast(t('Смена открыта'))
      synced.catch((e) => toast(t('Смена не открыта') + ': ' + e.message, 'err'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function doClose() {
    const r = await dialog.prompt({
      title: t('Закрытие смены'),
      message: `${t('Ожидается в кассе')}: ${money(live.expectedCash)} (${t('касса на старте + наличные продажи + погашения долга + внесено − возвраты наличными − расходы и оплаты поставщикам из кассы − изъято')}). ${t('Пересчитайте наличные и введите фактическую сумму.')}`,
      fields: [{ name: 'counted', label: t('Наличные в кассе по факту (сомони)'), type: 'number', defaultValue: String(Math.round(live.expectedCash * 100) / 100) }],
      confirmText: t('Закрыть смену'),
    })
    if (!r) return
    const counted = Number(r.counted) || 0
    try {
      // Z-отчёт показываем сразу по данным кассы; сервер пришлёт сверенные цифры следом
      const { shift, synced } = closeShift(counted, {
        count: live.count,
        salesCash: live.cash,
        salesCard: live.card,
        salesDebt: live.debt,
        salesTransfer: live.transfer,
        transferBy: live.transferBy,
        cashIn: live.cashIn,
        cashOut: live.cashOut,
        supplierCash: live.supplierCash,
        debtPaid: live.debtPaid,
        refundCash: live.refundCash,
        refundTotal: live.refundTotal,
        refundCost: live.refundCost,
        expenseCash: live.expenseCash,
        discount: live.discount,
        profit: live.profit,
        totalSales: live.total,
        expectedCash: live.expectedCash,
        difference: counted - live.expectedCash,
      })
      toast(t('Смена закрыта'))
      setView({ ...shift, pending: true }) // pending — цифры ещё не сверены с сервером
      synced
        .then((confirmed) => setView((v) => (v ? { ...confirmed, pending: false } : v)))
        .catch((e) => {
          setView(null)
          toast(t('Смена не закрыта') + ': ' + e.message, 'err')
        })
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  return (
    <Layout
      title={t('Смена кассы')}
      subtitle={current ? t('Смена открыта') : t('Смена закрыта')}
      actions={current
        ? (
          <>
            <button className="btn ghost" data-tour="shift.cash-in" onClick={() => doCash('in')}><span className="ic"><LuArrowDownToLine size={16} /></span> {t('Внести')}</button>
            <button className="btn ghost" data-tour="shift.cash-out" onClick={() => doCash('out')}><span className="ic"><LuArrowUpFromLine size={16} /></span> {t('Изъять')}</button>
            <button className="btn danger" data-tour="shift.close" onClick={doClose}><span className="ic"><LuClock size={16} /></span> {t('Закрыть смену')}</button>
          </>
        )
        : null}
    >
      {/* ── Открытие смены ── */}
      {!current && (
        <div className="panel" data-tour="shift.open" style={{ maxWidth: 460 }}>
          <h2><span className="h2-title"><span className="ic"><LuClock size={17} /></span>{t('Открыть смену')}</span></h2>
          <div className="field">
            <label htmlFor="openCash">{t('Наличные в кассе на начало (сомони)')}</label>
            <NumberInput id="openCash" value={openCash} onChange={(e) => setOpenCash(e.target.value)} placeholder="0" autoFocus />
          </div>
          <button className="btn block" onClick={doOpen}><span className="ic"><LuClock size={16} /></span> {t('Открыть смену')}</button>
        </div>
      )}

      {/* ── Текущая смена ── */}
      {current && live && (
        <>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {t('Открыта')}: {fmtDateTime(current.openedAt)} · {t('касса на старте')} {money(current.openingCash)}
          </div>
          <div className="cards">
            <Metric
              tour="shift.sales"
              label={t('Продажи за смену')}
              value={money(live.netSales)}
              Icon={LuTrendingUp}
              sub={live.refundTotal > 0
                ? `${live.count} ${t('чек(ов)')} · ${t('возвраты')} −${money(live.refundTotal)}`
                : `${live.count} ${t('чек(ов)')}`}
              warn={live.refundTotal > 0}
            />
            <Metric tour="shift.paysplit" label={t('Наличными')} value={money(live.cash)} Icon={LuBanknote} />
            <Metric tour="shift.paysplit" label={t('Картой')} value={money(live.card)} Icon={LuCreditCard} />
            <Metric
              tour="shift.paysplit"
              label={t('Переводом')}
              value={money(live.transfer)}
              Icon={LuQrCode}
              sub={Object.entries(live.transferBy).map(([via, sum]) => `${via} ${money(sum)}`).join(' · ') || undefined}
            />
            <Metric tour="shift.expected" label={t('Ожидается в кассе')} value={money(live.expectedCash)} Icon={LuWallet} tint="accent" />
          </div>
          {(live.debt > 0 || live.debtPaid > 0 || live.refundTotal > 0 || live.expenseCash > 0 || live.cashIn > 0 || live.cashOut > 0 || live.supplierCash > 0) && (
            <div className="panel mt" style={{ maxWidth: 460 }}>
              {live.debt > 0 && <div className="total-row"><span>{t('В долг за смену')}</span><span>{money(live.debt)}</span></div>}
              {live.cashIn > 0 && (
                <div className="total-row" data-tour="shift.cash-rows"><span>{t('Внесено в кассу')}</span><span style={{ color: 'var(--green)' }}>+{money(live.cashIn)}</span></div>
              )}
              {live.cashOut > 0 && (
                <div className="total-row" data-tour="shift.cash-rows"><span>{t('Изъято из кассы')}</span><span style={{ color: 'var(--danger)' }}>−{money(live.cashOut)}</span></div>
              )}
              {live.supplierCash > 0 && (
                <div className="total-row"><span>{t('Оплачено поставщикам (нал.)')}</span><span style={{ color: 'var(--danger)' }}>−{money(live.supplierCash)}</span></div>
              )}
              {live.debtPaid > 0 && <div className="total-row"><span>{t('Погашено долгов (нал.)')}</span><span>{money(live.debtPaid)}</span></div>}
              {live.refundTotal > 0 && (
                <div className="total-row">
                  <span>{t('Возвраты за смену')}</span>
                  <span style={{ color: 'var(--danger)' }}>
                    −{money(live.refundTotal)}
                    {live.refundCash > 0 && live.refundCash !== live.refundTotal && (
                      <span className="tag-cat"> · {t('наличными')} {money(live.refundCash)}</span>
                    )}
                  </span>
                </div>
              )}
              {live.expenseCash > 0 && (
                <div className="total-row" data-tour="shift.expenses">
                  <span>{t('Расходы из кассы')}</span>
                  <span style={{ color: 'var(--danger)' }}>−{money(live.expenseCash)}</span>
                </div>
              )}
              {live.refundTotal > 0 && (
                <div className="total-row">
                  <span>{t('Прибыль за смену')}</span>
                  <span style={{ color: 'var(--green)' }}>{money(live.netProfit)}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Внесения и изъятия за смену ── */}
      {current && moves.length > 0 && (
        <div className="panel mt" data-tour="shift.cash-list" style={{ padding: 0, maxWidth: 720 }}>
          <h2 style={{ padding: '16px 16px 0' }}><span className="h2-title"><span className="ic"><LuBanknote size={17} /></span>{t('Наличные за смену')}</span></h2>
          <table>
            <thead><tr><th>{t('Время')}</th><th>{t('Что')}</th><th>{t('Кто')}</th><th className="num">{t('Сумма')}</th><th></th></tr></thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(m.date)}</td>
                  <td>
                    <b>{m.kind === 'in' ? t('Внесение') : t('Изъятие')}</b>
                    {m.note ? <div className="tag-cat">{m.note}</div> : null}
                  </td>
                  <td>{m.user?.name || '—'}</td>
                  <td className="num" style={{ color: m.kind === 'in' ? 'var(--green)' : 'var(--danger)', whiteSpace: 'nowrap' }}>{m.kind === 'in' ? '+' : '−'}{money(m.amount)}</td>
                  <td className="num">
                    {isFounder && (
                      <button className="btn ghost sm icon" onClick={() => undoCash(m)} title={t('Отменить')} aria-label={`${t('Отменить')} ${money(m.amount)}`}><LuTrash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Сегодня по кассирам (только владелец) ── */}
      {isFounder && byCashier.length > 0 && (
        <div className="panel mt" data-tour="shift.cashiers" style={{ padding: 0 }}>
          <h2 style={{ padding: '16px 16px 0' }}><span className="h2-title"><span className="ic"><LuUsers size={17} /></span>{t('Сегодня по кассирам')}</span></h2>
          <table>
            <thead>
              <tr><th>{t('Кассир')}</th><th className="num">{t('Чеков')}</th><th className="num">{t('Наличными')}</th><th className="num">{t('Картой')}</th><th className="num">{t('В долг')}</th><th className="num">{t('Всего')}</th></tr>
            </thead>
            <tbody>
              {byCashier.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b></td>
                  <td className="num">{c.count}</td>
                  <td className="num">{money(c.cash)}</td>
                  <td className="num">{money(c.card)}</td>
                  <td className="num">{money(c.debt)}</td>
                  <td className="num"><b>{money(c.total)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── История смен (Z-отчёты) ── */}
      <div className="panel mt" data-tour="shift.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}><span className="h2-title"><span className="ic"><LuCalculator size={17} /></span>{t('История смен')}</span></h2>
        <table>
          <thead>
            <tr>
              <th>{t('Период')}</th><th>{t('Кассир')}</th><th className="num">{t('Чеков')}</th><th className="num">{t('Выручка')}</th>
              <th className="num">{t('Наличные (факт)')}</th><th className="num">{t('Расхождение')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {pg.slice.map((s) => (
              <tr key={s.id}>
                <td>
                  {fmtShort(s.openedAt)}{' — '}{s.closedAt && fmtTime(s.closedAt)}
                </td>
                <td>
                  {s.user?.name || '—'}
                  {/* Смена кассы (программа для Windows): на какой именно */}
                  {s.deviceName ? <div className="tag-cat">{s.deviceName}</div> : null}
                </td>
                <td className="num">{s.count}</td>
                <td className="num">
                  <b>{money(shiftTotals(s).netSales)}</b>
                  {(s.refundTotal || 0) > 0 && (
                    <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('возвраты')} −{money(s.refundTotal)}</div>
                  )}
                </td>
                <td className="num">{money(s.countedCash || 0)}</td>
                <td className="num">
                  <span className={'badge ' + (Math.abs(s.difference) < 0.01 ? 'ok' : 'debt')}>
                    {s.difference > 0 ? '+' : ''}{money(s.difference)}
                  </span>
                </td>
                <td className="num"><button className="btn ghost sm" onClick={() => setView(s)}>{t('Z-отчёт')}</button></td>
              </tr>
            ))}
            {history.length === 0 && <tr><td colSpan="7" className="empty">{t('Закрытых смен пока нет')}</td></tr>}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

      {view && <ZReport shift={view} onClose={() => setView(null)} />}
    </Layout>
  )
}

function ZReport({ shift, onClose }) {
  const toast = useToast()
  const auth = useAuth()
  const ok = Math.abs(shift.difference) < 0.01
  // Чистые числа считаем из сохранённых полей смены: у смен, закрытых до учёта
  // возвратов, они нулевые — и чистые значения совпадают с валовыми
  const totals = shiftTotals(shift)
  const row = (label, value, strong) => (
    <div className={'total-row' + (strong ? ' big' : '')}><span>{label}</span><span>{value}</span></div>
  )
  return (
    <Modal className="printable" title={<><span className="ic"><LuCalculator size={18} /></span>{tr('Z-отчёт смены')}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>
        {fmtDateTime(shift.openedAt)} — {shift.closedAt && fmtDateTime(shift.closedAt)}
        {shift.deviceName ? ` · ${shift.deviceName}` : ''}
      </div>
      {shift.pending && (
        <div className="note info no-print" style={{ marginBottom: 12 }}>
          {tr('Цифры предварительные — сверяются с сервером…')}
        </div>
      )}
      {row(tr('Чеков'), shift.count)}
      {row(tr('Наличными'), money(shift.salesCash))}
      {row(tr('Картой'), money(shift.salesCard))}
      {row(tr('В долг'), money(shift.salesDebt))}
      {(shift.salesTransfer || 0) > 0 && row(tr('Переводом'), money(shift.salesTransfer))}
      {(shift.salesTransfer || 0) > 0 &&
        Object.entries(shift.transferBy || {}).map(([via, sum]) => (
          <div className="total-row" key={via} style={{ fontSize: 13, color: 'var(--muted)' }}><span style={{ paddingLeft: 14 }}>{via}</span><span>{money(sum)}</span></div>
        ))}
      {(shift.debtPaid || 0) > 0 && row(tr('Погашено долгов (нал.)'), money(shift.debtPaid))}
      {row(tr('Скидки'), '−' + money(shift.discount))}
      {totals.refunds > 0 && (
        <>
          <div style={{ borderTop: '1px dashed var(--border-strong)', margin: '12px 0' }} />
          {row(tr('Продано за смену'), money(totals.gross))}
          {row(tr('Возвраты покупателям'), '−' + money(totals.refunds))}
        </>
      )}
      {row(tr('Выручка'), money(totals.netSales), true)}
      {row(tr('Прибыль'), money(totals.netProfit))}
      <div style={{ borderTop: '1px dashed var(--border-strong)', margin: '12px 0' }} />
      {row(tr('Касса на старте'), money(shift.openingCash))}
      {(shift.cashIn || 0) > 0 && row(tr('Внесено в кассу'), '+' + money(shift.cashIn))}
      {(shift.refundCash || 0) > 0 && row(tr('Выдано за возвраты (нал.)'), '−' + money(shift.refundCash))}
      {(shift.expenseCash || 0) > 0 && row(tr('Расходы из кассы'), '−' + money(shift.expenseCash))}
      {(shift.supplierCash || 0) > 0 && row(tr('Оплачено поставщикам (нал.)'), '−' + money(shift.supplierCash))}
      {(shift.cashOut || 0) > 0 && row(tr('Изъято из кассы'), '−' + money(shift.cashOut))}
      {row(tr('Ожидалось в кассе'), money(shift.expectedCash))}
      {row(tr('Пересчитано (факт)'), money(shift.countedCash || 0))}
      <div className="total-row big">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {ok ? <LuCircleCheck size={18} style={{ color: 'var(--green)' }} /> : <LuTriangleAlert size={18} style={{ color: 'var(--danger)' }} />}
          {tr('Расхождение')}
        </span>
        <span style={{ color: ok ? 'var(--green)' : 'var(--danger)' }}>
          {shift.difference > 0 ? '+' : ''}{money(shift.difference)}
        </span>
      </div>
      <div className="modal-actions">
        <button
          className="btn ghost"
          onClick={() =>
            // На чековом принтере Z-отчёт печатается строками, как чек; иначе — окно печати
            printTicket(shiftTicket(shift, totals, { t: tr, money, when: fmtDateTime, pharmacy: auth?.pharmacy?.name })).catch((e) => toast(tr(e.message), 'err'))
          }
        >
          <span className="ic"><LuReceipt size={16} /></span> {tr('Печать')}
        </button>
        <button className="btn" onClick={onClose}>{tr('Готово')}</button>
      </div>
    </Modal>
  )
}
