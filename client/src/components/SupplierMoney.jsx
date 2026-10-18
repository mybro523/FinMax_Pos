import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuBanknote, LuHandCoins, LuLock, LuTrash2 } from 'react-icons/lu'
import { useToast, useDialog } from './ui'
import NumberInput from './NumberInput'
import { useCollection, money, onChanged } from '../db/store'
import { api } from '../db/api'
import { paySupplier, removeSupplierPayment } from '../db/ops'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { useCan } from '../db/auth'
import { isDesktop } from '../lib/desktop'

// ── Деньги поставщику: оплата долга и список оплат ──
// Одни и те же в карточке поставщика (раздел «Поставщики») и на вкладке «Платежи и
// баланс» прихода товара — чтобы оплата записывалась и отменялась одинаково.
//
// Оплата поставщику — не расход: товар уже учтён при продаже по закупочной цене.
// Но если деньги взяты из ящика кассы, смена обязана это знать — такая оплата
// привязана к открытой смене и отменяется, только пока смена открыта.

export const sourceName = (s, t) => (s.deviceId ? s.deviceName || t('Касса') : t('Касса сайта'))
const defaultSource = (list) => (list.find((s) => !s.deviceId) || list[0])?.shiftId || ''

// Открытые смены, из ящика которых можно взять деньги
export function useCashSources() {
  const shifts = useCollection('shifts')
  const [sources, setSources] = useState(null)
  const load = useCallback(() => {
    api
      .get('/shifts/cash-sources')
      .then((rows) => setSources(Array.isArray(rows) ? rows : []))
      .catch(() => setSources((prev) => prev || []))
  }, [])
  useEffect(() => onChanged((keys) => keys.includes('shifts') && load()), [load])
  const openShiftId = shifts.find((s) => !s.closedAt)?.id || ''
  useEffect(() => {
    load()
  }, [openShiftId, load])
  return sources
}

// ── Оплатить поставщику ──
// debt — нынешний долг: больше него заплатить нельзя. onPaid — после записи
export function SupplierPayPanel({ supplierId, debt, onPaid, tour = 'sup.pay', className = 'panel', style }) {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const sources = useCashSources()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [fromCash, setFromCash] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [saving, setSaving] = useState(false)

  const tills = useMemo(() => sources || [], [sources])
  useEffect(() => {
    if (!tills.some((s) => s.shiftId === sourceId)) setSourceId(defaultSource(tills))
    if (sources && !tills.length) setFromCash(false)
  }, [tills, sources, sourceId])

  async function pay() {
    if (saving) return
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму оплаты'), 'err')
    if (sum > debt + 0.005) return toast(`${t('Сумма больше долга поставщика')} (${money(debt)})`, 'err')
    if (fromCash && !sourceId) return toast(t('Нет открытой смены — из кассы взять нечего.'), 'err')
    setSaving(true)
    try {
      await paySupplier(supplierId, { amount: sum, note, fromCash, shiftId: fromCash ? sourceId : null })
      setAmount('')
      setNote('')
      setFromCash(false)
      toast(t('Оплата записана'))
      onPaid?.()
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setSaving(false)
    }
  }

  const noTill = sources !== null && tills.length === 0
  return (
    <div className={className} data-tour={tour} style={style}>
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
  )
}

// ── Оплаты поставщику ──
// Оплату из кассы, чья смена уже закрыта, отменить нельзя: она вошла в отчёт смены.
// onRemoved — после отмены. empty — текст, когда оплат нет
export function SupplierPaymentsTable({ payments, onRemoved, empty, withSupplier = false }) {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const shifts = useCollection('shifts')
  const closedShifts = useMemo(() => new Map(shifts.filter((s) => s.closedAt).map((s) => [s.id, s])), [shifts])
  const locked = (p) => !!p.fromCash && !!p.shiftId && closedShifts.has(p.shiftId)

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
      onRemoved?.()
    } catch (e) {
      toast(t(e.message), 'err')
    }
  }

  return (
    <table>
      <thead><tr><th>{t('Дата')}</th>{withSupplier && <th>{t('Поставщик')}</th>}<th>{t('Кто')}</th><th className="num">{t('Сумма')}</th><th></th></tr></thead>
      <tbody>
        {payments.map((p) => (
          <tr key={p.id}>
            <td style={{ whiteSpace: 'nowrap' }}>
              {fmtDateTime(p.date)}
              {p.fromCash && <span className="badge cash" style={{ marginLeft: 8 }}><LuBanknote size={13} /> {t('из кассы')}</span>}
              {p.note ? <div className="tag-cat">{p.note}</div> : null}
            </td>
            {withSupplier && <td>{p.supplier?.name || '—'}</td>}
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
        {!payments.length && <tr><td colSpan={withSupplier ? 5 : 4} className="empty">{empty || t('Оплат ещё не было')}</td></tr>}
      </tbody>
    </table>
  )
}
