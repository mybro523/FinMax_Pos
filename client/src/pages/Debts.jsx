import { useState, useMemo } from 'react'
import { LuUserPlus, LuTrash2, LuReceipt, LuBanknote, LuChevronRight, LuPrinter } from 'react-icons/lu'
import Layout from '../components/Layout'
import StickyBar, { useTelefon } from '../components/StickyBar'
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
  // На телефоне над списком — поиск клиента по имени или телефону, закреплённый вверху:
  // карточка клиента высокая, и при десятке должников нужного приходилось долго листать.
  // На компьютере список прежний, без поиска
  const phone = useTelefon()
  const [q, setQ] = useState('')
  const z = phone ? q.trim().toLowerCase() : ''
  const zCifry = z.replace(/\D/g, '')
  const spisok = z
    ? customers.filter((c) => (c.name || '').toLowerCase().includes(z) || (zCifry && String(c.phone || '').replace(/\D/g, '').includes(zCifry)))
    : customers
  const pg = usePagination(spisok, 10, z)
  // Подсветка тура «Погасить» на телефоне — только у первого клиента с долгом: карточки
  // разные, и общая рамка вокруг кнопок всех карточек перечёркивала список полосой
  const firstPay = pg.slice.findIndex((c) => c.debt > 0)

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
        {phone && customers.length > 0 && (
          <StickyBar panel pad="12px 12px 6px" className="debt-poisk">
            <div className="toolbar">
              <input className="search" placeholder={t('Имя или телефон…')} aria-label={t('Поиск')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="debt-search" />
            </div>
          </StickyBar>
        )}
        {/* На телефоне клиенты — карточками (index.css, .table-cards): нажатие на карточку
            открывает историю, как строка на компьютере */}
        <div className="table-cards-wrap">
        <table className="table-cards debt-list">
          <thead><tr><th>{t('Клиент')}</th><th>{t('Телефон')}</th><th className="num">{t('Долг')}</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((c, n) => (
              <tr key={c.id} className="clickable" onClick={() => setDetail(c)} title={t('Показать историю')}>
                <td className="cell-main"><b>{c.name}</b> <LuChevronRight size={13} style={{ verticalAlign: '-2px', color: 'var(--muted-2)' }} /></td>
                <td className="tag-cat" data-label={t('Телефон')}>{c.phone || '—'}</td>
                <td className="num" data-label={t('Долг')}>
                  {c.debt > 0
                    ? <span className="badge debt">{money(c.debt)}</span>
                    : <span className="badge ok">{t('нет долга')}</span>}
                </td>
                <td className="num cell-actions" onClick={(e) => e.stopPropagation()}>
                  {c.debt > 0 && can('debts.pay') && <button className="btn ghost sm" data-tour={!phone || n === firstPay ? 'debt.pay' : undefined} onClick={() => pay(c)}>{t('Погасить')}</button>}{' '}
                  {isFounder && <button className="btn ghost sm icon" onClick={() => remove(c)}><LuTrash2 size={15} /></button>}
                </td>
              </tr>
            ))}
            {customers.length === 0 && <tr><td colSpan="4" className="empty">{t('Клиентов с долгами нет. Долг появляется при продаже «В долг» на кассе.')}</td></tr>}
            {customers.length > 0 && spisok.length === 0 && <tr><td colSpan="4" className="empty">{t('Ничего не найдено')}</td></tr>}
          </tbody>
        </table>
        </div>
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
  // Карточки сверху — отбор истории: «Текущий долг» — всё, остальные — только свои операции
  const [vid, setVid] = useState('')
  const vidOf = (e) => (e.kind === 'debt' || e.kind === 'return' ? e.kind : 'pay')
  const events = vid ? data.events.filter((e) => vidOf(e) === vid) : data.events
  const card = (key) => ({
    className: 'mini-card clickable' + (vid === key ? ' active' : ''),
    role: 'button',
    tabIndex: 0,
    'data-testid': 'debt-card-' + (key || 'all'),
    title: tr('Показать эти операции'),
    onClick: () => setVid(key),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setVid(key) } },
  })

  return (
    // debt-okno — правила для телефона (styles/m-smena.css)
    <Modal wide className="debt-okno" title={<><span className="ic"><LuReceipt size={18} /></span>{customer.name}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>{customer.phone || tr('без телефона')}</div>

      <div className="mini-cards">
        <div {...card('')}><div className="m-label">{tr('Текущий долг')}</div><div className="m-value" style={{ color: customer.debt > 0 ? 'var(--danger)' : 'var(--green)' }}>{money(customer.debt)}</div></div>
        <div {...card('debt')}><div className="m-label">{tr('Куплено в долг')}</div><div className="m-value sm">{money(data.totalCredit)}</div></div>
        {data.totalReturned > 0 && (
          <div {...card('return')}><div className="m-label">{tr('Возвращено')}</div><div className="m-value sm">{money(data.totalReturned)}</div></div>
        )}
        <div {...card('pay')}><div className="m-label">{tr('Погашено')}</div><div className="m-value sm" style={{ color: 'var(--green)' }}>{money(data.totalPaid)}</div></div>
      </div>

      <h2 style={{ fontSize: 14, margin: '16px 0 6px' }}>
        {vid === 'debt' ? tr('Покупки в долг') : vid === 'return' ? tr('Возвраты') : vid === 'pay' ? tr('Погашения') : tr('История операций')}
        {vid && <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setVid('')}>{tr('Показать все')}</button>}
      </h2>
      {/* okno-spisok: на телефоне у списка нет своей прокрутки — шторка листается целиком
          (m-otchety.css). Иначе на низком экране листались и окно, и список внутри него */}
      <div className="okno-spisok" style={{ maxHeight: '46vh', overflow: 'auto' }}>
        <table>
          <tbody>
            {events.map((e, n) => (
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
            {!vid && data.opening !== 0 && (
              <tr>
                <td>
                  <b>{tr('Прежний долг до')} {fmtDate(data.start)}</b>
                  <div className="tag-cat">{tr('всё, что было раньше, одной суммой')}</div>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}><b>{money(data.opening)}</b></td>
              </tr>
            )}
            {vid && events.length === 0 && <tr><td colSpan="2" className="empty">{tr('Таких операций нет')}</td></tr>}
            {!vid && data.events.length === 0 && data.opening === 0 && <tr><td colSpan="2" className="empty">{tr('Операций пока нет')}</td></tr>}
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
