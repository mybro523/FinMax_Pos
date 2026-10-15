import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuWallet, LuPlus, LuPencil, LuTrash2, LuLock, LuBanknote } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter } from '../components/JournalFilter'
import NumberInput from '../components/NumberInput'
import { useCan } from '../db/auth'
import { useCollection, money, onChanged } from '../db/store'
import { api } from '../db/api'
import { addExpense, updateExpense, removeExpense } from '../db/ops'
import { dayKey, fmtDate, fmtTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { isDesktop } from '../lib/desktop'

// ── Расходы магазина ──
// Аренда, зарплата, свет, налоги — всё, на что магазин тратит деньги помимо закупки
// товара. Отчёты вычитают расходы из прибыли и показывают чистую прибыль.
//
// Расход бывает оплачен наличными из кассы. Тогда денег в ящике уже нет, и смена
// обязана это знать — иначе при закрытии она «не сойдётся» ровно на эту сумму. Такой
// расход привязывается к открытой смене и живёт по её правилам: дата у него — сейчас,
// а после закрытия смены он остаётся в её отчёте и больше не меняется.

// Касса, из которой берут деньги: смена сайта или смена кассы с программой
const sourceName = (s, t) => (s.deviceId ? s.deviceName || t('Касса') : t('Касса сайта'))

// Из чьего ящика взять деньги по умолчанию: своя касса сайта, а если её смена
// закрыта — первая открытая
const defaultSource = (list) => (list.find((s) => !s.deviceId) || list[0])?.shiftId || ''

export default function Expenses() {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const categories = useCollection('expenseCategories')
  const shifts = useCollection('shifts')
  const list = useCollection('expenses')

  const [date, setDate] = useState(() => dayKey())
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [fromCash, setFromCash] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(null)

  // ── Из какой кассы можно взять деньги ──
  // Открытые смены: сайта и касс с программой. Список держим у себя, а не в общем
  // слое данных: открытые смены касс сайт в свой список смен не берёт
  const [sources, setSources] = useState(null) // null — ещё не знаем
  const loadSources = useCallback(() => {
    api
      .get('/expenses/cash-sources')
      .then((rows) => setSources(Array.isArray(rows) ? rows : []))
      .catch(() => setSources((prev) => prev || []))
  }, [])
  // Смену открыли или закрыли на любом устройстве — список касс уже другой
  useEffect(
    () =>
      onChanged((keys) => {
        if (keys.includes('shifts')) loadSources()
      }),
    [loadSources],
  )
  // При входе на страницу — и когда меняется своя смена: её открывают на соседней
  // странице, и сигнала об этом может не быть (нет постоянного соединения)
  const openShiftId = shifts.find((s) => !s.closedAt)?.id || ''
  useEffect(() => {
    loadSources()
  }, [openShiftId, loadSources])

  const tills = useMemo(() => sources || [], [sources])
  useEffect(() => {
    if (!tills.some((s) => s.shiftId === sourceId)) setSourceId(defaultSource(tills))
    // Смену закрыли, пока форма открыта, — отметка «из кассы» больше не к чему
    if (sources && !tills.length) setFromCash(false)
  }, [tills, sources, sourceId])

  const journal = useJournalFilter('expenses', {
    textOf: (e) => `${e.category} ${t(e.category)} ${e.note || ''} ${e.user?.name || ''}`,
  })
  const [catFilter, setCatFilter] = useState('all')
  const journalRows = useMemo(
    () => (catFilter === 'all' ? journal.rows : journal.rows.filter((e) => e.category === catFilter)),
    [journal.rows, catFilter],
  )
  // Статьи для фильтра: нынешний список и те, что остались только в прежних расходах
  const filterCats = useMemo(
    () => [...new Set([...categories.map((c) => c.name), ...journal.rows.map((e) => e.category)])].filter(Boolean),
    [categories, journal.rows],
  )
  const periodTotal = useMemo(() => journalRows.reduce((s, e) => s + (Number(e.amount) || 0), 0), [journalRows])
  const pg = usePagination(journalRows, 10, journal.controls.period + journal.controls.q + catFilter)

  // Расход из кассы закрытой смены вошёл в её отчёт — его уже не меняют
  const closedShifts = useMemo(() => new Map(shifts.filter((s) => s.closedAt).map((s) => [s.id, s])), [shifts])
  const locked = (e) => !!e.fromCash && !!e.shiftId && closedShifts.has(e.shiftId)
  const tillOf = (e) => closedShifts.get(e.shiftId)?.deviceName || tills.find((s) => s.shiftId === e.shiftId)?.deviceName || ''

  async function submit() {
    if (saving) return
    if (!category) return toast(t('Выберите статью расхода'), 'err')
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму расхода'), 'err')
    if (!fromCash && date > dayKey()) return toast(t('Дата расхода не может быть в будущем'), 'err')
    if (fromCash && !sourceId) return toast(t('Нет открытой смены — из кассы взять нечего.'), 'err')

    setSaving(true)
    try {
      await addExpense({ date, category, amount: sum, note, fromCash, shiftId: fromCash ? sourceId : null })
      journal.reload()
      setAmount('')
      setNote('')
      setFromCash(false)
      toast(t('Расход добавлен'))
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setSaving(false)
    }
  }

  async function remove(e) {
    if (locked(e)) return toast(t('Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.'), 'err')
    const ok = await dialog.confirm({
      title: t('Удалить расход?'),
      message: `«${t(e.category)}» — ${money(e.amount)}. ${e.fromCash ? t('Деньги вернутся в ожидаемые наличные смены.') : t('Он исчезнет из отчётов.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    try {
      await removeExpense(e)
      journal.reload()
      toast(t('Расход удалён'))
    } catch (err) {
      toast(t(err.message), 'err')
    }
  }

  function edit(e) {
    if (locked(e)) return toast(t('Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.'), 'err')
    setEditing(e)
  }

  const noTill = sources !== null && tills.length === 0

  return (
    <Layout title={t('Расходы')} subtitle={t('Аренда, зарплата и другие траты магазина')}>
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: вносите сюда всё, на что магазин тратит деньги помимо закупки товара. В «Отчётах» расходы вычитаются из прибыли — получается чистая прибыль.')}
      </div>

      {can('expenses.create') && <div className="panel" style={{ maxWidth: 900 }}>
        <h2><span className="h2-title"><span className="ic"><LuPlus size={17} /></span>{t('Новый расход')}</span></h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 14px' }}>
          <div className="field" data-tour="exp.date">
            <label htmlFor="expDate">{t('Дата')}</label>
            <input
              id="expDate" type="date" max={dayKey()} disabled={fromCash}
              value={fromCash ? dayKey() : date}
              onChange={(e) => setDate(e.target.value || dayKey())}
            />
          </div>
          <div className="field" data-tour="exp.category">
            <label htmlFor="expCategory">{t('Статья расхода')}</label>
            <select id="expCategory" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('— выберите статью —')}</option>
              {categories.map((c) => <option key={c.id} value={c.name}>{t(c.name)}</option>)}
            </select>
          </div>
          <div className="field" data-tour="exp.amount">
            <label htmlFor="expAmount">{t('Сумма (сомони)')}</label>
            <NumberInput
              id="expAmount" value={amount} placeholder="0"
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="expNote">{t('Примечание (необязательно)')}</label>
          <input
            id="expNote" value={note} maxLength={500} placeholder={t('напр. аренда за октябрь')}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        <div data-tour="exp.cash" style={{ marginBottom: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: noTill ? 'var(--muted)' : undefined }}>
            <input
              type="checkbox" checked={fromCash} disabled={!tills.length}
              onChange={(e) => setFromCash(e.target.checked)}
              style={{ width: 17, height: 17 }}
            />
            {t('Оплачен из кассы')}
          </label>
          {noTill && (
            <div className="tag-cat" style={{ marginTop: 6 }}>
              {t('Нет открытой смены — из кассы взять нечего.')}{' '}
              <Link to="/shift" className="linklike" style={{ fontSize: 12 }}>{t('Откройте смену')}</Link>
            </div>
          )}
          {fromCash && tills.length > 0 && (
            <div className="tag-cat" style={{ marginTop: 6, lineHeight: 1.6 }}>
              {t('Сумма уменьшит наличные, которые ждут в кассе при закрытии смены. Дата такого расхода — сегодня.')}
            </div>
          )}
          {fromCash && tills.length > 1 && (
            <div className="field" style={{ maxWidth: 320, marginTop: 10, marginBottom: 0 }}>
              <label htmlFor="expTill">{t('Из какой кассы взяты деньги')}</label>
              <select id="expTill" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {tills.map((s) => <option key={s.shiftId} value={s.shiftId}>{sourceName(s, t)}</option>)}
              </select>
            </div>
          )}
          {/* На сайте касса одна, но не своя (смена сайта закрыта, открыта смена кассы
              с программой) — называем её. В самой программе касса всегда своя */}
          {fromCash && tills.length === 1 && tills[0].deviceId && !isDesktop && (
            <div className="tag-cat" style={{ marginTop: 6 }}>{t('Касса')}: <b>{sourceName(tills[0], t)}</b></div>
          )}
        </div>

        <div className="tag-cat" style={{ marginBottom: 12 }}>
          {t('Нужной статьи нет в списке?')} <Link to="/settings" className="linklike" style={{ fontSize: 12 }}>{t('Добавьте её в «Настройках»')}</Link>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn" data-tour="exp.add" onClick={submit} disabled={saving}>
            <span className="ic"><LuPlus size={16} /></span> {saving ? t('Сохраняем…') : t('Добавить расход')}
          </button>
        </div>
      </div>

      }

      <div className="panel mt" data-tour="exp.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuWallet size={17} /></span>{t('История расходов')}</span>
          <span className="tag-cat" data-tour="exp.total">{t('расходы за период')}: <b style={{ color: 'var(--danger)' }}>{money(periodTotal)}</b></span>
        </h2>
        <div style={{ padding: '12px 16px 0' }}>
          <JournalFilter controls={journal.controls} placeholder={t('Поиск по статье, примечанию или сотруднику…')}>
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ maxWidth: 220 }} aria-label={t('Статья расхода')}>
              <option value="all">{t('Все статьи')}</option>
              {filterCats.map((c) => <option key={c} value={c}>{t(c)}</option>)}
            </select>
          </JournalFilter>
          <JournalCount rows={journalRows.length} loading={journal.loading} />
        </div>
        {/* На телефоне строки становятся карточками: пять колонок на узком экране
            пришлось бы листать вбок, а кнопки правки стоят как раз с краю */}
        <div className="table-cards-wrap">
        <table className="table-cards">
          <thead>
            <tr><th>{t('Дата')}</th><th>{t('Статья')}</th><th>{t('Кто')}</th><th className="num">{t('Сумма')}</th><th></th></tr>
          </thead>
          <tbody>
            {pg.slice.map((e) => (
              <tr key={e.id}>
                {/* Расход из кассы случился в конкретную минуту смены; обычный — в свой день */}
                <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>
                  <span>
                    {fmtDate(e.date)}
                    {e.fromCash ? <span style={{ color: 'var(--muted-2)', fontSize: 12 }}> · {fmtTime(e.date)}</span> : null}
                  </span>
                </td>
                <td className="cell-main">
                  <b>{t(e.category)}</b>
                  {e.fromCash && (
                    <span className="badge cash" style={{ marginLeft: 8, fontWeight: 500 }}>
                      <LuBanknote size={13} /> {t('из кассы')}{tillOf(e) ? ` · ${tillOf(e)}` : ''}
                    </span>
                  )}
                  {e.note ? <div className="tag-cat">{e.note}</div> : null}
                </td>
                <td data-label={t('Кто')}>{e.user?.name || '—'}</td>
                <td className="num" data-label={t('Сумма')} style={{ color: 'var(--danger)', whiteSpace: 'nowrap' }}>{money(e.amount)}</td>
                <td className="num" style={{ whiteSpace: 'nowrap', justifyContent: 'flex-end' }}>
                  {locked(e) ? (
                    <span className="tag-cat" title={t('Смена закрыта — расход вошёл в её отчёт')} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                      <LuLock size={14} /> {t('в отчёте смены')}
                    </span>
                  ) : (
                    can('expenses.edit') && <>
                      <button className="btn ghost sm icon" onClick={() => edit(e)} title={t('Изменить')} aria-label={t('Изменить')}><LuPencil size={15} /></button>{' '}
                      <button className="btn ghost sm icon" onClick={() => remove(e)} title={t('Удалить')} aria-label={t('Удалить')}><LuTrash2 size={15} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {journalRows.length === 0 && !journal.loading && (
              <tr><td colSpan="5" className="empty">{list.length ? t('За выбранный период ничего не найдено') : t('Расходов ещё не было')}</td></tr>
            )}
          </tbody>
        </table>
        </div>
        <Pagination {...pg} />
      </div>

      {editing && <EditExpense expense={editing} categories={categories} onSaved={journal.reload} onClose={() => setEditing(null)} />}
    </Layout>
  )
}

// ── Правка расхода ──
// Отметку «из кассы» здесь не меняют: расход из кассы привязан к смене, и перенести
// его в другую смену или «вернуть в кассу» — уже другая операция. Ошиблись — расход
// удаляют и вносят заново.
function EditExpense({ expense, categories, onSaved, onClose }) {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(() => dayKey(expense.date))
  const [category, setCategory] = useState(expense.category)
  const [amount, setAmount] = useState(String(expense.amount ?? ''))
  const [note, setNote] = useState(expense.note || '')
  const [saving, setSaving] = useState(false)

  // Статью могли убрать из списка — у этого расхода она остаётся
  const names = useMemo(() => [...new Set([expense.category, ...categories.map((c) => c.name)])].filter(Boolean), [expense.category, categories])

  async function save() {
    if (saving) return
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму расхода'), 'err')
    if (!expense.fromCash && date > dayKey()) return toast(t('Дата расхода не может быть в будущем'), 'err')

    // Отправляем только то, что изменилось: дата, которую не трогали, сохраняет своё время
    const patch = {}
    if (category !== expense.category) patch.category = category
    if (sum !== Number(expense.amount)) patch.amount = Math.round(sum * 100) / 100
    if (note.trim() !== (expense.note || '')) patch.note = note.trim()
    if (!expense.fromCash && date && date !== dayKey(expense.date)) patch.date = date
    if (!Object.keys(patch).length) return onClose()

    setSaving(true)
    try {
      await updateExpense(expense, patch)
      onSaved()
      toast(t('Расход изменён'))
      onClose()
    } catch (e) {
      toast(t(e.message), 'err')
      setSaving(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuPencil size={18} /></span>{t('Изменить расход')}</>} onClose={onClose}>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="expEditDate">{t('Дата')}</label>
          <input id="expEditDate" type="date" max={dayKey()} value={date} disabled={expense.fromCash} onChange={(e) => setDate(e.target.value || dayKey(expense.date))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="expEditAmount">{t('Сумма (сомони)')}</label>
          <NumberInput id="expEditAmount" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
        </div>
      </div>
      {expense.fromCash && (
        <div className="tag-cat" style={{ marginTop: -6, marginBottom: 12 }}>
          {t('Расход оплачен из кассы: его дата — время в смене, её не переносят.')}
        </div>
      )}
      <div className="field">
        <label htmlFor="expEditCategory">{t('Статья расхода')}</label>
        <select id="expEditCategory" value={category} onChange={(e) => setCategory(e.target.value)}>
          {names.map((n) => <option key={n} value={n}>{t(n)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="expEditNote">{t('Примечание (необязательно)')}</label>
        <input id="expEditNote" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('Сохраняем…') : t('Сохранить')}</button>
      </div>
    </Modal>
  )
}
