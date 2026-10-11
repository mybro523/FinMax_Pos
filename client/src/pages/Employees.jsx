import { useState, useEffect, useCallback } from 'react'
import { LuUserPlus, LuTrash2, LuKeyRound } from 'react-icons/lu'
import Layout from '../components/Layout'
import { useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { api } from '../db/api'
import { onChanged } from '../db/store'
import { useAuth } from '../db/auth'
import { fmtDate, serverNow } from '../lib/time'
import { useT } from '../lib/i18n'

export default function Employees() {
  const toast = useToast()
  const dialog = useDialog()
  const me = useAuth()
  const t = useT()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const pg = usePagination(list, 10)

  const load = useCallback(async () => {
    try {
      setList(await api.get('/users'))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  // Сотрудника завели или уволили на другом устройстве — список обновится сам
  useEffect(() => onChanged((keys) => keys.includes('users') && load()), [load])

  async function addCashier() {
    const r = await dialog.prompt({
      title: t('Новый кассир'),
      fields: [
        { name: 'name', label: t('Имя (логин для входа)') },
        { name: 'password', label: t('Пароль (минимум 6 символов)'), type: 'password' },
      ],
      confirmText: t('Добавить'),
    })
    if (!r || !r.name.trim()) return
    // Мгновенно: сотрудник появляется в списке сразу, запись уходит в фоне
    const prev = list
    const temp = { id: 'tmp_' + Math.random().toString(36).slice(2), name: r.name.trim(), role: 'cashier', active: true, createdAt: serverNow().toISOString() }
    setList([...prev, temp])
    toast(t('Кассир добавлен'))
    api
      .post('/users', { name: r.name.trim(), password: r.password || '', role: 'cashier' })
      .then((u) => setList((ls) => ls.map((x) => (x.id === temp.id ? u : x))))
      .catch((e) => {
        setList(prev)
        toast(e.message, 'err')
      })
  }

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

  function toggleActive(u) {
    const prev = list
    setList((ls) => ls.map((x) => (x.id === u.id ? { ...x, active: !u.active } : x)))
    toast(u.active ? t('Кассир заблокирован') : t('Кассир разблокирован'))
    api.patch(`/users/${u.id}`, { active: !u.active }).catch((e) => {
      setList(prev)
      toast(e.message, 'err')
    })
  }

  async function remove(u) {
    const ok = await dialog.confirm({
      title: t('Удалить сотрудника?'),
      message: `«${u.name}» будет удалён. История его продаж сохранится (кассир станет «—»).`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    const prev = list
    setList((ls) => ls.filter((x) => x.id !== u.id))
    toast(t('Сотрудник удалён'))
    api.del(`/users/${u.id}`).catch((e) => {
      setList(prev)
      toast(e.message, 'err')
    })
  }

  return (
    <Layout
      title={t('Сотрудники')}
      subtitle={t('Основатель и кассиры')}
      actions={<button className="btn" data-tour="emp.add" onClick={addCashier}><span className="ic"><LuUserPlus size={16} /></span> {t('Добавить кассира')}</button>}
    >
      <div className="panel" data-tour="emp.list" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>{t('Имя')}</th><th>{t('Роль')}</th><th>{t('Добавлен')}</th><th>{t('Статус')}</th><th></th></tr></thead>
          <tbody>
            {pg.slice.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b>{u.id === me?.id && <span className="tag-cat"> · {t('это вы')}</span>}</td>
                <td>{u.role === 'founder' ? t('Основатель') : t('Кассир')}</td>
                <td className="tag-cat">{u.createdAt ? fmtDate(u.createdAt) : '—'}</td>
                <td>{u.active ? <span className="badge ok">{t('активен')}</span> : <span className="badge debt">{t('заблокирован')}</span>}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" data-tour="emp.password" onClick={() => resetPw(u)}><LuKeyRound size={14} /> {t('Пароль')}</button>{' '}
                  {u.role !== 'founder' && (
                    <>
                      <button className="btn ghost sm" data-tour="emp.block" onClick={() => toggleActive(u)}>{u.active ? t('Блокировать') : t('Разблок.')}</button>{' '}
                      <button className="btn ghost sm icon" data-tour="emp.delete" onClick={() => remove(u)}><LuTrash2 size={15} /></button>
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
      <div className="note info" style={{ marginTop: 16, maxWidth: 680 }}>
        {t('Кассир входит по своему имени и паролю, открывает и закрывает смену кассы. В разделе «Смена кассы» вы видите продажи по каждому кассиру.')}
      </div>
    </Layout>
  )
}
