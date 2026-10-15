import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'
import { dayKey, startOfDay, serverNow, fmtDate } from '../lib/time'
import { loadRange, needsServerFor } from '../db/store'

// ── Период для отчётов и журналов ──
// Быстрые кнопки «Сегодня · Неделя · Месяц · Всё время» применяются сразу. Даты —
// по кнопке «Показать»: пока человек набирает год, цифры не должны прыгать, а
// «год 202» не должен тянуть с сервера всю историю.

export function presetPeriod(kind) {
  const today = dayKey()
  if (kind === 'today') return { kind, from: today, to: today }
  if (kind === 'week') return { kind, from: dayKey(new Date(serverNow().getTime() - 6 * 86400000)), to: today }
  if (kind === 'month') return { kind, from: today.slice(0, 8) + '01', to: today }
  return { kind: 'all', from: '', to: '' }
}

// Период как моменты: [начало первого дня, начало дня после последнего)
export function periodRange(p) {
  return {
    from: p?.from ? startOfDay(p.from) : null,
    to: p?.to ? new Date(startOfDay(p.to).getTime() + 86400000) : null,
  }
}

export function periodText(p, t) {
  if (!p?.from && !p?.to) return t('за всё время')
  const f = p.from ? fmtDate(startOfDay(p.from)) : '…'
  const to = p.to ? fmtDate(startOfDay(p.to)) : '…'
  return f === to ? f : `${f} — ${to}`
}

const PRESETS = [
  ['today', 'Сегодня'],
  ['week', 'Неделя'],
  ['month', 'Месяц'],
  ['all', 'Всё время'],
]

export function PeriodPicker({ value, onChange, tour }) {
  const t = useT()
  const [from, setFrom] = useState(value?.from || '')
  const [to, setTo] = useState(value?.to || '')
  useEffect(() => {
    setFrom(value?.from || '')
    setTo(value?.to || '')
  }, [value?.from, value?.to])
  const dirty = from !== (value?.from || '') || to !== (value?.to || '')

  return (
    <div className="period" data-tour={tour}>
      <div className="chips">
        {PRESETS.map(([k, label]) => (
          <button key={k} type="button" className={'chip ' + (value?.kind === k ? 'active' : '')} onClick={() => onChange(presetPeriod(k))}>
            {t(label)}
          </button>
        ))}
      </div>
      <div className="period-dates">
        <label className="period-f">
          <span>{t('С даты')}</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="period-f">
          <span>{t('По дату')}</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className={'btn' + (dirty ? '' : ' ghost')} onClick={() => onChange({ kind: 'custom', from, to })}>
          {t('Показать')}
        </button>
      </div>
    </div>
  )
}

// ── Данные за период глубже кэша устройства ──
// Устройство держит продажи за 60 дней и журналы за полгода. Период старше —
// догружаем отрезок с сервера, как это делает отчёт ОПУ. untilNow — грузить до
// сегодняшнего дня, а не до конца периода (сверке с поставщиками нужны и оплаты
// после периода, чтобы восстановить долг на его конец).
export function useDeepPeriod(keys, range, { untilNow = false } = {}) {
  const sig = keys.join(',')
  const fromMs = range.from ? range.from.getTime() : 0
  const toMs = range.to ? range.to.getTime() : 0
  const need = keys.filter((k) => needsServerFor(k, range.from || new Date(0)))
  const needSig = need.join(',')
  const [deep, setDeep] = useState({})
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const wanted = needSig ? needSig.split(',') : []
    if (!wanted.length) {
      setDeep({})
      return
    }
    let cancelled = false
    setLoading(true)
    const from = fromMs ? new Date(fromMs) : null
    const to = untilNow || !toMs ? null : new Date(toMs)
    Promise.all(wanted.map((k) => loadRange(k, from, to).catch(() => null)))
      .then((arr) => { if (!cancelled) setDeep(Object.fromEntries(wanted.map((k, i) => [k, arr[i]]))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sig, needSig, fromMs, toMs, untilNow])
  return { deep, loading }
}
