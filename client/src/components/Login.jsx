import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LuLogIn, LuTriangleAlert, LuScanLine, LuBoxes, LuTrendingUp, LuWifiOff, LuKeyboard } from 'react-icons/lu'
import { login } from '../db/auth'
import { PasswordInput, BrandWord } from './ui'
import WindowButtons from './WindowButtons'
import VirtualKeyboard, { poleDlyaVvoda } from './VirtualKeyboard'
import { useT, useLang, setLang, LANGS } from '../lib/i18n'
import { bridge, isDesktop } from '../lib/desktop'
import { ActivateCard, ModeChoice, ResetCard, SetupCard, SoloLine } from './BezInterneta'
import { kassaFirst } from '../lib/permissions'
import emblem from '../assets/brand/emblem-192.webp'
import logoEmblem from '../assets/brand/logo-emblem.webp'
import logoWord from '../assets/brand/logo-word.webp'

// ── Экран входа ──
// Слева — кто мы: логотип FinMax POS на тёмно-синем (эмблема сверху, под ней надпись)
// и несколько строк о том, что умеет система. Справа — форма. На телефоне левая часть
// сжимается до полосы с именем: там человеку нужен только вход.
//
// Язык переключается прямо здесь: кассир, читающий по-таджикски, иначе видел бы
// русскую форму и не знал бы, что язык вообще можно сменить.
//
// В правом нижнем углу — экранная клавиатура (только на широком экране): у моноблока
// у кассы часто нет настоящей, а без неё не набрать ни логин, ни пароль
const poleVhoda = {
  get current() {
    return poleDlyaVvoda()
  },
}
// Русский / таджикский — на форме входа и под экранами до входа
function LangSwitch({ lang, t }) {
  return (
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
  )
}

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
  const [kb, setKb] = useState(false)
  const navigate = useNavigate()

  // ── Магазин без интернета (1.6.0) ──
  // Программа спрашивает основную часть: выбран ли способ работы, активирована ли, заведён ли
  // магазин. От этого зависит, что показать вместо формы входа
  const [solo, setSolo] = useState(null)
  const [soloView, setSoloView] = useState('')
  const [note, setNote] = useState('')
  const refreshSolo = useCallback(() => {
    if (!bridge?.standalone) return Promise.resolve(null)
    return bridge.standalone.info().then(
      (i) => {
        setSolo(i)
        return i
      },
      // Основная часть не ответила — обычный вход (false: спрашивали, ответа нет)
      () => {
        setSolo(false)
        return null
      },
    )
  }, [])
  useEffect(() => {
    refreshSolo()
  }, [refreshSolo])
  const soloMode = solo?.mode === 'standalone'
  // 1.7.0: кода активации нет (codeRequired: false) и способа работы не выбирают (offlineOnly) —
  // программа всегда без интернета. Прежняя основная часть этих полей не знает: как 1.6.0
  const codeNeeded = solo?.codeRequired !== false
  // Пока программа не ответила, что показывать, — ничего: иначе при первом запуске на миг
  // мелькала бы форма входа перед выбором способа работы
  const panel = solo === null
    ? bridge?.standalone ? '' : 'login'
    : !solo
      ? 'login'
      : solo.mode === '' && !solo.cloudAccounts && !solo.offlineOnly
      ? 'mode'
      : soloMode && codeNeeded && (!solo.activation?.active || soloView === 'renew')
        ? 'activate'
        : soloMode && !solo.shop
          ? 'setup'
          : soloMode && soloView === 'reset'
            ? 'reset'
            : 'login'

  // Магазин заведён — сразу вход владельца тем же паролем
  async function enterAfterSetup(login, password) {
    await refreshSolo()
    setName(login)
    try {
      await login_(login, password)
    } catch (e) {
      setErr(e.message || t('Не удалось войти'))
    }
  }
  async function login_(n, p) {
    const user = await login(n, p)
    if (kassaFirst(user)) navigate('/pos', { replace: true })
    return user
  }

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setErr('')
    setBusy(true)
    setNote('')
    try {
      // Кассир — всегда в кассу: экран могли заблокировать в другом разделе (владелец
      // ушёл из «Настроек»), и после входа кассир оказался бы там
      await login_(name.trim(), pw)
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
          <div className="auth-hero" role="img" aria-label="FinMax POS">
            <img className="auth-hero-emblem" src={logoEmblem} width="374" height="355" alt="" draggable="false" />
            <img className="auth-hero-word" src={logoWord} width="1311" height="214" alt="" draggable="false" />
          </div>
          <h2>{t('Касса, склад и смены — в одной системе')}</h2>
          <p>{t('Продажи, остатки и деньги магазина видны владельцу в любой момент — с компьютера и с телефона.')}</p>
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
        {/* Программа для Windows открыта на весь экран: свернуть и закрыть — здесь */}
        {isDesktop && (
          <div className="auth-win">
            <WindowButtons />
          </div>
        )}
        {panel === 'mode' && <ModeChoice onChosen={() => refreshSolo()} />}
        {panel === 'activate' && (
          <ActivateCard
            info={solo}
            onDone={() => {
              setSoloView('')
              // Прежняя ошибка входа закрыла бы это сообщение (оно показывается, когда ошибки нет)
              setErr('')
              setNote(t('Код принят — программа активирована.'))
              refreshSolo()
            }}
            // Назад — к выбору способа работы (пока магазин не заведён) или к форме входа
            onBack={soloView === 'renew' ? () => setSoloView('') : !solo?.shop ? () => bridge.standalone.mode('').then(() => refreshSolo()) : null}
          />
        )}
        {panel === 'setup' && <SetupCard info={solo} onDone={enterAfterSetup} />}
        {panel === 'reset' && (
          <ResetCard
            info={solo}
            onBack={() => setSoloView('')}
            onDone={(login) => {
              setSoloView('')
              setName(login)
              setPw('')
              setErr('')
              setNote(t('Пароль изменён — войдите с новым паролем.'))
            }}
          />
        )}
        {/* data-vkb-lift: экранная клавиатура поднимает форму над собой — «Войти» и язык видны */}
        {panel === 'login' && <form className="auth-card" onSubmit={submit} data-vkb-lift>
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

          {note && !err && <div className="note ok auth-err" role="status" data-testid="solo-note"><span>{note}</span></div>}
          {err && (
            <div className="note err auth-err" role="alert">
              <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{err}</span>
            </div>
          )}

          <button className="btn gold block auth-submit" disabled={busy}>
            <span className="ic"><LuLogIn size={17} /></span> {busy ? t('Вход…') : t('Войти')}
          </button>

          {soloMode && <SoloLine info={solo} onReset={() => setSoloView('reset')} onRenew={() => setSoloView('renew')} />}

          {/* «С интернетом» выбрали по ошибке, а войти ещё никто не успел — выбор можно поменять */}
          {solo && solo.mode === 'cloud' && !solo.cloudAccounts && (
            <button
              type="button"
              className="link solo-change-mode"
              onClick={() => bridge.standalone.mode('').then(() => refreshSolo(), () => {})}
              data-testid="solo-change-mode"
            >
              {t('Изменить способ работы')}
            </button>
          )}

          <div className="auth-foot">
            <span>{t('Логин и пароль выдаёт владелец')}</span>
            <LangSwitch lang={lang} t={t} />
          </div>
        </form>}

        {/* Язык — и на экранах до входа: выбор способа работы, активация, магазин, сброс пароля */}
        {panel && panel !== 'login' && (
          <div className="auth-lang">
            <LangSwitch lang={lang} t={t} />
          </div>
        )}

        {/* Клавиатура открыта — кнопки нет: она под клавишами, а закрыть можно «Закрыть» на самой клавиатуре */}
        {!kb && (
          <button
            type="button"
            className="btn ghost auth-kb"
            onClick={() => setKb(true)}
            title={t('Клавиатура')}
            aria-label={t('Клавиатура')}
            data-testid="login-kb"
          >
            <span className="ic"><LuKeyboard size={18} /></span> {t('Клавиатура')}
          </button>
        )}
      </main>
      {kb && <VirtualKeyboard fallbackRef={poleVhoda} onClose={() => setKb(false)} />}
    </div>
  )
}
