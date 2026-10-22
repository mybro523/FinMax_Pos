import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { LuTrash2, LuX, LuTriangleAlert, LuCamera, LuScanLine } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter, periodText } from '../components/JournalFilter'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useCollection, money, totalUnits, unitsPerPack, stockText } from '../db/store'
import { expiredUnits, isVesovoy, kgText, edinica } from '../lib/units'
import { writeOffGoods, findByBarcode } from '../db/ops'
import { parseVesEtiketku, productPoVesKodu } from '../lib/vesy'
import { beepOk, beepError, unlockAudio } from '../lib/sound'
import { skachatXlsx } from '../lib/excel'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { shtrihkodyPoId } from '../lib/poisk'
import NumberInput from '../components/NumberInput'
import VesInput from '../components/VesInput'
import { useCan, getUser } from '../db/auth'

const CameraScanner = lazy(() => import('../components/CameraScanner'))

// ── Списание товара ──
// Товар испортился, разбился, просрочился или не нашёлся при пересчёте — его надо
// убрать с остатка и зафиксировать убыток. Списывается партия с ближайшим сроком.
//
// Товар находят одним полем, как в кассе: набирают название или штрихкод — ниже
// подсказки; USB-сканер «печатает» код и Enter — товар встаёт в список сразу; на
// телефоне есть камера. Тот же товар отсканировали ещё раз — к нему прибавляется
// штука (не больше остатка): так списывают по одной разбитой упаковке.

export const REASONS = [
  { key: 'expired', label: 'Просрочен' },
  { key: 'damaged', label: 'Брак или повреждение' },
  { key: 'lost', label: 'Недостача (не нашли)' },
  { key: 'other', label: 'Другое' },
]

export default function WriteOffs() {
  const can = useCan()
  const products = useCollection('products')
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [rows, setRows] = useState([]) // {productId, name, units, max}
  const [code, setCode] = useState('') // поле поиска: название, штрихкод или скан
  const [hi, setHi] = useState(0) // подсвеченная подсказка
  const [open, setOpen] = useState(false) // подсказки видны, пока поле в фокусе
  const [camera, setCamera] = useState(false)
  const scanRef = useRef(null)
  // Сканер стреляет быстрее, чем экран успевает обновиться: второй скан того же
  // товара должен видеть строку, добавленную первым, а не прежний список
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const [reason, setReason] = useState('expired')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(null) // списание не записалось на сервер
  // Журнал берём из общего слоя данных: он же обновляется мгновенно и по сигналу
  // с других устройств, а страница не ждёт отдельного запроса
  const list = useCollection('writeoffs')
  const [reasonFilter, setReasonFilter] = useState('all')
  // Поиск находит и по штрихкоду (в том числе сканом маркировки): имя товара в строке
  // списания уже есть, а штрихкод достаём из карточки товара по его id
  const barcodeById = useMemo(() => shtrihkodyPoId(products), [products])
  const journal = useJournalFilter('writeoffs', {
    textOf: (w) => (w.items || []).map((i) => i.name).join(' ') + ' ' + (w.note || '') + ' ' + (w.user?.name || ''),
    codesOf: (w) => (w.items || []).map((i) => barcodeById.get(i.productId)),
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
        setRows([{ productId: p.id, name: p.name, units: bad || totalUnits(p), max: totalUnits(p), ves: isVesovoy(p), unit: edinica(p) }])
        setReason('expired')
      }
    } catch {
      /* нет доступа к хранилищу — не критично */
    }
  }, [products])

  // ── Поиск товара ──
  // Подсказки — только то, что есть на складе: списывать отсутствующее нечего
  const matches = (v) => {
    const q = String(v || '').trim().toLowerCase()
    if (!q) return []
    return products
      .filter((p) => totalUnits(p) > 0 && (String(p.name || '').toLowerCase().includes(q) || String(p.barcode || '').includes(q)))
      .slice(0, 8)
  }
  // Считаем от текущего списка товаров: набранное до прихода данных тоже найдётся
  const suggest = useMemo(() => matches(code), [code, products]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setHi(0), [code])

  // grams — вес с весовой этикетки (кг-товар): тогда в строку встаёт он
  function addProduct(p, grams) {
    const max = totalUnits(p)
    if (max <= 0) {
      beepError()
      return toast(`«${p.name}» — ${t('на складе нет, списывать нечего')}`, 'err')
    }
    const ves = isVesovoy(p)
    const add = ves ? Math.max(1, Math.round(grams || 1000)) : 1
    const cur = rowsRef.current
    const was = cur.find((r) => r.productId === p.id)
    if (was) {
      if (was.units >= was.max) {
        beepError()
        return toast(`«${p.name}»: ${t('больше, чем есть на складе, не списать')}`, 'err')
      }
      // Тот же товар ещё раз — ещё одна штука (или ещё один вес с этикетки)
      const next = cur.map((r) => (r.productId === p.id ? { ...r, units: Math.min(r.max, (r.units || 0) + add) } : r))
      rowsRef.current = next
      setRows(next)
      beepOk()
      toast(`«${p.name}»: +${ves ? `${kgText(add)} ${t(edinica(p))}` : `1 ${t('шт')}`}`)
      return
    }
    const next = [...cur, { productId: p.id, name: p.name, units: Math.min(max, add), max, ves, unit: edinica(p) }]
    rowsRef.current = next
    setRows(next)
    beepOk()
  }

  // Разбирает то, что пришло из сканера или камеры, или было набрано руками.
  // pick — подсказка, на которой стоит выбор (Enter по набранному названию)
  function addByCode(raw, pick) {
    const val = String(raw || '').trim()
    if (!val) return
    setCode('')
    const p = findByBarcode(val) // понимает и обычный штрихкод, и DataMatrix/QR маркировки
    if (p) return void addProduct(p)
    // Весовая этикетка: код товара и вес в одном штрихкоде
    const ves = parseVesEtiketku(val)
    if (ves) {
      const wp = productPoVesKodu(products, ves.code)
      if (wp) return void addProduct(wp, ves.grams)
    }
    // Набрали название, а не код — берём выбранную подсказку
    const list = matches(val)
    if (list.length && val.replace(/[^0-9]/g, '').length < 6) return void addProduct(pick && list.includes(pick) ? pick : list[0])
    beepError()
    toast(`${t('Товар не найден')}: ${val}`, 'err')
  }

  function onScanKey(e) {
    if (e.key === 'ArrowDown' && suggest.length) {
      e.preventDefault()
      setHi((h) => Math.min(suggest.length - 1, h + 1))
    } else if (e.key === 'ArrowUp' && suggest.length) {
      e.preventDefault()
      setHi((h) => Math.max(0, h - 1))
    } else if (e.key === 'Escape') {
      setCode('')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addByCode(code, suggest[hi])
    }
  }

  function onCameraDetect(raw) {
    setCamera(false)
    addByCode(raw)
    setTimeout(() => scanRef.current?.focus(), 0)
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

  // ── Выгрузка и печать ──
  // То, что отобрано в истории (период, поиск, причина), — все страницы сразу.
  // Над таблицей — сводка по причинам: сколько ушло по сроку, сколько на бой
  const unitsText = (i) => {
    const p = products.find((x) => x.id === i.productId)
    return p && isVesovoy(p) ? `${kgText(i.units)} ${t(edinica(p))}` : `${i.units} ${t('шт')}`
  }
  const exCols = [
    { header: t('Дата'), key: 'date', width: 18 },
    { header: t('Товары'), key: 'items', width: 46, wrap: true },
    { header: t('Причина'), key: 'reason', width: 22 },
    { header: t('Примечание'), key: 'note', width: 28, wrap: true },
    { header: t('Кто'), key: 'who', width: 14 },
    { header: t('Убыток'), key: 'loss', width: 14, money: true },
  ]
  const exRows = journalRows.map((w) => ({
    date: fmtDateTime(w.date),
    items: (w.items || []).map((i) => `${i.name} ×${unitsText(i)}`).join(', '),
    reason: reasonLabel(w.reason),
    note: w.note || '',
    who: w.user?.name || '',
    loss: Number(w.totalCost) || 0,
  }))
  const exItogi = { date: t('Итого'), loss: Math.round(periodLoss * 100) / 100 }
  const exPodzag = [
    `${t('Период')}: ${periodText(journal.controls)}`,
    reasonFilter !== 'all' ? `${t('Причина')}: ${reasonLabel(reasonFilter)}` : '',
    journal.controls.q.trim() ? `${t('Поиск')}: «${journal.controls.q.trim()}»` : '',
    `${t('Записей')}: ${journalRows.length}`,
  ].filter(Boolean).join(' · ')
  const exSvodka = {
    list: t('По причинам'),
    zagolovok: t('Убыток по причинам'),
    podzag: exPodzag,
    cols: [
      { header: t('Причина'), key: 'reason', width: 26 },
      { header: t('Списаний'), key: 'count', width: 12, num: true },
      { header: t('Убыток'), key: 'loss', width: 14, money: true },
    ],
    rows: REASONS.map((r) => {
      const sp = journalRows.filter((w) => w.reason === r.key)
      return { reason: t(r.label), count: sp.length, loss: Math.round(sp.reduce((s, w) => s + (Number(w.totalCost) || 0), 0) * 100) / 100 }
    }).filter((r) => r.count > 0),
    itogi: { reason: t('Итого'), count: journalRows.length, loss: Math.round(periodLoss * 100) / 100 },
  }
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Списание'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Списание')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi, svodka: exSvodka })

  return (
    <Layout title={t('Списание')} subtitle={t('Убрать со склада испорченный или просроченный товар')} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('Списание')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} svodka={exSvodka} />
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: найдите товар по названию, штрихкоду или сканером, укажите сколько штук убрать со склада и причину. Система спишет партию с ближайшим сроком годности и посчитает убыток.')}
      </div>

      {can('writeoffs.create') && <div className="panel" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field wo-search" data-tour="wo.pick" style={{ flex: 2, minWidth: 260 }}>
            <label htmlFor="woScan">{t('Добавить товар')}</label>
            <div className="wo-search-box">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="woScan"
                ref={scanRef}
                className="scan-input"
                value={code}
                autoComplete="off"
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={onScanKey}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                placeholder={t('Название, штрихкод или сканер…')}
                aria-label={t('Найдите товар: название, штрихкод или сканер')}
              />
              <button type="button" className="btn ghost" data-tour="wo.camera" title={t('Камера')} aria-label={t('Камера')} onClick={() => { unlockAudio(); setCamera(true) }}>
                <span className="ic"><LuCamera size={17} /></span> <span className="cam-text">{t('Камера')}</span>
              </button>
            </div>
            {open && suggest.length > 0 && (
              <div className="wo-suggest" role="listbox">
                {suggest.map((p, n) => (
                  <button
                    type="button"
                    key={p.id}
                    role="option"
                    aria-selected={n === hi}
                    className={'wo-sug' + (n === hi ? ' on' : '')}
                    // mousedown, а не click: поле не успевает потерять фокус и спрятать список
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addProduct(p)
                      setCode('')
                    }}
                  >
                    <span className="wo-sug-name">{p.name}<span className="tag-cat">{p.barcode}</span></span>
                    <span className="tag-cat">{t('остаток')} {stockText(p)}</span>
                  </button>
                ))}
              </div>
            )}
            </div>
            <div className="scan-hint">
              <span className="ic"><LuScanLine size={15} /></span>
              {t('USB-сканер работает как клавиатура. Тот же товар ещё раз — плюс одна штука')}
            </div>
          </div>
          <div className="field" data-tour="wo.reason" style={{ flex: 1 }}>
            <label>{t('Причина')}</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
            </select>
          </div>
          {reason === 'other' && (
            /* «Другое» без пояснения ничего не скажет через месяц — поле тут же */
            <div className="field" style={{ flex: 2, minWidth: 220 }}>
              <label>{t('Какая причина?')}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('напр. угостили покупателя')} />
            </div>
          )}
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
                    <td className="num">{r.ves ? `${kgText(r.max)} ${t(r.unit || 'кг')}` : r.max}</td>
                    <td>
                      {r.ves ? (
                        <VesInput
                          className="disc-input"
                          grams={r.units || 0}
                          onGrams={(g) => {
                            const v = Math.max(0, Math.min(r.max, g))
                            setRows((rs) => rs.map((x, i) => (i === n ? { ...x, units: v } : x)))
                          }}
                        />
                      ) : (
                        <NumberInput
                          integer className="disc-input" value={r.units || ''}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(r.max, Math.trunc(Number(e.target.value) || 0)))
                            setRows((rs) => rs.map((x, i) => (i === n ? { ...x, units: v } : x)))
                          }}
                        />
                      )}
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

      }

      <div className="panel mt" data-tour="wo.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuTriangleAlert size={17} /></span>{t('История списаний')}</span>
          <span className="tag-cat">{t('убыток за период')}: <b style={{ color: 'var(--danger)' }}>{money(periodLoss)}</b></span>
        </h2>
        <div style={{ padding: '12px 16px 0' }}>
          <JournalFilter controls={journal.controls} placeholder={t('Товар, штрихкод, примечание или сотрудник…')}>
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

      {camera && (
        <Suspense fallback={
          <div className="overlay" onClick={() => setCamera(false)}>
            <div className="modal" style={{ maxWidth: 320, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
              <div className="empty">{t('Запуск камеры…')}</div>
            </div>
          </div>
        }>
          <CameraScanner onDetect={onCameraDetect} onClose={() => setCamera(false)} />
        </Suspense>
      )}

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
