import { useState, useEffect, useMemo } from 'react'
import { LuTrash2, LuPlus, LuX, LuTriangleAlert } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter } from '../components/JournalFilter'
import { useCollection, money, totalUnits, unitsPerPack } from '../db/store'
import { expiredUnits } from '../lib/units'
import { writeOffGoods } from '../db/ops'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import NumberInput from '../components/NumberInput'

// ── Списание товара ──
// Товар испортился, разбился, просрочился или не нашёлся при пересчёте — его надо
// убрать с остатка и зафиксировать убыток. Списывается партия с ближайшим сроком.

export const REASONS = [
  { key: 'expired', label: 'Просрочен' },
  { key: 'damaged', label: 'Брак или повреждение' },
  { key: 'lost', label: 'Недостача (не нашли)' },
  { key: 'other', label: 'Другое' },
]

export default function WriteOffs() {
  const products = useCollection('products')
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [rows, setRows] = useState([]) // {productId, name, units, max}
  const [pick, setPick] = useState('')
  const [reason, setReason] = useState('expired')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(null) // списание не записалось на сервер
  // Журнал берём из общего слоя данных: он же обновляется мгновенно и по сигналу
  // с других устройств, а страница не ждёт отдельного запроса
  const list = useCollection('writeoffs')
  const [reasonFilter, setReasonFilter] = useState('all')
  const journal = useJournalFilter('writeoffs', {
    textOf: (w) => (w.items || []).map((i) => i.name).join(' ') + ' ' + (w.note || '') + ' ' + (w.user?.name || ''),
  })
  // Причина — свой фильтр: «что мы списали по сроку за месяц» спрашивают чаще всего
  const journalRows = useMemo(
    () => (reasonFilter === 'all' ? journal.rows : journal.rows.filter((w) => w.reason === reasonFilter)),
    [journal.rows, reasonFilter],
  )

  // Товар мог быть выбран заранее со страницы «Срок годности»
  useEffect(() => {
    try {
      const pre = sessionStorage.getItem('writeoff_product')
      if (!pre) return
      sessionStorage.removeItem('writeoff_product')
      const p = products.find((x) => x.id === pre)
      if (p) {
        // Со страницы сроков списывают просрочку, а не весь остаток: у товара
        // рядом с негодной партией обычно лежит и годная, её убирать незачем.
        // Если сервер ещё не посчитал — берём весь остаток, как было раньше.
        const bad = expiredUnits(p)
        setRows([{ productId: p.id, name: p.name, units: bad || totalUnits(p), max: totalUnits(p) }])
        setReason('expired')
      }
    } catch {
      /* нет доступа к хранилищу — не критично */
    }
  }, [products])

  function addRow() {
    const p = products.find((x) => x.id === pick)
    if (!p) return toast(t('Сначала выберите товар из списка'), 'err')
    if (rows.some((r) => r.productId === p.id)) {
      setPick('')
      return toast(t('Этот товар уже добавлен'), 'err')
    }
    setRows([...rows, { productId: p.id, name: p.name, units: 1, max: totalUnits(p) }])
    setPick('')
  }

  const totalCost = useMemo(
    () =>
      rows.reduce((s, r) => {
        const p = products.find((x) => x.id === r.productId)
        return p ? s + (Number(p.cost) / unitsPerPack(p)) * (r.units || 0) : s
      }, 0),
    [rows, products],
  )

  async function submit() {
    if (saving) return
    const bad = rows.find((r) => !r.units || r.units < 1 || r.units > r.max)
    if (bad) return toast(`${bad.name}: ${t('укажите количество не больше остатка')}`, 'err')
    if (!rows.length) return toast(t('Добавьте хотя бы один товар'), 'err')

    const ok = await dialog.confirm({
      title: t('Списать товар?'),
      message: `${t('Товары будут убраны с остатка')}. ${t('Убыток')}: ${money(totalCost)}. ${t('Отменить списание нельзя.')}`,
      danger: true,
      confirmText: t('Списать'),
    })
    if (!ok) return

    setSaving(true)
    const snapshot = { rows, reason, note }
    try {
      // Списание проходит мгновенно: остаток уменьшается сразу, запись уходит в фоне
      const { synced } = writeOffGoods({ items: rows, reason, note })
      setRows([])
      setNote('')
      toast(t('Списано'))
      // Молча терять списание нельзя — это убыток в отчётах
      synced.catch((e) => setFailed({ message: e.message, ...snapshot }))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  const pg = usePagination(journalRows, 10, journal.controls.period + journal.controls.q + reasonFilter)
  const reasonLabel = (k) => t(REASONS.find((r) => r.key === k)?.label || k)
  // Убыток за выбранный период — иначе владельцу пришлось бы складывать вручную
  const periodLoss = useMemo(() => journalRows.reduce((s, w) => s + (Number(w.totalCost) || 0), 0), [journalRows])

  return (
    <Layout title={t('Списание')} subtitle={t('Убрать со склада испорченный или просроченный товар')}>
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: выберите товар, укажите сколько штук убрать со склада и причину. Система спишет партию с ближайшим сроком годности и посчитает убыток.')}
      </div>

      <div className="panel" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" data-tour="wo.pick" style={{ flex: 2 }}>
            <label>{t('Добавить товар')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{t('— выберите товар —')}</option>
                {products.filter((p) => totalUnits(p) > 0).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({t('остаток')} {totalUnits(p)} {t('шт')})</option>
                ))}
              </select>
              <button className="btn icon" onClick={addRow}><LuPlus size={17} /></button>
            </div>
          </div>
          <div className="field" data-tour="wo.reason" style={{ flex: 1 }}>
            <label>{t('Причина')}</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
            </select>
          </div>
        </div>

        {rows.length > 0 && (
          <>
            <table data-tour="wo.rows">
              <thead>
                <tr><th>{t('Товар')}</th><th className="num">{t('Остаток, шт')}</th><th style={{ width: 130 }}>{t('Списать, шт')}</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r, n) => (
                  <tr key={r.productId}>
                    <td><b>{r.name}</b></td>
                    <td className="num">{r.max}</td>
                    <td>
                      <NumberInput
                        integer className="disc-input" value={r.units || ''}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(r.max, Math.trunc(Number(e.target.value) || 0)))
                          setRows((rs) => rs.map((x, i) => (i === n ? { ...x, units: v } : x)))
                        }}
                      />
                    </td>
                    <td className="num">
                      <button className="btn ghost sm icon" onClick={() => setRows((rs) => rs.filter((_, i) => i !== n))}>
                        <LuX size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="field mt" data-tour="wo.note">
              <label>{t('Примечание (необязательно)')}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('напр. разбилась упаковка при приёмке')} />
            </div>
            <div className="total-row big"><span>{t('Убыток')}</span><span style={{ color: 'var(--danger)' }}>{money(totalCost)}</span></div>
            <div className="modal-actions">
              <button className="btn ghost" data-tour="wo.submit" onClick={() => setRows([])} disabled={saving}>{t('Очистить')}</button>
              <button className="btn danger" data-tour="wo.submit" onClick={submit} disabled={saving}>
                <span className="ic"><LuTrash2 size={16} /></span> {saving ? t('Списываем…') : t('Списать')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="panel mt" data-tour="wo.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuTriangleAlert size={17} /></span>{t('История списаний')}</span>
          <span className="tag-cat">{t('убыток за период')}: <b style={{ color: 'var(--danger)' }}>{money(periodLoss)}</b></span>
        </h2>
        <div style={{ padding: '12px 16px 0' }}>
          <JournalFilter controls={journal.controls} placeholder={t('Поиск по товару, примечанию или сотруднику…')}>
            <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="all">{t('Все причины')}</option>
              {REASONS.map((r) => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
            </select>
          </JournalFilter>
          <JournalCount rows={journalRows.length} loading={journal.loading} />
        </div>
        <table>
          <thead>
            <tr><th>{t('Дата')}</th><th>{t('Товары')}</th><th>{t('Причина')}</th><th>{t('Кто')}</th><th className="num">{t('Убыток')}</th></tr>
          </thead>
          <tbody>
            {pg.slice.map((w) => (
              <tr key={w.id}>
                <td>{fmtDateTime(w.date)}</td>
                <td>
                  {w.items.map((i) => `${i.name} ×${i.units}`).join(', ').slice(0, 55)}
                  {w.note ? <div className="tag-cat">{w.note}</div> : null}
                </td>
                <td>{reasonLabel(w.reason)}</td>
                <td>{w.user?.name || '—'}</td>
                <td className="num" style={{ color: 'var(--danger)' }}>{money(w.totalCost)}</td>
              </tr>
            ))}
            {journalRows.length === 0 && !journal.loading && (
              <tr><td colSpan="5" className="empty">{list.length ? t('За выбранный период ничего не найдено') : t('Списаний ещё не было')}</td></tr>
            )}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

      {failed && (
        <Modal
          title={<><span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>{t('Списание не записано')}</>}
          onClose={() => setFailed(null)}
        >
          <div className="note err" style={{ marginBottom: 12 }}>{failed.message}</div>
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
            {t('Остаток на складе восстановлен. Проверьте связь и спишите заново.')}
          </p>
          <div className="modal-actions">
            <button
              className="btn"
              onClick={() => {
                setRows(failed.rows)
                setReason(failed.reason)
                setNote(failed.note)
                setFailed(null)
              }}
            >
              {t('Вернуть список на экран')}
            </button>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
