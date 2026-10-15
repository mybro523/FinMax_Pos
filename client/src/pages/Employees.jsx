import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LuUserPlus, LuTrash2, LuKeyRound, LuShieldCheck } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, PasswordInput, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { api } from '../db/api'
import { onChanged } from '../db/store'
import { useAuth } from '../db/auth'
import { fmtDate } from '../lib/time'
import { useT } from '../lib/i18n'
import { OWNER_ROLE_ID } from '../lib/permissions'

// ── Сотрудники ──
// Каждому сотруднику назначается роль из раздела «Роли и права»: по ней видны
// разделы и кнопки. Владелец — тоже роль, особая: ему можно всё, и единственного
// владельца нельзя ни разжаловать, ни заблокировать.

export default function Employees() {
  const toast = useToast()
  const dialog = useDialog()
  const me = useAuth()
  const t = useT()
  const [list, setList] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const pg = usePagination(list, 10)

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
      message: `«${u.name}» будет удалён. История его продаж сохранится (кассир станет «—»).`,
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

  return (
    <Layout
      title={t('Сотрудники')}
      subtitle={t('Кто работает в магазине и с какой ролью')}
      actions={
        <button className="btn" data-tour="emp.add" onClick={() => setAdding(true)}>
          <span className="ic"><LuUserPlus size={16} /></span> {t('Добавить сотрудника')}
        </button>
      }
    >
      <div className="panel" data-tour="emp.list" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>{t('Имя')}</th><th>{t('Роль')}</th><th>{t('Добавлен')}</th><th>{t('Статус')}</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b>{u.id === me?.id && <span className="tag-cat"> · {t('это вы')}</span>}</td>
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
                <td className="tag-cat">{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                <td>{u.active ? <span className="badge ok">{t('активен')}</span> : <span className="badge debt">{t('заблокирован')}</span>}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
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
            {!loading && list.length === 0 && <tr><td colSpan="5" className="empty">{t('Нет сотрудников')}</td></tr>}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>
      <div className="note info" style={{ marginTop: 16, maxWidth: 680, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>{t('Что видит и что может каждый сотрудник, решает его роль.')}</span>
        <Link to="/roles" className="linklike"><LuShieldCheck size={14} /> {t('Роли и права')}</Link>
      </div>

      {adding && <AddEmployee roles={roles} onDone={added} onClose={() => setAdding(false)} />}
    </Layout>
  )
}

// ── Новый сотрудник ──
// Имя, пароль и роль сразу: без роли сотрудник получил бы права кассира по
// умолчанию, и владелец узнал бы об этом только когда тот не смог открыть раздел
function AddEmployee({ roles, onDone, onClose }) {
  const t = useT()
  const toast = useToast()
  const cashier = roles.find((r) => r.system === 'cashier')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [roleId, setRoleId] = useState(cashier?.id || roles.find((r) => r.id !== OWNER_ROLE_ID)?.id || '')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name.trim()) return toast(t('Введите имя'), 'err')
    if (password.length < 6) return toast(t('Пароль — не короче 6 символов'), 'err')
    setSaving(true)
    try {
      const u = await api.post('/users', { name: name.trim(), password, roleId })
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
        <label htmlFor="emp-name">{t('Имя (логин для входа)')}</label>
        <input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
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
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={submit} disabled={saving}>{saving ? t('Сохранение…') : t('Добавить')}</button>
      </div>
    </Modal>
  )
}
