import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../db/api'
import { useCollection, money } from '../db/store'
import { useT } from '../lib/i18n'
import { useDeepPeriod } from './Period'
import { mesyac, poslednieMesyacy, prodazhiSotrudnika, zarplataKVydache } from '../lib/otchety'

// ── Кому выдаём зарплату ──
// Появляется в расходе со статьёй «Зарплата». Выбрали сотрудника и месяц — программа
// показывает расчёт «оклад + бонус от его продаж» и подставляет сумму. Сумму можно
// поправить: премия, аванс, удержание — дело владельца. Бонус считается по чекам,
// которые сотрудник пробил сам, после скидок.

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

export default function SalaryPicker({ employeeId, setEmployeeId, onAmount, tour }) {
  const t = useT()
  const { staff, error } = useStaff()
  const months = useMemo(() => poslednieMesyacy(6), [])
  const [month, setMonth] = useState(months[0])
  const range = useMemo(() => mesyac(month), [month])
  const salesCached = useCollection('sales')
  const { deep, loading } = useDeepPeriod(['sales'], range)
  const sales = deep.sales || salesCached

  const emp = (staff || []).find((u) => u.id === employeeId)
  const salesSum = emp ? prodazhiSotrudnika(sales, emp.id, range.from, range.to) : 0
  const calc = emp ? zarplataKVydache({ salary: emp.salary, bonusPercent: emp.bonusPercent, salesSum }) : null

  // Сумма подставляется сама, когда меняют сотрудника или месяц, — но не поверх
  // того, что владелец вписал руками после этого
  const last = useRef('')
  useEffect(() => {
    if (!calc || loading) return
    const key = `${employeeId}|${month}|${calc.total}`
    if (last.current === key) return
    last.current = key
    if (calc.total > 0) onAmount(String(calc.total))
  }, [calc, employeeId, month, loading, onAmount])

  const active = (staff || []).filter((u) => u.active || u.id === employeeId)

  return (
    <div className="salary-pick" data-tour={tour}>
      <div className="row" style={{ gap: 14 }}>
        <div className="field" style={{ flex: 2, minWidth: 200 }}>
          <label htmlFor={`${tour || 'sal'}-emp`}>{t('Кому выдаём зарплату')}</label>
          <select id={`${tour || 'sal'}-emp`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{staff === null ? t('Загружаем…') : t('— выберите сотрудника —')}</option>
            {active.map((u) => <option key={u.id} value={u.id}>{staffName(u)}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label htmlFor={`${tour || 'sal'}-month`}>{t('За месяц')}</label>
          <select id={`${tour || 'sal'}-month`} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthName(m, t)}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t(error)}</div>}
      {staff && staff.length === 0 && !error && (
        <div className="tag-cat">{t('Сотрудников пока нет.')} <Link to="/employees" className="linklike">{t('Сотрудники')}</Link></div>
      )}
      {calc && (
        <div className="salary-calc">
          <span>{t('Оклад')} <b>{money(calc.salary)}</b></span>
          <span> + {t('бонус')} {String(emp.bonusPercent).replace('.', ',')}% {t('от продаж за')} {monthName(month, t)} ({money(salesSum)}) = <b>{money(calc.bonus)}</b></span>
          <span className="salary-total"> → {t('к выдаче')} <b>{money(calc.total)}</b></span>
          {loading && <span className="tag-cat"> · {t('загружаем продажи…')}</span>}
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
