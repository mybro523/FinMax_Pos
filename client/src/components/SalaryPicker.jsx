import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../db/api'
import { useCollection, money } from '../db/store'
import { useT } from '../lib/i18n'
import { fmtDate, dayKey } from '../lib/time'
import { useDeepPeriod } from './Period'
import {
  mesyac, poslednieMesyacy, prodazhiSotrudnika, zarplataKVydache, vydachiZaMesyac, ostatokZarplaty,
  periodZarplaty, dniKMomentam, periodVeren, denText,
} from '../lib/otchety'

// ── Кому выдаём зарплату ──
// Появляется в расходе со статьёй «Зарплата». Выбрали сотрудника и месяц — программа
// показывает расчёт «оклад + бонус от его продаж» и подставляет сумму. Сумму можно
// поправить: премия, аванс, удержание — дело владельца. Бонус считается по чекам,
// которые сотрудник пробил сам, после скидок.
//
// Зарплату выдают и частями. Тогда видно, сколько за этот месяц уже выдано и сколько
// осталось, а в сумму подставляется остаток. Пока владелец вписывает сумму, под
// расчётом видно, сколько останется после этой выдачи.
//
// Бонус считается за дни «с» и «по». По умолчанию это месяц сотрудника: с числа из
// его карточки (обычно 1-го) по день перед ним в следующем месяце. Даты можно
// поменять — вышел на работу 20-го, платят раз в две недели. Оклад — целиком.

const DAY = 86400000

export const ZARPLATA = 'Зарплата'
export const isZarplata = (category) => String(category || '').trim() === ZARPLATA

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
export const monthName = (key, t) => {
  const [y, m] = String(key).split('-').map(Number)
  return `${t(MONTHS[m - 1] || '')} ${y}`
}

// Список сотрудников — один запрос на страницу: и форма, и правка берут его отсюда
let staffPromise = null
function loadStaff(force) {
  if (!staffPromise || force) staffPromise = api.get('/expenses/staff').catch((e) => { staffPromise = null; throw e })
  return staffPromise
}

export function useStaff() {
  const [staff, setStaff] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    loadStaff()
      .then((rows) => { if (alive) setStaff(Array.isArray(rows) ? rows : []) })
      .catch((e) => { if (alive) { setStaff([]); setError(e.message || '') } })
    return () => { alive = false }
  }, [])
  return { staff, error }
}

export const staffName = (u) => (u ? (u.fullName ? `${u.fullName} (${u.name})` : u.name) : '')

// Выдачи зарплаты, среди которых ищут выдачи за месяц: из общего кэша расходов,
// а за давние месяцы — с сервера. Остаток месяца бывает выдан и позже, поэтому
// берём всё от начала месяца (с запасом на аванс накануне) и до сегодня
export function useVydachi(month) {
  const cached = useCollection('expenses')
  const range = useMemo(() => ({ from: new Date(mesyac(month).from.getTime() - 62 * DAY), to: null }), [month])
  const { deep, loading } = useDeepPeriod(['expenses'], range, { untilNow: true })
  return { expenses: deep.expenses || cached, loading }
}

const kop = (x) => Math.round(x * 100) / 100

export default function SalaryPicker({ employeeId, setEmployeeId, month, setMonth, period, setPeriod, amount, onAmount, tour }) {
  const t = useT()
  const idp = tour || 'sal'
  const { staff, error } = useStaff()
  const months = useMemo(() => poslednieMesyacy(6), [])
  const emp = (staff || []).find((u) => u.id === employeeId)

  // ── За какие дни бонус ──
  // Сменили сотрудника или месяц — даты снова по его карточке. Пока новые даты не
  // встали (первая отрисовка после смены), считаем по карточке, а не по прежним
  const def = emp ? periodZarplaty(month, emp.salaryDay) : null
  const keyNow = emp ? `${emp.id}|${month}|${emp.salaryDay || 1}` : ''
  const periodKey = useRef('')
  useEffect(() => {
    if (!emp) {
      periodKey.current = ''
      return
    }
    if (periodKey.current === keyNow) return
    periodKey.current = keyNow
    setPeriod(periodZarplaty(month, emp.salaryDay))
  }, [emp, month, keyNow, setPeriod])
  const fresh = periodKey.current === keyNow
  const per = emp ? (fresh && period?.from && period?.to ? period : def) : null
  const pf = per?.from || ''
  const pt = per?.to || ''
  const perOk = periodVeren(per)
  const svoi = !!per && !!def && (pf !== def.from || pt !== def.to)
  const range = useMemo(() => (perOk ? dniKMomentam(pf, pt) : mesyac(month)), [perOk, pf, pt, month])
  const idet = perOk && pt >= dayKey() // период ещё идёт: продажи — по сегодня

  const salesCached = useCollection('sales')
  const { deep, loading } = useDeepPeriod(['sales'], range)
  const sales = deep.sales || salesCached
  const { expenses, loading: loadingEx } = useVydachi(month)

  const salesSum = emp && perOk ? prodazhiSotrudnika(sales, emp.id, range.from, range.to) : 0
  const calc = emp && perOk ? zarplataKVydache({ salary: emp.salary, bonusPercent: emp.bonusPercent, salesSum }) : null
  // Что уже выдано за этот месяц и сколько осталось
  const vydachi = emp ? vydachiZaMesyac(expenses, emp.id, month) : []
  const vydano = kop(vydachi.reduce((a, e) => a + (Number(e.amount) || 0), 0))
  const ost = calc ? ostatokZarplaty(calc.total, vydano) : null
  // Сколько останется после выдачи, которую сейчас вписывают
  const sum = Number(amount) || 0
  const posle = calc && sum > 0 ? kop(calc.total - vydano - sum) : null

  // Сумма подставляется сама, когда меняют сотрудника или месяц: первая выдача за
  // месяц — вся зарплата, следующие — остаток. Но не поверх того, что владелец
  // вписал руками после этого
  const last = useRef('')
  useEffect(() => {
    // Сотрудника сняли (выдачу записали, форма очистилась) — следующий выбор того же
    // сотрудника снова подставит сумму, уже остаток
    if (!calc) {
      last.current = ''
      return
    }
    if (loading || loadingEx) return
    const key = `${employeeId}|${month}|${pf}|${pt}|${calc.total}|${vydano}`
    if (last.current === key) return
    last.current = key
    const want = vydano > 0 ? ost.ostalos : calc.total
    if (want > 0) onAmount(String(want))
    // За месяц уже выдано всё — прежнюю сумму не оставляем: её легко выдать второй раз
    else if (vydano > 0) onAmount('')
  }, [calc, ost, vydano, employeeId, month, pf, pt, loading, loadingEx, onAmount])

  const active = (staff || []).filter((u) => u.active || u.id === employeeId)

  return (
    <div className="salary-pick" data-tour={tour}>
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 2, minWidth: 200 }}>
          <label htmlFor={`${idp}-emp`}>{t('Кому выдаём зарплату')}</label>
          <select id={`${idp}-emp`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{staff === null ? t('Загружаем…') : t('— выберите сотрудника —')}</option>
            {active.map((u) => <option key={u.id} value={u.id}>{staffName(u)}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label htmlFor={`${idp}-month`}>{t('За месяц')}</label>
          <select id={`${idp}-month`} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthName(m, t)}</option>)}
          </select>
        </div>
      </div>
      {emp && (
        <div className="salary-period" data-tour="exp.salary-period">
          <span className="salary-period-label">{t('Бонус от продаж за дни')}</span>
          <label className="salary-period-field" htmlFor={`${idp}-from`}>
            <span>{t('с')}</span>
            <input
              id={`${idp}-from`} type="date" value={pf} max={pt || undefined}
              onChange={(e) => setPeriod({ from: e.target.value || def.from, to: pt || def.to })}
            />
          </label>
          <label className="salary-period-field" htmlFor={`${idp}-to`}>
            <span>{t('по')}</span>
            <input
              id={`${idp}-to`} type="date" value={pt} min={pf || undefined}
              onChange={(e) => setPeriod({ from: pf || def.from, to: e.target.value || def.to })}
            />
          </label>
          {svoi ? (
            <button type="button" className="linklike salary-period-reset" onClick={() => setPeriod(def)}>{t('как в карточке')}</button>
          ) : (
            <span className="tag-cat">{Number(emp.salaryDay) > 1 ? `${t('его месяц — с')} ${emp.salaryDay} ${t('числа')}` : t('календарный месяц')}</span>
          )}
        </div>
      )}
      {per && !perOk && <div className="salary-err">{t('Дата «с» позже даты «по» — поправьте дни бонуса')}</div>}
      {error && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t(error)}</div>}
      {staff && staff.length === 0 && !error && (
        <div className="tag-cat">{t('Сотрудников пока нет.')} <Link to="/employees" className="linklike">{t('Сотрудники')}</Link></div>
      )}
      {calc && (
        <div className="salary-calc">
          <span>{t('Оклад')} <b>{money(calc.salary)}</b></span>
          <span> + {t('бонус')} {String(emp.bonusPercent).replace('.', ',')}% {t('от продаж с')} {denText(pf)} {t('по')} {denText(pt)} ({money(salesSum)}) = <b>{money(calc.bonus)}</b></span>
          <span className="salary-total"> → {t('к выдаче')} <b>{money(calc.total)}</b></span>
          {loading && <span className="tag-cat"> · {t('загружаем продажи…')}</span>}
          {idet && Number(emp.bonusPercent) > 0 && <div className="tag-cat">{t('Период ещё идёт — продажи посчитаны по сегодняшний день.')}</div>}
          {vydano > 0 && (
            <div className="salary-paid" data-tour="exp.salary-paid">
              {t('Уже выдано за')} {monthName(month, t)}: <b>{money(vydano)}</b>
              <span className="tag-cat"> ({vydachi.map((e) => `${money(e.amount)} — ${fmtDate(e.date)}`).join(', ')})</span>
              {' → '}
              {ost.ostalos > 0 ? (
                <span className="salary-ost">{t('осталось')} <b>{money(ost.ostalos)}</b></span>
              ) : ost.pereplata > 0 ? (
                <span className="salary-over">{t('выдано больше начисленного на')} <b>{money(ost.pereplata)}</b></span>
              ) : (
                <b className="salary-full">{t('выдано полностью')}</b>
              )}
            </div>
          )}
          {posle !== null && (
            <div className={'salary-after' + (posle < 0 ? ' over' : '')} data-tour="exp.salary-after">
              {posle > 0
                ? <>{t('После этой выдачи останется')} <b>{money(posle)}</b></>
                : posle === 0
                  ? <>{t('После этой выдачи зарплата за')} {monthName(month, t)} {t('будет выдана полностью')}</>
                  : <>{t('Это больше начисленного на')} <b>{money(-posle)}</b> — {t('проверьте сумму')}</>}
            </div>
          )}
          {!(Number(emp.salary) > 0) && !(Number(emp.bonusPercent) > 0) && (
            <div className="tag-cat" style={{ marginTop: 4 }}>
              {t('Оклад и бонус у сотрудника не заданы — впишите их в разделе')} <Link to="/employees" className="linklike">{t('Сотрудники')}</Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
