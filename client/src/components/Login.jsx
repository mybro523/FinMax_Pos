import { useState } from 'react'
import { LuLogIn, LuTriangleAlert, LuScanLine, LuBoxes, LuTrendingUp, LuWifiOff } from 'react-icons/lu'
import { login } from '../db/auth'
import { PasswordInput, BrandWord } from './ui'
import { useT, useLang, setLang, LANGS } from '../lib/i18n'
import emblem from '../assets/brand/emblem-192.webp'
import logo320 from '../assets/brand/logo-320.webp'
import logo640 from '../assets/brand/logo-640.webp'

// ── Экран входа ──
// Слева — кто мы: логотип на белой карточке, как на сайте FinMax, и несколько
// строк о том, что умеет система. Справа — форма. На телефоне левая часть
// сжимается до полосы с именем: там человеку нужен только вход.
//
// Язык переключается прямо здесь: кассир, читающий по-таджикски, иначе видел бы
// русскую форму и не знал бы, что язык вообще можно сменить.
const POINTS = [
  { Icon: LuScanLine, text: 'Продажи по сканеру и поштучно' },
  { Icon: LuBoxes, text: 'Партии, остатки и сроки годности' },
  { Icon: LuTrendingUp, text: 'Смены, долги и отчёты владельцу' },
  { Icon: LuWifiOff, text: 'Касса работает и без интернета' },
]

export default function Login() {
  const t = useT()
  const lang = useLang()
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
    <div className="auth">
      <aside className="auth-brand">
        <BrandWord />
        <div className="auth-brand-body">
          <div className="auth-hero">
            <img
              src={logo320}
              srcSet={`${logo320} 320w, ${logo640} 640w`}
              sizes="132px"
              width="320"
              height="332"
              alt="FinMax"
            />
          </div>
          <h2>{t('Касса, склад и смены — в одной системе')}</h2>
          <p>{t('Продажи, остатки и деньги аптеки видны владельцу в любой момент — с компьютера и с телефона.')}</p>
          <ul className="auth-points">
            {POINTS.map((p) => (
              <li key={p.text}>
                <span className="ic"><p.Icon size={15} /></span>
                {t(p.text)}
              </li>
            ))}
          </ul>
        </div>
        <div className="auth-brand-foot">
          <span>© {new Date().getFullYear()} FinMax</span>
          <span className="auth-ver">{t('Ваш финансовый помощник')}</span>
        </div>
      </aside>

      <main className="auth-pane">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-brandline">
            <img src={emblem} alt="" width="40" height="40" />
            <BrandWord />
          </div>
          <h1>{t('Вход')}</h1>
          <p className="auth-sub">{t('Введите логин и пароль')}</p>

          <div className="field">
            <label htmlFor="lg-name">{t('Логин')}</label>
            <input id="lg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Введите логин')} autoFocus autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="lg-pw">{t('Пароль')}</label>
            <PasswordInput id="lg-pw" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </div>

          {err && (
            <div className="note err auth-err" role="alert">
              <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{err}</span>
            </div>
          )}

          <button className="btn gold block auth-submit" disabled={busy}>
            <span className="ic"><LuLogIn size={17} /></span> {busy ? t('Вход…') : t('Войти')}
          </button>

          <div className="auth-foot">
            <span>{t('Логин и пароль выдаёт владелец')}</span>
            <div className="lang-switch" role="group" aria-label={t('Язык')}>
              {LANGS.map((l) => (
                <button
                  type="button"
                  key={l.key}
                  className={lang === l.key ? 'active' : ''}
                  aria-pressed={lang === l.key}
                  title={l.label}
                  onClick={() => setLang(l.key)}
                >
                  {l.key === 'tg' ? 'TJ' : 'RU'}
                </button>
              ))}
            </div>
          </div>
        </form>
      </main>
    </div>
  )
}
