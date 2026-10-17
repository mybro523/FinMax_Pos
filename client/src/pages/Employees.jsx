import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { LuUserPlus, LuTrash2, LuKeyRound, LuShieldCheck, LuPencil, LuUserCog, LuHandCoins } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, PasswordInput, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import NumberInput from '../components/NumberInput'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useDeepPeriod } from '../components/Period'
import { monthName, useVydachi } from '../components/SalaryPicker'
import { api } from '../db/api'
import { onChanged, money, useCollection } from '../db/store'
import { useAuth, getUser } from '../db/auth'
import { skachatXlsx } from '../lib/excel'
import {
  mesyac, poslednieMesyacy, prodazhiSotrudnika, zarplataKVydache, vydanoZaMesyac, ostatokZarplaty,
  periodZarplaty, dniKMomentam, denText,
} from '../lib/otchety'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import { OWNER_ROLE_ID } from '../lib/permissions'

// ── Сотрудники ──
// Каждому сотруднику назначается роль из раздела «Роли и права»: по ней видны
// разделы и кнопки. Владелец — тоже роль, особая: ему можно всё, и единственного
// владельца нельзя ни разжаловать, ни заблокировать.
//
// У сотрудника есть и данные для зарплаты: ФИО, оклад и бонус — процент от суммы
// его продаж за месяц. По ним раздел «Расходы» сам считает зарплату к выдаче.
//
// За выбранный месяц таблица показывает, сколько каждому начислено, сколько уже
// выдано и сколько осталось: зарплату выдают и частями. Кнопка «Выдать» ведёт
// в «Расходы», где зарплата этому сотруднику за этот месяц уже выбрана.

const pct = (v) => `${String(Number(v) || 0).replace('.', ',')}%`
const DAY = 86400000

export default function Employees() {
  const toast = useToast()
  const dialog = useDialog()
  const me = useAuth()
  const t = useT()
  const [list, setList] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const pg = usePagination(list, 10)

  // ── Зарплата за месяц ──
  const months = useMemo(() => poslednieMesyacy(12), [])
  const [month, setMonth] = useState(months[0])
  // Месяц зарплаты у каждого свой (с числа из карточки, не позже 28-го): продажи
  // нужны с начала месяца по 27-е число следующего
  const range = useMemo(() => ({ from: mesyac(month).from, to: new Date(mesyac(month).to.getTime() + 28 * DAY) }), [month])
  const salesCached = useCollection('sales')
  const { deep } = useDeepPeriod(['sales'], range)
  const sales = deep.sales || salesCached
  const { expenses } = useVydachi(month)
  // Чеки и выдачи зарплаты ссылаются на сотрудника в схеме магазина (userId), а не
  // на учётную запись входа (id) — считаем по нему
  const zp = useMemo(() => {
    const m = new Map()
    for (const u of list) {
      const uid = u.userId
      // Бонус — за месяц сотрудника: с его числа по день перед ним в следующем месяце
      const per = periodZarplaty(month, u.salaryDay)
      const r = dniKMomentam(per.from, per.to)
      const salesSum = uid ? prodazhiSotrudnika(sales, uid, r.from, r.to) : 0
      const nachisleno = zarplataKVydache({ salary: u.salary, bonusPercent: u.bonusPercent, salesSum }).total
      const vydano = uid ? vydanoZaMesyac(expenses, uid, month) : 0
      m.set(u.id, { per, salesSum, nachisleno, vydano, ...ostatokZarplaty(nachisleno, vydano) })
    }
    return m
  }, [list, sales, expenses, month])
  // В таблице зарплаты — те, кому есть что начислить или кому уже выдавали
  const zpList = list.filter((u) => {
    const z = zp.get(u.id)
    return z && (z.nachisleno > 0 || z.vydano > 0)
  })

  const load = useCallback(async () => {
    try {
      const [users, rs] = await Promise.all([api.get('/users'), api.get('/roles')])
      setList(users)
      setRoles(rs)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => onChanged((keys) => (keys.includes('users') || keys.includes('roles')) && load()), [load])

  const roleName = (u) => roles.find((r) => r.id === u.roleId)?.name || u.roleName || (u.role === 'founder' ? t('Владелец') : t('Кассир'))

  async function resetPw(u) {
    const r = await dialog.prompt({
      title: `${t('Новый пароль')} — ${u.name}`,
      fields: [{ name: 'password', label: t('Пароль (минимум 6 символов)'), type: 'password' }],
      confirmText: t('Сохранить'),
    })
    if (!r || !r.password) return
    toast(t('Пароль обновлён'))
    api.patch(`/users/${u.id}`, { password: r.password }).catch((e) => toast(e.message, 'err'))
  }

  // Экран отвечает мгновенно, но последнее слово всегда за сервером: после каждого
  // действия список перечитывается. Иначе при обрыве связи он копил бы призрачные
  // строки: удалённый «возвращался», а добавленный «появлялся дважды»
  function toggleActive(u) {
    setList((ls) => ls.map((x) => (x.id === u.id ? { ...x, active: !u.active } : x)))
    toast(u.active ? t('Сотрудник заблокирован') : t('Сотрудник разблокирован'))
    api
      .patch(`/users/${u.id}`, { active: !u.active })
      .catch((e) => toast(e.message, 'err'))
      .finally(load)
  }

  function changeRole(u, roleId) {
    setList((ls) => ls.map((x) => (x.id === u.id ? { ...x, roleId } : x)))
    api
      .patch(`/users/${u.id}`, { roleId })
      .then(() => toast(t('Роль изменена')))
      .catch((e) => toast(e.message, 'err'))
      .finally(load)
  }

  async function remove(u) {
    const ok = await dialog.confirm({
      title: t('Удалить сотрудника?'),
      message: `«${u.name}» ${t('будет удалён. История его продаж сохранится (кассир станет «—»).')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    setList((ls) => ls.filter((x) => x.id !== u.id))
    toast(t('Сотрудник удалён'))
    api
      .del(`/users/${u.id}`)
      .catch((e) => {
        // «Не найден» — значит он уже удалён (строка была призраком после обрыва
        // связи). Возвращать её не надо — перечитанный список и так скажет правду
        if (e.status !== 404) toast(e.message, 'err')
      })
      .finally(load)
  }

  function added(u) {
    setList((ls) => [...ls, u])
    setAdding(false)
    toast(t('Сотрудник добавлен'))
    load()
  }

  function saved(u) {
    setList((ls) => ls.map((x) => (x.id === u.id ? { ...x, ...u } : x)))
    setEditing(null)
    toast(t('Данные сотрудника сохранены'))
    load()
  }

  // ── Выгрузка и печать: таблица с зарплатой за выбранный месяц ──
  const exCols = [
    { header: t('Логин'), key: 'login', width: 16 },
    { header: t('ФИО'), key: 'fio', width: 26 },
    { header: t('Роль'), key: 'role', width: 16 },
    { header: t('Оклад'), key: 'salary', width: 13, money: true },
    { header: t('Бонус, %'), key: 'bonus', width: 10, num: true },
    { header: t('Бонус за дни'), key: 'days', width: 24 },
    { header: t('Начислено'), key: 'nachisleno', width: 14, money: true },
    { header: t('Выдано'), key: 'vydano', width: 14, money: true },
    { header: t('Осталось'), key: 'ostalos', width: 14, money: true },
    { header: t('Статус'), key: 'status', width: 14 },
  ]
  const exRows = list.map((u) => {
    const z = zp.get(u.id) || { nachisleno: 0, vydano: 0, ostalos: 0, pereplata: 0 }
    return {
      login: u.name, fio: u.fullName || '', role: roleName(u),
      salary: Number(u.salary) || 0, bonus: Number(u.bonusPercent) || 0,
      days: z.per ? `${denText(z.per.from)} – ${denText(z.per.to)}` : '',
      nachisleno: z.nachisleno, vydano: z.vydano, ostalos: z.pereplata > 0 ? -z.pereplata : z.ostalos,
      status: u.active ? t('активен') : t('заблокирован'),
    }
  })
  const sumOf = (k) => Math.round(exRows.reduce((a, r) => a + (r[k] || 0), 0) * 100) / 100
  const exItogi = { login: t('Итого'), nachisleno: sumOf('nachisleno'), vydano: sumOf('vydano'), ostalos: sumOf('ostalos') }
  const exPodzag = `${t('Зарплата за')} ${monthName(month, t)} · ${t('Сотрудников')}: ${list.length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Сотрудники'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Сотрудники')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout
      title={t('Сотрудники')}
      subtitle={t('Кто работает в магазине и с какой ролью')}
      actions={
        <>
          <ExportPechat onExcel={exportExcel} />
          <button className="btn" data-tour="emp.add" onClick={() => setAdding(true)}>
            <span className="ic"><LuUserPlus size={16} /></span> {t('Добавить сотрудника')}
          </button>
        </>
      }
    >
      <PrintSheet zagolovok={t('Сотрудники')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      <div className="panel" data-tour="emp.list" style={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>{t('Логин')}</th><th>{t('ФИО')}</th><th>{t('Роль')}</th>
                <th className="num">{t('Оклад')}</th><th className="num">{t('Бонус')}</th>
                <th>{t('Добавлен')}</th><th>{t('Статус')}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pg.slice.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.name}</b>{u.id === me?.id && <span className="tag-cat"> · {t('это вы')}</span>}</td>
                  <td>{u.fullName || <span className="tag-cat">—</span>}</td>
                  <td>
                    {/* Свою роль владелец не меняет — иначе остался бы без прав посреди работы */}
                    {u.id === me?.id ? (
                      <span>{roleName(u)}</span>
                    ) : (
                      <select
                        className="role-select"
                        data-tour="emp.role"
                        value={u.roleId || ''}
                        onChange={(e) => changeRole(u, e.target.value)}
                        aria-label={`${t('Роль')}: ${u.name}`}
                      >
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="num" data-tour="emp.salary">{Number(u.salary) > 0 ? money(u.salary) : <span className="tag-cat">—</span>}</td>
                  <td className="num">{Number(u.bonusPercent) > 0 ? pct(u.bonusPercent) : <span className="tag-cat">—</span>}</td>
                  <td className="tag-cat">{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                  <td>{u.active ? <span className="badge ok">{t('активен')}</span> : <span className="badge debt">{t('заблокирован')}</span>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" data-tour="emp.edit" onClick={() => setEditing(u)} title={t('ФИО, оклад и бонус')}><LuPencil size={14} /> {t('Изменить')}</button>{' '}
                    <button className="btn ghost sm" data-tour="emp.password" onClick={() => resetPw(u)}><LuKeyRound size={14} /> {t('Пароль')}</button>{' '}
                    {u.id !== me?.id && (
                      <>
                        <button className="btn ghost sm" data-tour="emp.block" onClick={() => toggleActive(u)}>{u.active ? t('Блокировать') : t('Разблок.')}</button>{' '}
                        {u.role !== 'founder' && (
                          <button className="btn ghost sm icon" data-tour="emp.delete" onClick={() => remove(u)} title={t('Удалить')} aria-label={`${t('Удалить')}: ${u.name}`}><LuTrash2 size={15} /></button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && list.length === 0 && <tr><td colSpan="8" className="empty">{t('Нет сотрудников')}</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination {...pg} />
      </div>

      {/* ── Зарплата за месяц ── Отдельной таблицей: в общем списке колонки не
          поместились бы рядом с кнопками. Сотрудники без оклада, бонуса и выдач
          здесь не нужны */}
      <div className="panel mt" data-tour="emp.zarplata" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuHandCoins size={17} /></span>{t('Зарплата за месяц')}</span>
        </h2>
        <div className="emp-zp-bar">
          <select id="empMonth" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t('Месяц')}>
            {months.map((m) => <option key={m} value={m}>{monthName(m, t)}</option>)}
          </select>
          <span className="tag-cat">{t('Начислено — оклад и бонус от продаж за месяц. Выдают в «Расходах» со статьёй «Зарплата», можно частями.')}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>{t('Сотрудник')}</th><th className="num">{t('Оклад')}</th><th className="num">{t('Бонус')}</th>
                <th className="num">{t('Продажи за его месяц')}</th><th className="num">{t('Начислено')}</th>
                <th className="num">{t('Выдано')}</th><th className="num">{t('Осталось')}</th>
              </tr>
            </thead>
            <tbody>
              {zpList.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.fullName || u.name}</b>{u.fullName ? <div className="tag-cat">{u.name}</div> : null}</td>
                  <td className="num">{Number(u.salary) > 0 ? money(u.salary) : <span className="tag-cat">—</span>}</td>
                  <td className="num">{Number(u.bonusPercent) > 0 ? pct(u.bonusPercent) : <span className="tag-cat">—</span>}</td>
                  <td className="num">
                    {zp.get(u.id)?.salesSum > 0 ? money(zp.get(u.id).salesSum) : <span className="tag-cat">—</span>}
                    {zp.get(u.id)?.per && <div className="tag-cat">{denText(zp.get(u.id).per.from, true)} – {denText(zp.get(u.id).per.to, true)}</div>}
                  </td>
                  <ZpCells z={zp.get(u.id)} employeeId={u.userId} month={month} />
                </tr>
              ))}
              {zpList.length > 0 && (
                <tr className="emp-zp-total">
                  <td colSpan="4"><b>{t('Итого')}</b></td>
                  <td className="num"><b>{money(exItogi.nachisleno)}</b></td>
                  <td className="num"><b>{money(exItogi.vydano)}</b></td>
                  <td className="num"><b>{money(Math.max(0, zpList.reduce((s, u) => s + (zp.get(u.id)?.ostalos || 0), 0)))}</b></td>
                </tr>
              )}
              {!loading && zpList.length === 0 && (
                <tr><td colSpan="7" className="empty">{t('Оклад и бонус пока никому не заданы — впишите их кнопкой «Изменить» в списке выше.')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="note info" style={{ marginTop: 16, maxWidth: 680, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>{t('Что видит и что может каждый сотрудник, решает его роль.')}</span>
        <Link to="/roles" className="linklike"><LuShieldCheck size={14} /> {t('Роли и права')}</Link>
      </div>

      {adding && <AddEmployee roles={roles} onDone={added} onClose={() => setAdding(false)} />}
      {editing && <EditEmployee user={editing} onDone={saved} onClose={() => setEditing(null)} />}
    </Layout>
  )
}

// Начислено, выдано и осталось за месяц. «Выдать» — в «Расходы», где зарплата этому
// сотруднику за этот месяц уже выбрана и в сумме стоит остаток
function ZpCells({ z, employeeId, month }) {
  const t = useT()
  const nichego = !z || (z.nachisleno <= 0 && z.vydano <= 0)
  return (
    <>
      <td className="num">{z && z.nachisleno > 0 ? money(z.nachisleno) : <span className="tag-cat">—</span>}</td>
      <td className="num">{z && z.vydano > 0 ? money(z.vydano) : <span className="tag-cat">—</span>}</td>
      <td className="num emp-zp-ost" style={{ whiteSpace: 'nowrap' }}>
        {nichego ? (
          <span className="tag-cat">—</span>
        ) : z.ostalos > 0 ? (
          <>
            <b style={{ color: 'var(--danger)' }}>{money(z.ostalos)}</b>{' '}
            {employeeId && (
              <Link to="/expenses" state={{ zarplata: { employeeId, month } }} className="btn ghost sm emp-zp-pay" title={t('Выдать зарплату в «Расходах»')}>
                <LuHandCoins size={14} /> {t('Выдать')}
              </Link>
            )}
          </>
        ) : z.pereplata > 0 ? (
          <span className="badge debt">{t('выдано больше на')} {money(z.pereplata)}</span>
        ) : (
          <span className="badge ok">{t('выдано полностью')}</span>
        )}
      </td>
    </>
  )
}

// Оклад и бонус — общие поля обеих форм
function PayFields({ salary, setSalary, bonus, setBonus, day, setDay, idPrefix }) {
  const t = useT()
  return (
    <>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`${idPrefix}-salary`}>{t('Оклад в месяц (сомони)')}</label>
          <NumberInput id={`${idPrefix}-salary`} value={salary} placeholder="0" onChange={(e) => setSalary(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`${idPrefix}-bonus`}>{t('Бонус от продажи, %')}</label>
          <NumberInput id={`${idPrefix}-bonus`} value={bonus} placeholder="0" onChange={(e) => setBonus(e.target.value)} />
        </div>
      </div>
      <div className="tag-cat" style={{ marginTop: -6, marginBottom: 12 }}>
        {t('Бонус — процент от суммы его продаж за месяц. Зарплату к выдаче программа посчитает сама в разделе «Расходы».')}
      </div>
      <div className="field" data-tour="emp.salary-day">
        <label htmlFor={`${idPrefix}-day`}>{t('Его месяц зарплаты начинается с')}</label>
        <select id={`${idPrefix}-day`} value={day} onChange={(e) => setDay(e.target.value)}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>{d === 1 ? t('1-го числа — обычный месяц') : `${d} ${t('числа')}`}</option>
          ))}
        </select>
      </div>
      <div className="tag-cat" style={{ marginTop: -6, marginBottom: 12 }}>
        {Number(day) > 1
          ? `${t('Бонус «за октябрь» будет считаться по продажам с')} ${day} ${t('октября по')} ${Number(day) - 1} ${t('ноября')}.`
          : t('Бонус «за октябрь» будет считаться по продажам с 1 по 31 октября.')}
      </div>
    </>
  )
}

const payProblem = (salary, bonus, t) => {
  if (Number(bonus) > 100) return t('Бонус — не больше 100%')
  if (Number(salary) < 0 || Number(bonus) < 0) return t('Оклад и бонус не бывают меньше нуля')
  return ''
}

// ── Новый сотрудник ──
// Логин, пароль и роль сразу: без роли сотрудник получил бы права кассира по
// умолчанию, и владелец узнал бы об этом только когда тот не смог открыть раздел.
// ФИО, оклад и бонус — для зарплаты; их можно вписать и позже
function AddEmployee({ roles, onDone, onClose }) {
  const t = useT()
  const toast = useToast()
  const cashier = roles.find((r) => r.system === 'cashier')
  const [name, setName] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [roleId, setRoleId] = useState(cashier?.id || roles.find((r) => r.id !== OWNER_ROLE_ID)?.id || '')
  const [salary, setSalary] = useState('')
  const [bonus, setBonus] = useState('')
  const [day, setDay] = useState('1')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name.trim()) return toast(t('Введите логин'), 'err')
    if (password.length < 6) return toast(t('Пароль — не короче 6 символов'), 'err')
    const bad = payProblem(salary, bonus, t)
    if (bad) return toast(bad, 'err')
    setSaving(true)
    try {
      const u = await api.post('/users', {
        name: name.trim(),
        password,
        roleId,
        fullName: fullName.trim(),
        salary: Number(salary) || 0,
        bonusPercent: Number(bonus) || 0,
        salaryDay: Number(day) || 1,
      })
      onDone(u)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuUserPlus size={18} /></span>{t('Новый сотрудник')}</>} onClose={onClose}>
      <div className="field">
        <label htmlFor="emp-name">{t('Логин (для входа)')}</label>
        <input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="emp-fio">{t('ФИО сотрудника')}</label>
        <input id="emp-fio" value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} placeholder={t('напр. Каримов Фарход Аминович')} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="emp-pw">{t('Пароль (минимум 6 символов)')}</label>
        <PasswordInput id="emp-pw" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="field">
        <label htmlFor="emp-role">{t('Роль')}</label>
        <select id="emp-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}{r.description ? ` — ${r.description}` : ''}</option>)}
        </select>
      </div>
      <PayFields salary={salary} setSalary={setSalary} bonus={bonus} setBonus={setBonus} day={day} setDay={setDay} idPrefix="emp" />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={submit} disabled={saving}>{saving ? t('Сохранение…') : t('Добавить')}</button>
      </div>
    </Modal>
  )
}

// ── ФИО, оклад и бонус уже заведённого сотрудника ──
function EditEmployee({ user, onDone, onClose }) {
  const t = useT()
  const toast = useToast()
  const [fullName, setFullName] = useState(user.fullName || '')
  const [salary, setSalary] = useState(Number(user.salary) > 0 ? String(user.salary) : '')
  const [bonus, setBonus] = useState(Number(user.bonusPercent) > 0 ? String(user.bonusPercent) : '')
  const [day, setDay] = useState(String(Number(user.salaryDay) || 1))
  const [saving, setSaving] = useState(false)

  async function submit() {
    const bad = payProblem(salary, bonus, t)
    if (bad) return toast(bad, 'err')
    setSaving(true)
    try {
      const u = await api.patch(`/users/${user.id}`, {
        fullName: fullName.trim(),
        salary: Number(salary) || 0,
        bonusPercent: Number(bonus) || 0,
        salaryDay: Number(day) || 1,
      })
      onDone(u)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuUserCog size={18} /></span>{t('Сотрудник')} — {user.name}</>} onClose={onClose}>
      <div className="field">
        <label htmlFor="emp-edit-fio">{t('ФИО сотрудника')}</label>
        <input id="emp-edit-fio" value={fullName} maxLength={120} autoFocus onChange={(e) => setFullName(e.target.value)} placeholder={t('напр. Каримов Фарход Аминович')} />
      </div>
      <PayFields salary={salary} setSalary={setSalary} bonus={bonus} setBonus={setBonus} day={day} setDay={setDay} idPrefix="emp-edit" />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={submit} disabled={saving}>{saving ? t('Сохранение…') : t('Сохранить')}</button>
      </div>
    </Modal>
  )
}
