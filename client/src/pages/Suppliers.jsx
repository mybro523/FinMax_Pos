import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LuTruck, LuPlus, LuPencil, LuTrash2, LuLock, LuBanknote, LuHandCoins, LuPackagePlus, LuCircleDollarSign } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import NumberInput from '../components/NumberInput'
import { useCollection, money, db, onChanged } from '../db/store'
import { api } from '../db/api'
import { paySupplier, removeSupplierPayment } from '../db/ops'
import { fmtDate, fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { useCan } from '../db/auth'
import { isDesktop } from '../lib/desktop'
import ExportPechat from '../components/ExportPechat'
import SupplierDebtsPanel, { useDolgiPostavshikam } from './SupplierDebts'

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

const sourceName = (s, t) => (s.deviceId ? s.deviceName || t('Касса') : t('Касса сайта'))
const defaultSource = (list) => (list.find((s) => !s.deviceId) || list[0])?.shiftId || ''

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
          can('suppliers.edit') && <button className="btn" data-tour="sup.add" onClick={() => setForm({ name: '', phone: '', note: '', openingDebt: '' })}>
            <span className="ic"><LuPlus size={16} /></span> {t('Добавить поставщика')}
          </button>
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
      </div>

      <div className="panel" data-tour="sup.list" style={{ padding: 0 }}>
        <div style={{ padding: '16px 16px 0' }}>
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
function SupplierCard({ id, supplier, onClose }) {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const shifts = useCollection('shifts')
  const [card, setCard] = useState(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [fromCash, setFromCash] = useState(false)
  const [sources, setSources] = useState(null)
  const [sourceId, setSourceId] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api.get('/suppliers/' + id).then(setCard).catch((e) => toast(t(e.message), 'err'))
  }, [id, toast, t])
  const loadSources = useCallback(() => {
    api
      .get('/shifts/cash-sources')
      .then((rows) => setSources(Array.isArray(rows) ? rows : []))
      .catch(() => setSources((prev) => prev || []))
  }, [])
  useEffect(() => {
    load()
    loadSources()
  }, [load, loadSources])
  // Приход в долг или оплата на другом устройстве — карточка перечитывается
  useEffect(
    () =>
      onChanged((keys) => {
        if (keys.some((k) => ['suppliers', 'supplierPayments', 'arrivals'].includes(k))) load()
        if (keys.includes('shifts')) loadSources()
      }),
    [load, loadSources],
  )
  const openShiftId = shifts.find((s) => !s.closedAt)?.id || ''
  useEffect(() => {
    loadSources()
  }, [openShiftId, loadSources])

  const tills = useMemo(() => sources || [], [sources])
  useEffect(() => {
    if (!tills.some((s) => s.shiftId === sourceId)) setSourceId(defaultSource(tills))
    if (sources && !tills.length) setFromCash(false)
  }, [tills, sources, sourceId])

  const closedShifts = useMemo(() => new Map(shifts.filter((s) => s.closedAt).map((s) => [s.id, s])), [shifts])
  const locked = (p) => !!p.fromCash && !!p.shiftId && closedShifts.has(p.shiftId)
  const debt = Number(supplier?.debt ?? card?.debt ?? 0)

  async function pay() {
    if (saving) return
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму оплаты'), 'err')
    if (sum > debt + 0.005) return toast(`${t('Сумма больше долга поставщика')} (${money(debt)})`, 'err')
    if (fromCash && !sourceId) return toast(t('Нет открытой смены — из кассы взять нечего.'), 'err')
    setSaving(true)
    try {
      await paySupplier(id, { amount: sum, note, fromCash, shiftId: fromCash ? sourceId : null })
      setAmount('')
      setNote('')
      setFromCash(false)
      toast(t('Оплата записана'))
      load()
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setSaving(false)
    }
  }

  async function removePayment(p) {
    if (locked(p)) return toast(t('Смена этой оплаты уже закрыта: она вошла в её отчёт и больше не меняется.'), 'err')
    const ok = await dialog.confirm({
      title: t('Отменить оплату?'),
      message: `${money(p.amount)} · ${fmtDateTime(p.date)}. ${t('Долг поставщика вырастет на эту сумму.')}`,
      danger: true,
      confirmText: t('Отменить оплату'),
    })
    if (!ok) return
    try {
      await removeSupplierPayment(p.id)
      toast(t('Оплата отменена'))
      load()
    } catch (e) {
      toast(t(e.message), 'err')
    }
  }

  const noTill = sources !== null && tills.length === 0
  const name = supplier?.name || card?.name || ''

  return (
    <Modal wide title={<><span className="ic"><LuTruck size={18} /></span>{name}</>} onClose={onClose}>
      <div className="mini-cards">
        <div className="mini-card"><div className="m-label">{t('Долг сейчас')}</div><div className="m-value sm" style={{ color: debt > 0 ? 'var(--danger)' : undefined }}>{money(debt)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Начальный долг')}</div><div className="m-value sm">{money(card?.openingDebt || 0)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Телефон')}</div><div className="m-value sm">{supplier?.phone || card?.phone || '—'}</div></div>
      </div>

      <div className="panel" data-tour="sup.pay" style={{ marginBottom: 14 }}>
        <h2><span className="h2-title"><span className="ic"><LuHandCoins size={17} /></span>{t('Оплатить поставщику')}</span></h2>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="supPayAmount">{t('Сумма (сомони)')}</label>
            <NumberInput id="supPayAmount" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pay()} />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="supPayNote">{t('Примечание (необязательно)')}</label>
            <input id="supPayNote" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pay()} placeholder={t('напр. за накладную № 12')} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: noTill ? 'var(--muted)' : undefined }}>
          <input type="checkbox" checked={fromCash} disabled={!tills.length} onChange={(e) => setFromCash(e.target.checked)} style={{ width: 17, height: 17 }} />
          {t('Оплачено из кассы')}
        </label>
        {noTill && (
          <div className="tag-cat" style={{ marginTop: 6 }}>
            {t('Нет открытой смены — из кассы взять нечего.')}{' '}
            <Link to="/shift" className="linklike" style={{ fontSize: 12 }}>{t('Откройте смену')}</Link>
          </div>
        )}
        {fromCash && tills.length > 0 && (
          <div className="tag-cat" style={{ marginTop: 6, lineHeight: 1.6 }}>
            {t('Сумма уменьшит наличные, которые ждут в кассе при закрытии смены.')}
          </div>
        )}
        {fromCash && tills.length > 1 && (
          <div className="field" style={{ maxWidth: 320, marginTop: 10, marginBottom: 0 }}>
            <label htmlFor="supPayTill">{t('Из какой кассы взяты деньги')}</label>
            <select id="supPayTill" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {tills.map((s) => <option key={s.shiftId} value={s.shiftId}>{sourceName(s, t)}</option>)}
            </select>
          </div>
        )}
        {fromCash && tills.length === 1 && tills[0].deviceId && !isDesktop && (
          <div className="tag-cat" style={{ marginTop: 6 }}>{t('Касса')}: <b>{sourceName(tills[0], t)}</b></div>
        )}
        <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          {can('suppliers.pay') && <button className="btn" onClick={pay} disabled={saving || debt <= 0}>
            <span className="ic"><LuBanknote size={16} /></span> {saving ? t('Сохраняем…') : t('Записать оплату')}
          </button>}
          {debt <= 0 && <span className="tag-cat">{t('Долга нет — платить нечего')}</span>}
        </div>
      </div>

      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>{t('Оплаты')}</h2>
      <div style={{ maxHeight: '32vh', overflow: 'auto', marginBottom: 14 }}>
        <table>
          <thead><tr><th>{t('Дата')}</th><th>{t('Кто')}</th><th className="num">{t('Сумма')}</th><th></th></tr></thead>
          <tbody>
            {(card?.payments || []).map((p) => (
              <tr key={p.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {fmtDateTime(p.date)}
                  {p.fromCash && <span className="badge cash" style={{ marginLeft: 8 }}><LuBanknote size={13} /> {t('из кассы')}</span>}
                  {p.note ? <div className="tag-cat">{p.note}</div> : null}
                </td>
                <td>{p.user?.name || '—'}</td>
                <td className="num" style={{ color: 'var(--green)' }}>{money(p.amount)}</td>
                <td className="num">
                  {locked(p) ? (
                    <span className="tag-cat" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><LuLock size={14} /> {t('в отчёте смены')}</span>
                  ) : (
                    can('suppliers.pay') && <button className="btn ghost sm icon" onClick={() => removePayment(p)} title={t('Отменить оплату')} aria-label={`${t('Отменить оплату')} ${money(p.amount)}`}><LuTrash2 size={15} /></button>
                  )}
                </td>
              </tr>
            ))}
            {card && !card.payments.length && <tr><td colSpan="4" className="empty">{t('Оплат ещё не было')}</td></tr>}
          </tbody>
        </table>
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
