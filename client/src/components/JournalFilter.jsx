import { useState, useMemo, useEffect } from 'react'
import { LuSearch } from 'react-icons/lu'
import { useCollection, loadRange, needsServerFor } from '../db/store'
import { startOfDay, startOfDaysAgo } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'

// ── Поиск и период в журналах ──
// В возвратах, списаниях и приходах была только листалка по десять строк. Найти
// «когда приходил вот этот товар» или «что списали в прошлом месяце» можно было
// одним способом — листать. За год работы это сотни страниц.
//
// Здесь и поиск, и период, и подгрузка давних записей с сервера. Устройство
// держит в памяти последние полгода; если спросили глубже, отрезок берётся с
// сервера целиком — так же, как это давно делают Отчёты для продаж.

export const PERIODS = [
  { key: '7', label: '7 дней', days: 6 },
  { key: '30', label: '30 дней', days: 29 },
  { key: '90', label: '3 месяца', days: 89 },
  { key: 'all', label: 'Всё время', days: null },
]

const inRange = (date, from, to) => {
  const t = new Date(date).getTime()
  if (!Number.isFinite(t)) return false
  return (!from || t >= from.getTime()) && (!to || t < to.getTime())
}

// key — раздел общего слоя данных; dateOf/textOf — где у записи дата и по чему искать
export function useJournalFilter(key, { dateOf = (r) => r.date, textOf = () => '' } = {}) {
  const cached = useCollection(key)
  const [period, setPeriod] = useState('30')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [q, setQ] = useState('')
  const [older, setOlder] = useState(null)
  const [loading, setLoading] = useState(false)
  // Отрезок с сервера берётся один раз. Если записи в журнале правят и удаляют
  // (расходы), после правки его надо взять заново — иначе строка давнего периода
  // осталась бы на экране прежней
  const [stamp, setStamp] = useState(0)

  const range = useMemo(() => {
    if (period === 'custom') {
      return {
        from: fromDate ? startOfDay(fromDate) : null,
        to: toDate ? new Date(startOfDay(toDate).getTime() + 86400000) : null,
      }
    }
    const p = PERIODS.find((x) => x.key === period)
    return { from: p && p.days !== null ? startOfDaysAgo(p.days) : null, to: null }
  }, [period, fromDate, toDate])

  // «Всё время» и давние даты лежат глубже кэша — за ними идём на сервер
  const deep = range.from === null || needsServerFor(key, range.from)

  useEffect(() => {
    if (!deep) {
      setOlder(null)
      return
    }
    let cancelled = false
    setLoading(true)
    loadRange(key, range.from, range.to)
      .then((list) => { if (!cancelled) setOlder(list) })
      .catch(() => { if (!cancelled) setOlder(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [key, deep, range.from, range.to, stamp])

  const rows = useMemo(() => {
    const source = deep && older ? older : cached
    const needle = q.trim().toLowerCase()
    return source
      .filter((r) => r && inRange(dateOf(r), range.from, range.to))
      .filter((r) => !needle || String(textOf(r) || '').toLowerCase().includes(needle))
    // dateOf/textOf задаются на месте и при каждом рендере новые — в зависимости
    // их не берём, иначе список пересчитывался бы вхолостую без конца
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cached, older, deep, range, q])

  return {
    rows,
    loading,
    reload: () => setStamp((n) => n + 1),
    // всё, что нужно панели фильтров
    controls: { period, setPeriod, fromDate, setFromDate, toDate, setToDate, q, setQ },
  }
}

export function JournalFilter({ controls, placeholder, children }) {
  const t = useT()
  const { period, setPeriod, fromDate, setFromDate, toDate, setToDate, q, setQ } = controls
  return (
    <div className="journal-filter">
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <input
          className="search"
          placeholder={placeholder || t('Поиск по товару…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {children}
      </div>
      <div className="chips" style={{ marginBottom: 10 }}>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            className={'chip ' + (period === p.key ? 'active' : '')}
            onClick={() => setPeriod(p.key)}
          >
            {t(p.label)}
          </button>
        ))}
      </div>
      <div className="row" style={{ maxWidth: 420, marginBottom: 14, gap: 10, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>{t('С даты')}</label>
          <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPeriod('custom') }} />
        </div>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label>{t('По дату')}</label>
          <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPeriod('custom') }} />
        </div>
      </div>
    </div>
  )
}

// Период словами — для подзаголовка выгрузки и печати: «за 30 дней», «01.10.2026 — 16.10.2026»
export function periodText(controls) {
  const { period, fromDate, toDate } = controls
  const ru = (d) => (d ? d.split('-').reverse().join('.') : '')
  if (period === 'custom') {
    if (fromDate && toDate) return `${ru(fromDate)} — ${ru(toDate)}`
    if (fromDate) return `${tr('с')} ${ru(fromDate)}`
    if (toDate) return `${tr('по')} ${ru(toDate)}`
    return tr('Всё время')
  }
  const p = PERIODS.find((x) => x.key === period)
  return p ? tr(p.label) : ''
}

// Подпись под таблицей: сколько нашли и не идёт ли ещё загрузка
export function JournalCount({ rows, loading, total }) {
  if (loading) return <div className="note info" style={{ marginBottom: 10 }}>{tr('Загружаем историю за выбранный период…')}</div>
  return (
    <div className="tag-cat" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
      <LuSearch size={13} />
      {tr('Найдено записей')}: <b>{rows}</b>
      {typeof total === 'number' && total !== rows ? ` ${tr('из')} ${total}` : ''}
    </div>
  )
}
