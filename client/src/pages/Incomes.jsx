import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuCoins, LuPlus, LuPencil, LuTrash2 } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter, periodText } from '../components/JournalFilter'
import NumberInput from '../components/NumberInput'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useCan, getUser } from '../db/auth'
import { useCollection, money } from '../db/store'
import { addIncome, updateIncome, removeIncome } from '../db/ops'
import { dayKey, fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import { skachatXlsx } from '../lib/excel'
import { byCategory } from '../lib/svodka'

// ── Доходы вне продаж ──
// Деньги, которые магазин получает не за проданный товар: сдал часть помещения,
// оказал услугу, получил бонус от поставщика. «Отчёт ОПУ» прибавляет их к чистому
// доходу. В денежный ящик смены доход не попадает: наличные, положенные в ящик,
// вносятся в «Смене» кнопкой «Внести». Поэтому у дохода нет отметки «в кассу»,
// и правится он когда угодно.
export default function Incomes() {
  const can = useCan()
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const categories = useCollection('incomeCategories')
  const list = useCollection('incomes')

  const [date, setDate] = useState(() => dayKey())
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(null)

  const journal = useJournalFilter('incomes', {
    textOf: (e) => `${e.category} ${t(e.category)} ${e.note || ''} ${e.user?.name || ''}`,
  })
  const [catFilter, setCatFilter] = useState('all')
  const journalRows = useMemo(
    () => (catFilter === 'all' ? journal.rows : journal.rows.filter((e) => e.category === catFilter)),
    [journal.rows, catFilter],
  )
  // Статьи для фильтра: нынешний список и те, что остались только в прежних доходах
  const filterCats = useMemo(
    () => [...new Set([...categories.map((c) => c.name), ...journal.rows.map((e) => e.category)])].filter(Boolean),
    [categories, journal.rows],
  )
  const periodTotal = useMemo(() => journalRows.reduce((s, e) => s + (Number(e.amount) || 0), 0), [journalRows])
  const pg = usePagination(journalRows, 10, journal.controls.period + journal.controls.q + catFilter)

  async function submit() {
    if (saving) return
    if (!category) return toast(t('Выберите статью дохода'), 'err')
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму дохода'), 'err')
    if (date > dayKey()) return toast(t('Дата дохода не может быть в будущем'), 'err')

    setSaving(true)
    try {
      await addIncome({ date, category, amount: sum, note })
      journal.reload()
      setAmount('')
      setNote('')
      toast(t('Доход добавлен'))
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setSaving(false)
    }
  }

  async function remove(e) {
    const ok = await dialog.confirm({
      title: t('Удалить доход?'),
      message: `«${t(e.category)}» — ${money(e.amount)}. ${t('Он исчезнет из отчётов.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    try {
      await removeIncome(e)
      journal.reload()
      toast(t('Доход удалён'))
    } catch (err) {
      toast(t(err.message), 'err')
    }
  }

  // ── Выгрузка и печать ──
  // То, что отобрано в журнале (период, поиск, статья), — все страницы сразу, и сводка
  // по статьям: откуда пришли деньги
  const exCols = [
    { header: t('Дата'), key: 'date', width: 14 },
    { header: t('Статья'), key: 'category', width: 26 },
    { header: t('Примечание'), key: 'note', width: 40, wrap: true },
    { header: t('Кто внёс'), key: 'who', width: 16 },
    { header: t('Сумма'), key: 'amount', width: 14, money: true },
  ]
  const exRows = journalRows.map((e) => ({
    date: fmtDate(e.date),
    category: t(e.category),
    note: e.note || '',
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
  const exSvodka = byCategory(journalRows, t, { list: t('По статьям'), zagolovok: t('Доходы по статьям'), podzag: exPodzag })
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Доходы'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Доходы')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi, svodka: exSvodka })

  return (
    <Layout title={t('Доходы')} subtitle={t('Деньги, полученные не от продаж')} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={t('Доходы')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} svodka={exSvodka} />
      <div className="note info" style={{ marginBottom: 16, maxWidth: 780 }}>
        {t('Как это работает: вносите сюда деньги, которые магазин получил не за проданный товар: аренду, услуги, бонусы поставщиков. В «Отчёте ОПУ» они прибавляются к чистому доходу. Наличные, положенные в кассу, внесите ещё и в «Смене» кнопкой «Внести».')}
      </div>

      {can('incomes.create') && (
        <div className="panel" style={{ maxWidth: 900 }}>
          <h2><span className="h2-title"><span className="ic"><LuPlus size={17} /></span>{t('Новый доход')}</span></h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 14px' }}>
            <div className="field" data-tour="inc.date">
              <label htmlFor="incDate">{t('Дата')}</label>
              <input id="incDate" type="date" max={dayKey()} value={date} onChange={(e) => setDate(e.target.value || dayKey())} />
            </div>
            <div className="field" data-tour="inc.category">
              <label htmlFor="incCategory">{t('Статья дохода')}</label>
              <select id="incCategory" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">{t('— выберите статью —')}</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{t(c.name)}</option>)}
              </select>
            </div>
            <div className="field" data-tour="inc.amount">
              <label htmlFor="incAmount">{t('Сумма (сомони)')}</label>
              <NumberInput
                id="incAmount" value={amount} placeholder="0"
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="incNote">{t('Примечание (необязательно)')}</label>
            <input
              id="incNote" value={note} maxLength={500} placeholder={t('напр. аренда склада за октябрь')}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {t('Нужной статьи нет в списке?')} <Link to="/settings" className="linklike" style={{ fontSize: 12 }}>{t('Добавьте её в «Настройках»')}</Link>
          </div>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" data-tour="inc.add" onClick={submit} disabled={saving}>
              <span className="ic"><LuPlus size={16} /></span> {saving ? t('Сохраняем…') : t('Добавить доход')}
            </button>
          </div>
        </div>
      )}

      <div className="panel mt" data-tour="inc.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuCoins size={17} /></span>{t('История доходов')}</span>
          <span className="tag-cat" data-tour="inc.total">{t('доходы за период')}: <b style={{ color: 'var(--green)' }}>{money(periodTotal)}</b></span>
        </h2>
        <div style={{ padding: '12px 16px 0' }}>
          <JournalFilter controls={journal.controls} placeholder={t('Поиск по статье или примечанию…')}>
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ maxWidth: 220 }} aria-label={t('Статья дохода')}>
              <option value="all">{t('Все статьи')}</option>
              {filterCats.map((c) => <option key={c} value={c}>{t(c)}</option>)}
            </select>
          </JournalFilter>
          <JournalCount rows={journalRows.length} loading={journal.loading} />
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards">
            <thead>
              <tr><th>{t('Дата')}</th><th>{t('Статья')}</th><th>{t('Кто')}</th><th className="num">{t('Сумма')}</th><th></th></tr>
            </thead>
            <tbody>
              {pg.slice.map((e) => (
                <tr key={e.id}>
                  <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</td>
                  <td className="cell-main">
                    <b>{t(e.category)}</b>
                    {e.note ? <div className="tag-cat">{e.note}</div> : null}
                  </td>
                  <td data-label={t('Кто')}>{e.user?.name || '—'}</td>
                  <td className="num" data-label={t('Сумма')} style={{ color: 'var(--green)', whiteSpace: 'nowrap' }}>{money(e.amount)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap', justifyContent: 'flex-end' }}>
                    {can('incomes.edit') && <>
                      <button className="btn ghost sm icon" onClick={() => setEditing(e)} title={t('Изменить')} aria-label={t('Изменить')}><LuPencil size={15} /></button>{' '}
                      <button className="btn ghost sm icon" onClick={() => remove(e)} title={t('Удалить')} aria-label={t('Удалить')}><LuTrash2 size={15} /></button>
                    </>}
                  </td>
                </tr>
              ))}
              {journalRows.length === 0 && !journal.loading && (
                <tr><td colSpan="5" className="empty">{list.length ? t('За выбранный период ничего не найдено') : t('Доходов ещё не было')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pg} />
      </div>

      {editing && <EditIncome income={editing} categories={categories} onSaved={journal.reload} onClose={() => setEditing(null)} />}
    </Layout>
  )
}

// ── Правка дохода ──
function EditIncome({ income, categories, onSaved, onClose }) {
  const t = useT()
  const toast = useToast()
  const [date, setDate] = useState(() => dayKey(income.date))
  const [category, setCategory] = useState(income.category)
  const [amount, setAmount] = useState(String(income.amount ?? ''))
  const [note, setNote] = useState(income.note || '')
  const [saving, setSaving] = useState(false)

  // Статью могли убрать из списка — у этого дохода она остаётся
  const names = useMemo(() => [...new Set([income.category, ...categories.map((c) => c.name)])].filter(Boolean), [income.category, categories])

  async function save() {
    if (saving) return
    const sum = Number(amount)
    if (!(sum > 0)) return toast(t('Укажите сумму дохода'), 'err')
    if (date > dayKey()) return toast(t('Дата дохода не может быть в будущем'), 'err')

    // Отправляем только то, что изменилось: дата, которую не трогали, сохраняет своё время
    const patch = {}
    if (category !== income.category) patch.category = category
    if (sum !== Number(income.amount)) patch.amount = Math.round(sum * 100) / 100
    if (note.trim() !== (income.note || '')) patch.note = note.trim()
    if (date && date !== dayKey(income.date)) patch.date = date
    if (!Object.keys(patch).length) return onClose()

    setSaving(true)
    try {
      await updateIncome(income, patch)
      onSaved()
      toast(t('Доход изменён'))
      onClose()
    } catch (e) {
      toast(t(e.message), 'err')
      setSaving(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuPencil size={18} /></span>{t('Изменить доход')}</>} onClose={onClose}>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="incEditDate">{t('Дата')}</label>
          <input id="incEditDate" type="date" max={dayKey()} value={date} onChange={(e) => setDate(e.target.value || dayKey(income.date))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="incEditAmount">{t('Сумма (сомони)')}</label>
          <NumberInput id="incEditAmount" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
        </div>
      </div>
      <div className="field">
        <label htmlFor="incEditCategory">{t('Статья дохода')}</label>
        <select id="incEditCategory" value={category} onChange={(e) => setCategory(e.target.value)}>
          {names.map((n) => <option key={n} value={n}>{t(n)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="incEditNote">{t('Примечание (необязательно)')}</label>
        <input id="incEditNote" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('Сохраняем…') : t('Сохранить')}</button>
      </div>
    </Modal>
  )
}
