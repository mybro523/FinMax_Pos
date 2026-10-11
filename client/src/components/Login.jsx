import { useState } from 'react'
import { LuPlus, LuLogIn, LuTriangleAlert } from 'react-icons/lu'
import { login } from '../db/auth'
import { PasswordInput } from './ui'
import { useT } from '../lib/i18n'

export default function Login() {
  const t = useT()
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setErr('')
    setBusy(true)
    try {
      await login(name.trim(), pw)
    } catch (e) {
      setErr(e.message || t('Не удалось войти'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo"><LuPlus size={30} strokeWidth={3} /></div>
        <h1>{t('Аптека')}</h1>
        <div className="login-sub">{t('Вход в систему')}</div>

        <div className="field">
          <label htmlFor="lg-name">{t('Имя сотрудника')}</label>
          <input id="lg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="admin" autoFocus autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="lg-pw">{t('Пароль')}</label>
          <PasswordInput id="lg-pw" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••" autoComplete="current-password" />
        </div>

        {err && (
          <div className="note err" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <LuTriangleAlert size={16} style={{ flexShrink: 0 }} /> <span>{err}</span>
          </div>
        )}

        <button className="btn block" disabled={busy} style={{ padding: 12, fontSize: 15 }}>
          <span className="ic"><LuLogIn size={17} /></span> {busy ? t('Вход…') : t('Войти')}
        </button>
      </form>
    </div>
  )
}
