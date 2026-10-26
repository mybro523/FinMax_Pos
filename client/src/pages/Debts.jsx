import { useState, useMemo } from 'react'
import { LuUserPlus, LuTrash2, LuReceipt, LuBanknote, LuChevronRight, LuPrinter } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import TicketView from '../components/TicketView'
import PrintDoc from '../components/PrintDoc'
import { useCollection, money, db, SALES_CACHE_DAYS } from '../db/store'
import { useAuth, useCan } from '../db/auth'
import { payDebt } from '../db/ops'
import { fmtDate, fmtDateTime, chekNomer } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'
import { istoriyaDolga, tovaryText } from '../lib/dolg'
import { debtTicket } from '../lib/ticket'
import { getRekvizity } from '../lib/rekvizity'
import { pechatTicket } from '../lib/pechat'

export default function Debts() {
  const customers = useCollection('customers')
  const sales = useCollection('sales')
  const payments = useCollection('payments')
  // Возвраты в счёт долга (и отмены чеков) — тоже строки истории клиента
  const returns = useCollection('returns')
  // Единицы строк (кг, л…) — из карточек товаров: у строк с сервера их нет
  const products = useCollection('products')
  const toast = useToast()
  const dialog = useDialog()
  const t = useT()
  const [detail, setDetail] = useState(null) // клиент, чью историю смотрим
  // Удалять клиента вместе с его долгом и историей платежей может только владелец
  const can = useCan()
  const isFounder = can('customers.delete')
  const totalDebt = customers.reduce((s, c) => s + (c.debt || 0), 0)
  const pg = usePagination(customers, 10)

  // ── Выгрузка и печать: все клиенты и их долги ──
  const exCols = [
    { header: t('Клиент'), key: 'name', width: 30 },
    { header: t('Телефон'), key: 'phone', width: 18 },
    { header: t('Долг'), key: 'debt', width: 14, money: true },
  ]
  const exRows = customers.map((c) => ({ name: c.name, phone: c.phone || '', debt: Number(c.debt) || 0 }))
  const exItogi = { name: t('Итого'), debt: Math.round(totalDebt * 100) / 100 }
  const exPodzag = `${t('Клиентов')}: ${customers.length} · ${t('с долгом')}: ${customers.filter((c) => (c.debt || 0) > 0).length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Долги клиентов'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Долги клиентов')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  async function add() {
    const r = await dialog.prompt({
      title: t('Новый клиент'),
      fields: [
        { name: 'name', label: t('Имя клиента') },
        { name: 'phone', label: t('Телефон'), placeholder: '+992 …' },
        { name: 'debt', label: t('Сумма долга (сомони)'), type: 'number', defaultValue: '0' },
      ],
      confirmText: t('Добавить'),
    })
    if (!r || !r.name.trim()) return
    db.push('customers', {
      name: r.name.trim(),
      phone: (r.phone || '').trim(),
      debt: Math.max(0, Number(r.debt) || 0),
    }).catch((e) => toast(e.message, 'err'))
    toast(t('Клиент добавлен'))
  }

  async function pay(c) {
    const r = await dialog.prompt({
      title: `${t('Погашение долга')} — ${c.name}`,
      fields: [{ name: 'amount', label: `${t('Сумма (долг')} ${money(c.debt)})`, type: 'number', defaultValue: String(c.debt) }],
      confirmText: t('Погасить'),
    })
    if (!r) return
    const amount = Number(r.amount)
    if (!amount || amount <= 0) return
    payDebt(c.id, amount).catch((e) => toast(e.message, 'err')) // мгновенно, сверка с сервером
    toast(t('Долг погашается…'))
  }

  async function remove(c) {
    const ok = await dialog.confirm({
      title: t('Удалить клиента?'),
      // Про непогашенный долг предупреждаем прямо: вместе с клиентом исчезнет
      // и он, и вся история его платежей
      message: c.debt > 0
        ? `«${c.name}» будет удалён без возможности восстановления. ${t('Непогашенный долг')} ${money(c.debt)} ${t('и история платежей пропадут.')}`
        : `«${c.name}» будет удалён без возможности восстановления.`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    db.remove('customers', c.id).catch((e) => toast(e.message, 'err'))
    toast(t('Клиент удалён'))
  }

  return (
    <Layout
      title={t('Долги клиентов')}
      note={`${t('Общая задолженность')}: ${money(totalDebt)}`}
      actions={
        <>
          <ExportPechat onExcel={exportExcel} />
          {can('customers.create') && <button className="btn" data-tour="debt.add" onClick={add}><span className="ic"><LuUserPlus size={16} /></span> {t('Добавить клиента')}</button>}
        </>
      }
    >
      <PrintSheet zagolovok={t('Долги клиентов')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      <div className="panel" data-tour="debt.list" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>{t('Клиент')}</th><th>{t('Телефон')}</th><th className="num">{t('Долг')}</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setDetail(c)} title={t('Показать историю')}>
                <td><b>{c.name}</b> <LuChevronRight size={13} style={{ verticalAlign: '-2px', color: 'var(--muted-2)' }} /></td>
                <td className="tag-cat">{c.phone || '—'}</td>
                <td className="num">
                  {c.debt > 0
                    ? <span className="badge debt">{money(c.debt)}</span>
                    : <span className="badge ok">{t('нет долга')}</span>}
                </td>
                <td className="num" onClick={(e) => e.stopPropagation()}>
                  {c.debt > 0 && can('debts.pay') && <button className="btn ghost sm" data-tour="debt.pay" onClick={() => pay(c)}>{t('Погасить')}</button>}{' '}
                  {isFounder && <button className="btn ghost sm icon" onClick={() => remove(c)}><LuTrash2 size={15} /></button>}
                </td>
              </tr>
            ))}
            {customers.length === 0 && <tr><td colSpan="4" className="empty">{t('Клиентов с долгами нет. Долг появляется при продаже «В долг» на кассе.')}</td></tr>}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

      {detail && (
        <CustomerHistory
          customer={customers.find((c) => c.id === detail.id) || detail}
          sales={sales}
          payments={payments}
          returns={returns}
          products={products}
          canPay={can('debts.pay')}
          onClose={() => setDetail(null)}
          onPay={() => { setDetail(null); pay(customers.find((c) => c.id === detail.id) || detail) }}
        />
      )}
    </Layout>
  )
}

// ── История операций клиента: покупки в долг, возвраты и погашения ──
// Расчёт — в lib/dolg.js: там же «Прежний долг до <даты>» за всё, что было раньше истории
// устройства, — чтобы итоги сходились. «Печать» выдаёт эту же историю клиенту на руки
// в виде чека (lib/ticket.js, debtTicket): на чековый принтер или через экран печати
function CustomerHistory({ customer, sales, payments, returns, products, canPay, onClose, onPay }) {
  const auth = useAuth()
  const toast = useToast()
  const data = useMemo(
    () => istoriyaDolga({ customer, sales, payments, returns, products, days: SALES_CACHE_DAYS }),
    [customer, sales, payments, returns, products],
  )
  const ticket = debtTicket(customer, data, {
    t: tr,
    money,
    when: fmtDateTime,
    day: fmtDate,
    pharmacy: auth?.pharmacy?.name,
    rekvizity: getRekvizity(auth?.pharmacy?.code),
    tovary: (items) => tovaryText(items, tr),
    nomer: chekNomer,
  })
  const print = () => pechatTicket(ticket).catch((e) => toast(tr(e.message), 'err'))

  return (
    <Modal wide title={<><span className="ic"><LuReceipt size={18} /></span>{customer.name}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>{customer.phone || tr('без телефона')}</div>

      <div className="mini-cards">
        <div className="mini-card"><div className="m-label">{tr('Текущий долг')}</div><div className="m-value" style={{ color: customer.debt > 0 ? 'var(--danger)' : 'var(--green)' }}>{money(customer.debt)}</div></div>
        <div className="mini-card"><div className="m-label">{tr('Куплено в долг')}</div><div className="m-value sm">{money(data.totalCredit)}</div></div>
        {data.totalReturned > 0 && (
          <div className="mini-card"><div className="m-label">{tr('Возвращено')}</div><div className="m-value sm">{money(data.totalReturned)}</div></div>
        )}
        <div className="mini-card"><div className="m-label">{tr('Погашено')}</div><div className="m-value sm" style={{ color: 'var(--green)' }}>{money(data.totalPaid)}</div></div>
      </div>

      <h2 style={{ fontSize: 14, margin: '16px 0 6px' }}>{tr('История операций')}</h2>
      <div style={{ maxHeight: '46vh', overflow: 'auto' }}>
        <table>
          <tbody>
            {data.events.map((e, n) => (
              <tr key={n}>
                <td>
                  {e.kind === 'debt' ? (
                    <>
                      <b>{tr('Покупка в долг')}</b>
                      <div className="tag-cat">{tovaryText(e.items, tr).slice(0, 90)}</div>
                    </>
                  ) : e.kind === 'return' ? (
                    <>
                      <b style={{ color: 'var(--green)' }}>{e.otmena ? tr('Отмена чека') : tr('Возврат товара')}</b>
                      <div className="tag-cat">{tovaryText(e.items, tr).slice(0, 90)}</div>
                    </>
                  ) : (
                    <><b style={{ color: 'var(--green)' }}>{tr('Погашение')}</b> <span className="ic" style={{ color: 'var(--green)', verticalAlign: '-2px' }}><LuBanknote size={13} /></span></>
                  )}
                  <div className="tag-cat">{fmtDateTime(e.date)}</div>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap', color: e.kind === 'debt' ? 'var(--danger)' : 'var(--green)' }}>
                  <b>{e.kind === 'debt' ? '+' : '−'}{money(e.amount)}</b>
                </td>
              </tr>
            ))}
            {data.opening !== 0 && (
              <tr>
                <td>
                  <b>{tr('Прежний долг до')} {fmtDate(data.start)}</b>
                  <div className="tag-cat">{tr('всё, что было раньше, одной суммой')}</div>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}><b>{money(data.opening)}</b></td>
              </tr>
            )}
            {data.events.length === 0 && data.opening === 0 && <tr><td colSpan="2" className="empty">{tr('Операций пока нет')}</td></tr>}
          </tbody>
        </table>
      </div>

      {/* На бумагу — эта же история, из печатного слоя */}
      <PrintDoc prio={2} kind="ticket" title={tr('Долг клиента')}><TicketView ticket={ticket} /></PrintDoc>

      <div className="modal-actions">
        <button className="btn ghost" data-testid="debt-print" onClick={print}><span className="ic"><LuPrinter size={16} /></span> {tr('Печать')}</button>
        {customer.debt > 0 && canPay && <button className="btn" onClick={onPay}>{tr('Погасить долг')}</button>}
        <button className="btn ghost" onClick={onClose}>{tr('Закрыть')}</button>
      </div>
    </Modal>
  )
}
