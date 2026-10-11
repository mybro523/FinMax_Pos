import { useState, useMemo } from 'react'
import { LuUserPlus, LuTrash2, LuReceipt, LuBanknote, LuChevronRight } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money, db } from '../db/store'
import { useAuth } from '../db/auth'
import { payDebt } from '../db/ops'
import { fmtDateTime } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'

export default function Debts() {
  const customers = useCollection('customers')
  const sales = useCollection('sales')
  const payments = useCollection('payments')
  const toast = useToast()
  const dialog = useDialog()
  const t = useT()
  const [detail, setDetail] = useState(null) // клиент, чью историю смотрим
  // Удалять клиента вместе с его долгом и историей платежей может только владелец
  const isFounder = useAuth()?.role === 'founder'
  const totalDebt = customers.reduce((s, c) => s + (c.debt || 0), 0)
  const pg = usePagination(customers, 10)

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
      subtitle={`${t('Общая задолженность')}: ${money(totalDebt)}`}
      actions={<button className="btn" data-tour="debt.add" onClick={add}><span className="ic"><LuUserPlus size={16} /></span> {t('Добавить клиента')}</button>}
    >
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
                  {c.debt > 0 && <button className="btn ghost sm" data-tour="debt.pay" onClick={() => pay(c)}>{t('Погасить')}</button>}{' '}
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
          customer={detail}
          sales={sales}
          payments={payments}
          onClose={() => setDetail(null)}
          onPay={() => { setDetail(null); pay(detail) }}
        />
      )}
    </Layout>
  )
}

// ── История операций клиента: покупки в долг + погашения ──
function CustomerHistory({ customer, sales, payments, onClose, onPay }) {
  const data = useMemo(() => {
    const purchases = sales
      .filter((s) => s && s.payment === 'debt' && (s.customerId === customer.id || s.customer?.id === customer.id) && Array.isArray(s.items))
      .map((s) => ({ kind: 'debt', date: s.date, amount: s.total || 0, items: s.items }))
    const pays = payments
      .filter((p) => p && p.customerId === customer.id)
      .map((p) => ({ kind: 'pay', date: p.createdAt, amount: p.amount || 0 }))
    const events = [...purchases, ...pays].sort((a, b) => new Date(b.date) - new Date(a.date))
    const totalCredit = purchases.reduce((s, e) => s + e.amount, 0)
    const totalPaid = pays.reduce((s, e) => s + e.amount, 0)
    return { events, totalCredit, totalPaid }
  }, [customer, sales, payments])

  return (
    <Modal wide title={<><span className="ic"><LuReceipt size={18} /></span>{customer.name}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>{customer.phone || tr('без телефона')}</div>

      <div className="mini-cards">
        <div className="mini-card"><div className="m-label">{tr('Текущий долг')}</div><div className="m-value" style={{ color: customer.debt > 0 ? 'var(--danger)' : 'var(--green)' }}>{money(customer.debt)}</div></div>
        <div className="mini-card"><div className="m-label">{tr('Куплено в долг')}</div><div className="m-value sm">{money(data.totalCredit)}</div></div>
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
                      <div className="tag-cat">{e.items.map((i) => `${i.name}${i.qty ? ' ×' + i.qty : ''}${i.pieces ? ' +' + i.pieces + 'шт' : ''}`).join(', ').slice(0, 70)}</div>
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
            {data.events.length === 0 && <tr><td colSpan="2" className="empty">{tr('Операций пока нет')}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="modal-actions">
        {customer.debt > 0 && <button className="btn" onClick={onPay}>{tr('Погасить долг')}</button>}
        <button className="btn ghost" onClick={onClose}>{tr('Закрыть')}</button>
      </div>
    </Modal>
  )
}
