import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LuTruck, LuPlus, LuPencil, LuTrash2, LuBanknote, LuHandCoins, LuPackagePlus, LuCircleDollarSign, LuReceipt, LuWallet } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import NumberInput from '../components/NumberInput'
import { useCollection, money, db, onChanged } from '../db/store'
import { api } from '../db/api'
import { fmtDate, fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { useCan, getUser } from '../db/auth'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { PeriodPicker, presetPeriod, periodRange, periodText, useDeepPeriod } from '../components/Period'
import { zakupkiIOplaty } from '../lib/otchety'
import { skachatXlsx } from '../lib/excel'
import SupplierDebtsPanel, { useDolgiPostavshikam } from './SupplierDebts'
import { SupplierPayPanel, SupplierPaymentsTable } from '../components/SupplierMoney'

// ── Поставщики и долги перед ними ──
// Магазин берёт товар у дистрибьюторов в долг. Приход записывался, а кому и сколько
// магазин должен — не было нигде. Здесь: список поставщиков с долгом, карточка с
// историей (приходы в долг и оплаты) и сама оплата.
//
// Оплата поставщику — не расход: товар уже учтён при продаже по закупочной цене.
// Но если деньги взяты из ящика кассы, смена обязана это знать — такая оплата
// привязана к открытой смене и отменяется, только пока смена открыта.

// Какая вкладка открыта — помнится на устройстве
const VKLADKA = 'apteka_postavshiki_vkladka'

export default function Suppliers() {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const suppliers = useCollection('suppliers')
  const [q, setQ] = useState('')
  const [form, setForm] = useState(null) // { id?, name, phone, note, openingDebt }
  const [cardId, setCardId] = useState(null)

  // ── Вкладки: список поставщиков и сводка долгов ──
  // Раньше это были две плитки меню про одно и то же. Адрес ?tab=debts ведёт сразу
  // в сводку — по нему же работает прежняя ссылка «Долги поставщикам»
  const { search } = useLocation()
  const [tab, setTabRaw] = useState(() => {
    if (new URLSearchParams(search).get('tab') === 'debts') return 'debts'
    try {
      return localStorage.getItem(VKLADKA) === 'debts' ? 'debts' : 'list'
    } catch {
      return 'list'
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
  const dolgi = useDolgiPostavshikam()

  // ── Закупки и оплаты за период ──
  // Одна таблица по датам: что у кого купили, сколько, почём, сколько оплатили
  // сразу и сколько ушло в долг; погашения долга и возвраты товара — отдельными строками
  const arrivalsCached = useCollection('arrivals')
  const paymentsCached = useCollection('supplierPayments')
  const returnsCached = useCollection('supplierReturns')
  const products = useCollection('products')
  const [period, setPeriod] = useState(() => presetPeriod('month'))
  const [supFilter, setSupFilter] = useState('')
  const [hq, setHq] = useState('')
  const range = useMemo(() => periodRange(period), [period])
  const { deep, loading: loadingOlder } = useDeepPeriod(['arrivals', 'supplierPayments', 'supplierReturns'], range)
  const zak = useMemo(
    () =>
      zakupkiIOplaty({
        arrivals: deep.arrivals || arrivalsCached,
        supplierPayments: deep.supplierPayments || paymentsCached,
        supplierReturns: deep.supplierReturns || returnsCached,
        products,
        from: range.from,
        to: range.to,
        supplierId: supFilter,
        t,
      }),
    [deep, arrivalsCached, paymentsCached, returnsCached, products, range, supFilter, t],
  )
  const zakRows = useMemo(() => {
    const needle = hq.trim().toLowerCase()
    if (!needle) return zak.rows
    return zak.rows.filter((r) => `${r.name} ${r.supplier}`.toLowerCase().includes(needle))
  }, [zak.rows, hq])
  const pgH = usePagination(zakRows, 15, `${hq}|${supFilter}|${period.from}|${period.to}`)
  const zakItogo = useMemo(
    () => zakRows.reduce((s, r) => ({ sum: s.sum + r.sum, paid: s.paid + r.paid, debt: s.debt + r.debt }), { sum: 0, paid: 0, debt: 0 }),
    [zakRows],
  )
  const supName = (r) => r.supplier || (r.supplierId ? suppliers.find((s) => s.id === r.supplierId)?.name : '') || t('без поставщика')

  const exCols = [
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
  const exRows = zakRows.map((r) => ({
    date: fmtDateTime(r.date),
    supplier: supName(r),
    name: r.name,
    qty: r.qty,
    price: r.kind !== 'pay' ? r.price : '',
    sum: r.kind !== 'pay' ? r.sum : '',
    paid: r.paid,
    debt: r.debt,
    user: r.user || '',
  }))
  const exItogi = { date: t('Итого'), sum: Math.round(zakItogo.sum * 100) / 100, paid: Math.round(zakItogo.paid * 100) / 100, debt: Math.round(zakItogo.debt * 100) / 100 }
  const exPodzag = `${periodText(period, t)}${supFilter ? ' · ' + (suppliers.find((s) => s.id === supFilter)?.name || '') : ''}`
  const exportZakupki = () =>
    skachatXlsx({
      fayl: t('Закупки и оплаты'),
      zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Закупки и оплаты поставщикам')}`,
      podzag: exPodzag,
      cols: exCols,
      rows: exRows,
      itogi: exItogi,
    })

  const totalDebt = useMemo(() => suppliers.reduce((s, x) => s + (Number(x.debt) || 0), 0), [suppliers])
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return suppliers.filter((s) => !needle || s.name.toLowerCase().includes(needle) || String(s.phone || '').includes(needle))
  }, [suppliers, q])
  const pg = usePagination(list, 10, q)

  function save() {
    const name = (form.name || '').trim()
    if (!name) return toast(t('Укажите название поставщика'), 'err')
    if (suppliers.some((s) => s.id !== form.id && s.name.toLowerCase() === name.toLowerCase())) {
      return toast(t('Поставщик с таким названием уже есть'), 'err')
    }
    const data = { name, phone: (form.phone || '').trim(), note: (form.note || '').trim() }
    const done = form.id
      ? db.update('suppliers', form.id, data)
      : db.push('suppliers', { ...data, openingDebt: Math.max(0, Number(form.openingDebt) || 0) })
    done.then(() => toast(form.id ? t('Поставщик изменён') : t('Поставщик добавлен'))).catch((e) => toast(t(e.message), 'err'))
    setForm(null)
  }

  async function remove(s) {
    if ((Number(s.debt) || 0) !== 0) return toast(t('У поставщика есть долг — сначала закройте его'), 'err')
    const ok = await dialog.confirm({
      title: t('Удалить поставщика?'),
      message: `«${s.name}» ${t('исчезнет из списка. Его приходы останутся в журнале.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    db.remove('suppliers', s.id)
      .then(() => toast(t('Поставщик удалён')))
      .catch((e) => toast(t(e.message), 'err'))
  }

  return (
    <Layout
      title={t('Поставщики')}
      subtitle={tab === 'debts' ? `${t('Всего должны')}: ${money(dolgi.s.total)}` : t('Кому и сколько должен магазин')}
      actions={
        tab === 'debts' ? (
          <ExportPechat onExcel={dolgi.exportExcel} />
        ) : (
          <>
            <ExportPechat onExcel={exportZakupki} />
            {can('suppliers.edit') && <button className="btn" data-tour="sup.add" onClick={() => setForm({ name: '', phone: '', note: '', openingDebt: '' })}>
              <span className="ic"><LuPlus size={16} /></span> {t('Добавить поставщика')}
            </button>}
          </>
        )
      }
    >
      <div className="chips" data-tour="sup.tabs" style={{ marginBottom: 14 }}>
        <button className={'chip ' + (tab === 'list' ? 'active' : '')} data-tour="sup.tab-list" onClick={() => setTab('list')}>
          <LuTruck size={14} style={{ marginRight: 6, verticalAlign: -2 }} />{t('Поставщики')}
        </button>
        <button className={'chip ' + (tab === 'debts' ? 'active' : '')} data-tour="sup.tab-debts" onClick={() => setTab('debts')}>
          <LuCircleDollarSign size={14} style={{ marginRight: 6, verticalAlign: -2 }} />{t('Долги поставщикам')}
          {totalDebt > 0 && <span className="chip-badge">{money(totalDebt)}</span>}
        </button>
      </div>

      {tab === 'debts' && <SupplierDebtsPanel dolgi={dolgi} onOpen={(p) => setCardId(p.id)} />}

      {tab === 'list' && (<>
      <PrintSheet zagolovok={t('Закупки и оплаты поставщикам')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: при приходе товара отметьте, сколько оплачено сразу, — остальное станет долгом перед поставщиком. Когда заплатите, запишите оплату здесь. На чистую прибыль долги не влияют: товар уже учтён при продаже.')}
      </div>

      <div className="cards" style={{ marginBottom: 16 }}>
        <div className="metric" data-tour="sup.total">
          <div className="metric-head">
            <div className="label">{t('Долги поставщикам')}</div>
            <div className="ic-box" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}><LuTruck size={19} /></div>
          </div>
          <div className="value">{money(totalDebt)}</div>
          <div className="sub">{suppliers.filter((s) => (Number(s.debt) || 0) > 0).length} {t('поставщик(ов) с долгом')}</div>
        </div>
        <div className="metric">
          <div className="metric-head">
            <div className="label">{t('Закуплено за период')}</div>
            <div className="ic-box" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><LuReceipt size={19} /></div>
          </div>
          <div className="value">{money(zakItogo.sum)}</div>
          <div className="sub">{periodText(period, t)}</div>
        </div>
        <div className="metric">
          <div className="metric-head">
            <div className="label">{t('Оплачено за период')}</div>
            <div className="ic-box" style={{ background: 'var(--green-soft, var(--accent-soft))', color: 'var(--green)' }}><LuWallet size={19} /></div>
          </div>
          <div className="value">{money(zakItogo.paid)}</div>
          <div className="sub">{t('сразу при приходе и погашения долга')}</div>
        </div>
      </div>

      <div className="panel" data-tour="sup.history" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '16px 16px 0' }}>
          <h2 style={{ marginBottom: 12 }}><span className="h2-title"><span className="ic"><LuReceipt size={17} /></span>{t('Закупки и оплаты')}</span>
            {loadingOlder && <span className="tag-cat">{t('загружаем…')}</span>}
          </h2>
          <PeriodPicker value={period} onChange={setPeriod} tour="sup.period" />
          <div className="toolbar" style={{ marginTop: 10 }}>
            <input className="search" placeholder={t('Поиск по товару или поставщику…')} value={hq} onChange={(e) => setHq(e.target.value)} />
            <select value={supFilter} onChange={(e) => setSupFilter(e.target.value)} aria-label={t('Поставщик')} style={{ maxWidth: 260 }}>
              <option value="">{t('Все поставщики')}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards zak-table">
            <thead>
              <tr>
                <th>{t('Дата')}</th><th>{t('Поставщик')}</th><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th>
                <th className="num">{t('Цена')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('Оплачено')}</th><th className="num">{t('Долг')}</th><th>{t('Принял')}</th>
              </tr>
            </thead>
            <tbody>
              {pgH.slice.map((r) => (
                <tr key={r.id} className={r.kind === 'pay' ? 'zak-pay' : r.kind === 'ret' ? 'zak-ret' : ''}>
                  <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                  <td data-label={t('Поставщик')}>{supName(r)}</td>
                  <td className="cell-main">
                    {r.kind === 'pay' ? (
                      <span className="zak-pay-name"><LuBanknote size={14} /> {r.name}{r.fromCash && <span className="badge cash" style={{ marginLeft: 6 }}>{t('из кассы')}</span>}</span>
                    ) : <b>{r.name}</b>}
                  </td>
                  <td className="num" data-label={t('Кол-во')}>{r.qty || '—'}</td>
                  <td className="num" data-label={t('Цена')}>{r.kind !== 'pay' ? money(r.price) : '—'}</td>
                  <td className="num" data-label={t('Сумма')}>{r.kind === 'buy' ? <b>{money(r.sum)}</b> : r.kind === 'ret' ? <b>−{money(-r.sum)}</b> : '—'}</td>
                  <td className="num" data-label={t('Оплачено')} style={{ color: r.paid > 0 ? 'var(--green)' : undefined }}>{r.paid < 0 ? '−' + money(-r.paid) : money(r.paid)}</td>
                  <td className="num" data-label={t('Долг')} style={{ color: r.debt > 0 ? 'var(--danger)' : r.debt < 0 ? 'var(--green)' : undefined }}>
                    {r.debt < 0 ? '−' + money(-r.debt) : money(r.debt)}
                  </td>
                  <td data-label={t('Принял')} className="tag-cat">{r.user || '—'}</td>
                </tr>
              ))}
              {zakRows.length === 0 && (
                <tr><td colSpan="9" className="empty">{loadingOlder ? t('Загружаем…') : t('За этот период закупок и оплат нет')}</td></tr>
              )}
            </tbody>
            {zakRows.length > 0 && (
              <tfoot>
                <tr className="zak-total">
                  <td colSpan="5">{t('Итого за период')}</td>
                  <td className="num">{zakItogo.sum < 0 ? '−' + money(-zakItogo.sum) : money(zakItogo.sum)}</td>
                  <td className="num">{zakItogo.paid < 0 ? '−' + money(-zakItogo.paid) : money(zakItogo.paid)}</td>
                  <td className="num">{zakItogo.debt < 0 ? '−' + money(-zakItogo.debt) : money(zakItogo.debt)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <Pagination {...pgH} />
      </div>

      <div className="panel" data-tour="sup.list" style={{ padding: 0 }}>
        <div style={{ padding: '16px 16px 0' }}>
          <h2 style={{ marginBottom: 12 }}><span className="h2-title"><span className="ic"><LuTruck size={17} /></span>{t('Список поставщиков')}</span></h2>
          <div className="toolbar">
            <input className="search" placeholder={t('Поиск по названию или телефону…')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards">
            <thead>
              <tr><th>{t('Поставщик')}</th><th>{t('Телефон')}</th><th className="num">{t('Долг')}</th><th></th></tr>
            </thead>
            <tbody>
              {pg.slice.map((s) => (
                <tr key={s.id}>
                  <td className="cell-main">
                    <b>{s.name}</b>
                    {s.note ? <div className="tag-cat">{s.note}</div> : null}
                  </td>
                  <td data-label={t('Телефон')}>{s.phone || '—'}</td>
                  <td className="num" data-label={t('Долг')}>
                    <span className={'badge ' + ((Number(s.debt) || 0) > 0 ? 'debt' : 'ok')}>{money(s.debt)}</span>
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap', justifyContent: 'flex-end' }}>
                    <button className="btn ghost sm" data-tour="sup.card" onClick={() => setCardId(s.id)}>
                      <span className="ic"><LuHandCoins size={15} /></span> {t('Долг и оплата')}
                    </button>{' '}
                    {can('suppliers.edit') && (
                      <><button className="btn ghost sm icon" onClick={() => setForm({ id: s.id, name: s.name, phone: s.phone || '', note: s.note || '' })} title={t('Изменить')} aria-label={`${t('Изменить')}: ${s.name}`}><LuPencil size={15} /></button>{' '}</>
                    )}
                    {can('suppliers.delete') && (
                      <button className="btn ghost sm icon" onClick={() => remove(s)} title={t('Удалить')} aria-label={`${t('Удалить')}: ${s.name}`}><LuTrash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr><td colSpan="4" className="empty">{suppliers.length ? t('Ничего не найдено') : t('Поставщиков пока нет')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pg} />
      </div>
      </>)}

      {form && (
        <Modal title={form.id ? t('Изменить поставщика') : t('Новый поставщик')} onClose={() => setForm(null)}>
          <div className="field">
            <label htmlFor="supName">{t('Название')}</label>
            <input id="supName" value={form.name} maxLength={120} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder={t('Напр. Опт-Маркет')} />
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="supPhone">{t('Телефон')}</label>
              <input id="supPhone" value={form.phone} maxLength={60} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            {!form.id && (
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="supDebt">{t('Долг на сегодня (сомони)')}</label>
                <NumberInput id="supDebt" value={form.openingDebt} placeholder="0" onChange={(e) => setForm({ ...form, openingDebt: e.target.value })} />
              </div>
            )}
          </div>
          {!form.id && (
            <div className="tag-cat" style={{ marginTop: -6, marginBottom: 12 }}>
              {t('Сколько магазин уже должен этому поставщику. Дальше долг растёт с приходами в долг и уменьшается оплатами.')}
            </div>
          )}
          <div className="field">
            <label htmlFor="supNote">{t('Примечание (необязательно)')}</label>
            <input id="supNote" value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('напр. привозит по вторникам')} />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setForm(null)}>{t('Отмена')}</button>
            <button className="btn" data-tour="sup.save" onClick={save}>{t('Сохранить')}</button>
          </div>
        </Modal>
      )}

      {cardId && <SupplierCard id={cardId} supplier={suppliers.find((s) => s.id === cardId)} onClose={() => setCardId(null)} />}
    </Layout>
  )
}

// ── Карточка поставщика: долг, откуда он взялся, оплата ──
// Оплата и список оплат — общие с вкладкой «Платежи и баланс» прихода (SupplierMoney.jsx)
function SupplierCard({ id, supplier, onClose }) {
  const t = useT()
  const toast = useToast()
  const [card, setCard] = useState(null)

  const load = useCallback(() => {
    api.get('/suppliers/' + id).then(setCard).catch((e) => toast(t(e.message), 'err'))
  }, [id, toast, t])
  useEffect(() => {
    load()
  }, [load])
  // Приход в долг или оплата на другом устройстве — карточка перечитывается
  useEffect(
    () => onChanged((keys) => keys.some((k) => ['suppliers', 'supplierPayments', 'arrivals'].includes(k)) && load()),
    [load],
  )
  const debt = Number(supplier?.debt ?? card?.debt ?? 0)
  const name = supplier?.name || card?.name || ''

  return (
    <Modal wide title={<><span className="ic"><LuTruck size={18} /></span>{name}</>} onClose={onClose}>
      <div className="mini-cards">
        <div className="mini-card"><div className="m-label">{t('Долг сейчас')}</div><div className="m-value sm" style={{ color: debt > 0 ? 'var(--danger)' : undefined }}>{money(debt)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Начальный долг')}</div><div className="m-value sm">{money(card?.openingDebt || 0)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Телефон')}</div><div className="m-value sm">{supplier?.phone || card?.phone || '—'}</div></div>
      </div>

      <SupplierPayPanel supplierId={id} debt={debt} onPaid={load} tour="sup.pay" style={{ marginBottom: 14 }} />

      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>{t('Оплаты')}</h2>
      <div style={{ maxHeight: '32vh', overflow: 'auto', marginBottom: 14 }}>
        {card && <SupplierPaymentsTable payments={card.payments || []} onRemoved={load} />}
      </div>

      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>{t('Приходы от поставщика')}</h2>
      <div style={{ maxHeight: '32vh', overflow: 'auto' }}>
        <table>
          <thead><tr><th>{t('Дата')}</th><th>{t('Кто принял')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('В долг')}</th></tr></thead>
          <tbody>
            {(card?.arrivals || []).map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.date)} <span className="tag-cat">· {a.lines} {t('поз.')}</span></td>
                <td>{a.user?.name || '—'}</td>
                <td className="num">{money(a.total)}</td>
                <td className="num" style={{ color: Number(a.debt) > 0 ? 'var(--danger)' : undefined }}>{money(a.debt)}</td>
              </tr>
            ))}
            {card && !card.arrivals.length && <tr><td colSpan="4" className="empty">{t('Приходов от этого поставщика ещё не было')}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <Link to="/arrivals" className="btn ghost"><span className="ic"><LuPackagePlus size={16} /></span> {t('Приход товара')}</Link>
        <button className="btn" onClick={onClose}>{t('Готово')}</button>
      </div>
    </Modal>
  )
}
