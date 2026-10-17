import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LuWallet, LuPlus, LuPencil, LuTrash2, LuLock, LuBanknote } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter, periodText } from '../components/JournalFilter'
import NumberInput from '../components/NumberInput'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useCan, getUser } from '../db/auth'
import { skachatXlsx } from '../lib/excel'
import { byCategory } from '../lib/svodka'
import { useCollection, money, onChanged } from '../db/store'
import { api } from '../db/api'
import { addExpense, updateExpense, removeExpense } from '../db/ops'
import { dayKey, fmtDate, fmtTime } from '../lib/time'
import { useT } from '../lib/i18n'
import { isDesktop } from '../lib/desktop'
import SalaryPicker, { isZarplata, useStaff, staffName, monthName, ZARPLATA } from '../components/SalaryPicker'
import { mesyacZarplaty, poslednieMesyacy, periodVeren, denText } from '../lib/otchety'

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
  // Зарплата: кому выдаём и за какой месяц. Остальным статьям это не нужно
  const [employeeId, setEmployeeId] = useState('')
  const [salaryMonth, setSalaryMonth] = useState(() => poslednieMesyacy(1)[0])
  // За какие дни бонус от продаж: ставит выбор сотрудника (по его карточке), можно поменять
  const [bonusPeriod, setBonusPeriod] = useState({ from: '', to: '' })

  // Пришли из «Сотрудников» по кнопке «Выдать»: зарплата этому сотруднику за тот
  // месяц уже выбрана, остаётся проверить сумму
  const loc = useLocation()
  const nav = useNavigate()
  const vydat = loc.state?.zarplata
  useEffect(() => {
    if (!vydat || !categories.length) return
    if (categories.some((c) => isZarplata(c.name))) {
      setCategory(ZARPLATA)
      setEmployeeId(vydat.employeeId || '')
      if (vydat.month) setSalaryMonth(vydat.month)
    }
    nav('.', { replace: true, state: null })
  }, [vydat, categories, nav])

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
    textOf: (e) => `${e.category} ${t(e.category)} ${e.note || ''} ${e.user?.name || ''} ${e.employeeName || ''}`,
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
    const zp = isZarplata(category) && employeeId
    if (zp && (bonusPeriod.from || bonusPeriod.to) && !periodVeren(bonusPeriod)) return toast(t('Дата «с» позже даты «по» — поправьте дни бонуса'), 'err')

    setSaving(true)
    try {
      await addExpense({
        date, category, amount: sum, note, fromCash, shiftId: fromCash ? sourceId : null,
        ...(zp ? { employeeId, salaryMonth, ...(periodVeren(bonusPeriod) ? { bonusFrom: bonusPeriod.from, bonusTo: bonusPeriod.to } : {}) } : {}),
      })
      journal.reload()
      setAmount('')
      setNote('')
      setFromCash(false)
      setEmployeeId('')
      setBonusPeriod({ from: '', to: '' })
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

  // ── Выгрузка и печать ──
  // То, что сейчас отобрано в журнале (период, поиск, статья), — все страницы сразу.
  // Под таблицей — сводка по статьям: на что ушли деньги, видно с первого взгляда
  const exCols = [
    { header: t('Дата'), key: 'date', width: 18 },
    { header: t('Статья'), key: 'category', width: 24 },
    { header: t('Кому выдана'), key: 'employee', width: 22 },
    { header: t('За месяц'), key: 'month', width: 16 },
    { header: t('Бонус за дни'), key: 'bonusDays', width: 24 },
    { header: t('Примечание'), key: 'note', width: 34, wrap: true },
    { header: t('Оплата'), key: 'pay', width: 18 },
    { header: t('Кто внёс'), key: 'who', width: 16 },
    { header: t('Сумма'), key: 'amount', width: 14, money: true },
  ]
  const exRows = journalRows.map((e) => ({
    date: e.fromCash ? `${fmtDate(e.date)} ${fmtTime(e.date)}` : fmtDate(e.date),
    category: t(e.category),
    employee: e.employeeName || '',
    month: e.employeeId ? monthName(mesyacZarplaty(e), t) : '',
    bonusDays: e.bonusFrom && e.bonusTo ? `${denText(e.bonusFrom)} – ${denText(e.bonusTo)}` : '',
    note: e.note || '',
    pay: e.fromCash ? `${t('из кассы')}${tillOf(e) ? ' · ' + tillOf(e) : ''}` : '',
    who: e.user?.name || '',
    amount: Number(e.amount) || 0,
  }))
  const exItogi = { date: t('Итого'), amount: periodTotal }
  const exPodzag = [
    `${t('Период')}: ${periodText(journal.controls)}`,
    catFilter !== 'all' ? `${t('Статья')}: ${t(catFilter)}` : '',
    journal.controls.q.trim() ? `${t('Поиск')}: «${journal.controls.q.trim()}»` : '',
    `${t('Записей')}: ${journalRows.length}`,
  ].filter(Boolean).join(' · ')
  const exSvodka = byCategory(journalRows, t, { list: t('По статьям'), zagolovok: t('Расходы по статьям'), podzag: exPodzag })
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Расходы'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Расходы')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi, svodka: exSvodka })

  return (
    <Layout title={t('Расходы')} subtitle={t('Аренда, зарплата и другие траты магазина')} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('Расходы')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} svodka={exSvodka} />
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: вносите сюда всё, на что магазин тратит деньги помимо закупки товара. В «Отчёте ОПУ» расходы вычитаются из прибыли — получается чистая прибыль.')}
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
        {isZarplata(category) && (
          <SalaryPicker
            employeeId={employeeId} setEmployeeId={setEmployeeId} month={salaryMonth} setMonth={setSalaryMonth}
            period={bonusPeriod} setPeriod={setBonusPeriod}
            amount={amount} onAmount={setAmount} tour="exp.salary"
          />
        )}
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
                  {e.employeeName ? <span className="exp-emp"> · {e.employeeName}</span> : null}
                  {e.employeeId ? (
                    <span className="exp-emp">
                      {' · '}{t('за')} {monthName(mesyacZarplaty(e), t)}
                      {e.bonusFrom && e.bonusTo ? <span className="exp-days"> · {t('бонус с')} {denText(e.bonusFrom, true)} {t('по')} {denText(e.bonusTo, true)}</span> : null}
                    </span>
                  ) : null}
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
  const [employeeId, setEmployeeId] = useState(expense.employeeId || '')
  // За какой месяц выдача. У старых выдач месяц не записан — это месяц их даты
  const [salaryMonth, setSalaryMonth] = useState(() => mesyacZarplaty(expense))
  const monthOpts = useMemo(() => [...new Set([mesyacZarplaty(expense), ...poslednieMesyacy(12)])].sort().reverse(), [expense])
  // За какие дни считали бонус (у старых выдач не записано — тогда пусто)
  const [bFrom, setBFrom] = useState(expense.bonusFrom || '')
  const [bTo, setBTo] = useState(expense.bonusTo || '')
  const [saving, setSaving] = useState(false)
  const { staff } = useStaff()

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
    // Сотрудник — только у зарплаты: сменили статью на другую — сотрудник снимается
    const wantEmp = isZarplata(category) ? employeeId : ''
    if (wantEmp !== (expense.employeeId || '')) patch.employeeId = wantEmp
    if (wantEmp && salaryMonth !== mesyacZarplaty(expense)) patch.salaryMonth = salaryMonth
    if (wantEmp && (bFrom !== (expense.bonusFrom || '') || bTo !== (expense.bonusTo || ''))) {
      if ((bFrom || bTo) && !periodVeren({ from: bFrom, to: bTo })) return toast(t('Дата «с» позже даты «по» — поправьте дни бонуса'), 'err')
      patch.bonusFrom = bFrom
      patch.bonusTo = bTo
    }
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
      {isZarplata(category) && (
        <div className="field">
          <label htmlFor="expEditEmp">{t('Кому выдана зарплата')}</label>
          <select id="expEditEmp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{t('— не указан —')}</option>
            {expense.employeeId && !(staff || []).some((u) => u.id === expense.employeeId) && (
              <option value={expense.employeeId}>{expense.employeeName || t('удалённый сотрудник')}</option>
            )}
            {(staff || []).map((u) => <option key={u.id} value={u.id}>{staffName(u)}</option>)}
          </select>
        </div>
      )}
      {isZarplata(category) && employeeId && (
        <div className="field">
          <label htmlFor="expEditMonth">{t('За месяц')}</label>
          <select id="expEditMonth" value={salaryMonth} onChange={(e) => setSalaryMonth(e.target.value)}>
            {monthOpts.map((m) => <option key={m} value={m}>{monthName(m, t)}</option>)}
          </select>
        </div>
      )}
      {isZarplata(category) && employeeId && (
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="expEditFrom">{t('Бонус с')}</label>
            <input id="expEditFrom" type="date" value={bFrom} max={bTo || undefined} onChange={(e) => setBFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="expEditTo">{t('Бонус по')}</label>
            <input id="expEditTo" type="date" value={bTo} min={bFrom || undefined} onChange={(e) => setBTo(e.target.value)} />
          </div>
        </div>
      )}
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
