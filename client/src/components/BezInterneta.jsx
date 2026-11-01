import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { LuArrowLeft, LuCloud, LuCopy, LuHardDrive, LuKeyRound, LuStore, LuTriangleAlert, LuBadgeCheck } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { useT } from '../lib/i18n'
import { CODE_LEN, caretAt, editCode, editEnd, formatCode, normalizeCode, pastedCode, physicalKey, soloMessage } from '../lib/aktivaciya'
import { PasswordInput } from './ui'

// ── Магазин без интернета (версия 1.6.0): экраны до входа ──
// Программу ставят с флешки на компьютер магазина, у которого интернета нет вовсе. При первом
// запуске выбирают способ работы; «без интернета» — дальше код активации от поставщика
// программы, магазин и владелец. Всё это делает основная часть программы (desktop/src/gateway.mjs,
// standalone): окно только спрашивает и показывает.

const solo = () => bridge?.standalone || null

// Ошибка — одна строка под полями
function Problem({ text }) {
  if (!text) return null
  return (
    <div className="note err auth-err" role="alert">
      <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{text}</span>
    </div>
  )
}

// ── Выбор способа работы ──
export function ModeChoice({ onChosen }) {
  const t = useT()
  const [err, setErr] = useState('')
  const pick = async (mode) => {
    setErr('')
    const r = await solo()?.mode(mode).catch(() => null)
    if (r?.ok) onChosen(mode)
    else setErr(t(r?.error || 'Не получилось. Повторите.'))
  }
  return (
    <div className="auth-card solo-card" data-testid="solo-mode">
      <h1>{t('Как будет работать программа?')}</h1>
      <p className="auth-sub">{t('Выберите один раз. Потом этот выбор не меняется.')}</p>
      <div className="solo-modes">
        <button type="button" className="solo-mode" onClick={() => pick('cloud')} data-testid="solo-mode-cloud">
          <span className="ic"><LuCloud size={22} /></span>
          <b>{t('С интернетом')}</b>
          <span>{t('Данные магазина на сервере FinMax: их видно на сайте и в телефоне, кассы в разных местах работают вместе.')}</span>
        </button>
        <button type="button" className="solo-mode" onClick={() => pick('standalone')} data-testid="solo-mode-standalone">
          <span className="ic"><LuHardDrive size={22} /></span>
          <b>{t('Без интернета')}</b>
          <span>{t('База магазина хранится на этом компьютере, интернет не нужен совсем. Нужен код активации от поставщика программы.')}</span>
        </button>
      </div>
      <Problem text={err} />
    </div>
  )
}

// ── Код этого компьютера: его сообщают поставщику программы ──
export function ComputerCode({ code }) {
  const t = useT()
  const [copied, setCopied] = useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied('ok')
    } catch {
      // Буфер обмена недоступен — код виден крупно, его можно выделить или продиктовать
      setCopied('fail')
    }
    setTimeout(() => setCopied(''), 2500)
  }
  return (
    <div className="solo-pc" data-testid="solo-computer">
      <span className="solo-pc-label">{t('Код этого компьютера')}</span>
      <span className="solo-pc-code" data-testid="solo-computer-code">{code || '—'}</span>
      {code && (
        <button type="button" className="btn ghost" onClick={copy} title={t('Скопировать')}>
          <span className="ic"><LuCopy size={15} /></span> {copied === 'ok' ? t('Скопировано') : t('Скопировать')}
        </button>
      )}
      {copied === 'fail' && <span className="solo-pc-label" role="status">{t('Скопировать не получилось — выделите код и скопируйте вручную')}</span>}
    </div>
  )
}

// ── Поле кода (активации или сброса): 10 групп по 5 знаков ──
// Раскладка клавиатуры не важна: русская буква, набранная на клавише латинской, становится
// латинской (по месту клавиши). Лишнее — дефисы, пробелы — не в счёт. Опечатку правят
// посреди кода: курсор остаётся на месте, Backspace и Delete перешагивают дефисы
export function CodeInput({ value, onChange, id, autoFocus }) {
  const t = useT()
  const raw = normalizeCode(value)
  // Поле показывает код с дефисами и строчные делает заглавными — после такой подмены
  // курсор у поля уходит в конец. Поле обновляем сразу, тут же, и курсор ставим на место:
  // следующая клавиша (а набирают быстро) попадёт уже туда
  const put = (el, { raw: next, before }) => {
    flushSync(() => onChange(next))
    const shown = formatCode(next)
    if (el.value !== shown) el.value = shown
    const pos = caretAt(before)
    el.setSelectionRange(pos, pos)
  }
  const onKeyDown = (e) => {
    const el = e.currentTarget
    const from = el.selectionStart ?? el.value.length
    const to = el.selectionEnd ?? from
    if (from === to && e.key === 'Backspace' && el.value[from - 1] === '-') el.setSelectionRange(from - 1, from - 1)
    if (from === to && e.key === 'Delete' && el.value[from] === '-') el.setSelectionRange(from + 1, from + 1)
    const ch = physicalKey(e)
    if (!ch) return
    e.preventDefault()
    put(el, editCode(el.value, from, to, ch))
  }
  const onInput = (e) => {
    const el = e.target
    const shown = formatCode(raw)
    // Набрал человек — место правки там, где курсор. Текст поставила программа (экранная
    // клавиатура): курсор у поля уже в конце — место правки по разнице с прежним текстом
    const at = e.nativeEvent?.isTrusted === false ? editEnd(shown, el.value) : el.selectionStart ?? el.value.length
    const next = editCode(el.value, at, at)
    // Стёрли только дефис (поле вернуло бы его на место, и стирание «не сработало бы»): стираем
    // знак кода перед ним
    if (next.raw === raw && el.value.length < shown.length && next.before > 0) {
      const cut = next.before - 1
      return put(el, { raw: raw.slice(0, cut) + raw.slice(next.before), before: cut })
    }
    put(el, next)
  }
  const onPaste = (e) => {
    const text = e.clipboardData?.getData('text')
    if (text == null) return
    e.preventDefault()
    const el = e.currentTarget
    const pasted = pastedCode(text)
    // Вставили код целиком — он и становится кодом, что бы ни было в поле (после «опечатки»
    // поле полное, и вставка в его середину дала бы чужой код)
    const whole = normalizeCode(pasted, Infinity)
    if (whole.length >= CODE_LEN) return put(el, { raw: whole.slice(0, CODE_LEN), before: CODE_LEN })
    const from = el.selectionStart ?? el.value.length
    put(el, editCode(el.value, from, el.selectionEnd ?? from, pasted))
  }
  return (
    <div className="solo-code-wrap">
      <input
        id={id}
        className="solo-code"
        value={formatCode(raw)}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        autoFocus={autoFocus}
        placeholder="XXXXX-XXXXX-XXXXX-…"
        aria-describedby={id + '-left'}
        // Курсор поле ставит само (экранная клавиатура его не трогает — см. VirtualKeyboard)
        data-vkb-caret="self"
        data-testid="solo-code"
      />
      <span className="tag-cat" id={id + '-left'}>{raw.length < CODE_LEN ? `${t('Осталось ввести знаков')}: ${CODE_LEN - raw.length}` : t('Код введён полностью')}</span>
    </div>
  )
}

// ── Активация ──
// expired — срок прежнего кода закончился (магазин уже заведён): тот же экран, другие слова
export function ActivateCard({ info, onDone, onBack }) {
  const t = useT()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const a = info?.activation || {}
  const submit = async (e) => {
    e.preventDefault()
    // Enter с экранной клавиатуры отправляет форму и при неполном коде (кнопка тогда выключена)
    if (busy || normalizeCode(code).length !== CODE_LEN) return
    setErr('')
    setBusy(true)
    const r = await solo()?.activate(code).catch(() => null)
    setBusy(false)
    if (r?.ok) onDone(r.activation)
    else setErr(t(r?.error || 'Не получилось. Повторите.'))
  }
  return (
    <form className="auth-card solo-card" onSubmit={submit} data-vkb-lift data-testid="solo-activate">
      {onBack && (
        <button type="button" className="btn ghost solo-back" onClick={onBack}>
          <span className="ic"><LuArrowLeft size={15} /></span> {t('Назад')}
        </button>
      )}
      <h1>{a.expired ? t('Срок работы программы закончился') : t('Активация программы')}</h1>
      <p className="auth-sub">
        {a.expired ? t('Данные магазина сохранены. Введите новый код активации — работа продолжится сразу.') : t('Сообщите код этого компьютера поставщику программы — по телефону или в мессенджере. В ответ он пришлёт код активации.')}
      </p>
      {info && !info.ready && (
        <div className="note err" style={{ marginBottom: 12 }}>
          {!info.computer
            ? t('Не удалось прочитать номер этого компьютера — обратитесь к поставщику программы.')
            : t('Программа собрана без ключа активации — обратитесь к поставщику программы.')}
        </div>
      )}
      <ComputerCode code={info?.computer} />
      <div className="field">
        <label htmlFor="solo-code">{t('Код активации')}</label>
        <CodeInput id="solo-code" value={code} onChange={(v) => { setCode(v); setErr('') }} autoFocus />
      </div>
      <Problem text={err} />
      <button className="btn gold block auth-submit" disabled={busy || normalizeCode(code).length !== CODE_LEN} data-testid="solo-activate-submit">
        <span className="ic"><LuBadgeCheck size={17} /></span> {busy ? t('Проверяем…') : t('Активировать')}
      </button>
    </form>
  )
}

// ── Магазин и владелец ──
export function SetupCard({ onDone }) {
  const t = useT()
  const [f, setF] = useState({ shopName: '', login: '', password: '', confirm: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setErr('')
    if (f.password !== f.confirm) return setErr(t('Пароли не совпадают'))
    setBusy(true)
    const r = await solo()?.setup({ shopName: f.shopName, login: f.login, password: f.password }).catch(() => null)
    setBusy(false)
    if (r?.ok) onDone(r.login, f.password)
    else setErr(t(r?.error || 'Не получилось. Повторите.'))
  }
  return (
    <form className="auth-card solo-card" onSubmit={submit} data-vkb-lift data-testid="solo-setup">
      <h1>{t('Новый магазин')}</h1>
      <p className="auth-sub">{t('Программа активирована. Назовите магазин и придумайте вход владельца — он увидит всё и заведёт кассиров.')}</p>
      <div className="field">
        <label htmlFor="solo-shop">{t('Название магазина')}</label>
        <input id="solo-shop" value={f.shopName} onChange={set('shopName')} placeholder={t('Как на вывеске — оно будет на чеке')} autoFocus maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="solo-login">{t('Логин владельца')}</label>
        <input id="solo-login" value={f.login} onChange={set('login')} autoComplete="username" maxLength={50} />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="solo-pw">{t('Пароль')}</label>
          <PasswordInput id="solo-pw" value={f.password} onChange={set('password')} autoComplete="new-password" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="solo-pw2">{t('Повторите')}</label>
          <PasswordInput id="solo-pw2" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </div>
      </div>
      <p className="tag-cat" style={{ marginTop: -4, marginBottom: 12 }}>{t('Запишите пароль: интернета нет, и забытый пароль вернёт только поставщик программы кодом сброса.')}</p>
      <Problem text={err} />
      <button className="btn gold block auth-submit" disabled={busy} data-testid="solo-setup-submit">
        <span className="ic"><LuStore size={17} /></span> {busy ? t('Заводим…') : t('Завести магазин')}
      </button>
      <p className="tag-cat solo-move-hint" data-testid="solo-move-hint">
        {t('Магазин переезжает со старого компьютера? Заведите его здесь, войдите и загрузите копию с флешки: «Настройки» → «Резервная копия» → «Загрузить копию».')}
      </p>
    </form>
  )
}

// ── Владелец забыл пароль: код сброса от поставщика программы ──
export function ResetCard({ info, onDone, onBack }) {
  const t = useT()
  const [code, setCode] = useState('')
  const [f, setF] = useState({ login: '', password: '', confirm: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    // Enter с экранной клавиатуры отправляет форму и при неполном коде (кнопка тогда выключена)
    if (busy || normalizeCode(code).length !== CODE_LEN) return
    setErr('')
    if (f.password !== f.confirm) return setErr(t('Пароли не совпадают'))
    setBusy(true)
    const r = await solo()?.reset({ code, login: f.login, password: f.password }).catch(() => null)
    setBusy(false)
    if (r?.ok) onDone(r.login)
    else setErr(t(r?.error || 'Не получилось. Повторите.'))
  }
  return (
    <form className="auth-card solo-card" onSubmit={submit} data-vkb-lift data-testid="solo-reset">
      <button type="button" className="btn ghost solo-back" onClick={onBack}>
        <span className="ic"><LuArrowLeft size={15} /></span> {t('Назад')}
      </button>
      <h1>{t('Сброс пароля владельца')}</h1>
      <p className="auth-sub">{t('Сообщите код этого компьютера поставщику программы — он пришлёт код сброса. Код действует три дня и только один раз.')}</p>
      <ComputerCode code={info?.computer} />
      <div className="field">
        <label htmlFor="solo-reset-code">{t('Код сброса')}</label>
        <CodeInput id="solo-reset-code" value={code} onChange={(v) => { setCode(v); setErr('') }} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="solo-reset-login">{t('Логин владельца')}</label>
        <input id="solo-reset-login" value={f.login} onChange={set('login')} placeholder={t('Если владелец один — можно не указывать')} autoComplete="username" />
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="solo-reset-pw">{t('Новый пароль')}</label>
          <PasswordInput id="solo-reset-pw" value={f.password} onChange={set('password')} autoComplete="new-password" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="solo-reset-pw2">{t('Повторите')}</label>
          <PasswordInput id="solo-reset-pw2" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </div>
      </div>
      <Problem text={err} />
      <button className="btn gold block auth-submit" disabled={busy || normalizeCode(code).length !== CODE_LEN} data-testid="solo-reset-submit">
        <span className="ic"><LuKeyRound size={17} /></span> {busy ? t('Проверяем…') : t('Сбросить пароль')}
      </button>
    </form>
  )
}

// ── Под формой входа: магазин без интернета, до какого дня, забыли пароль ──
export function SoloLine({ info, onReset, onRenew }) {
  const t = useT()
  const a = info?.activation || {}
  if (!info?.shop) return null
  return (
    <div className={'solo-line' + (a.warn ? ' warn' : '')} data-testid="solo-line">
      <span>
        <LuHardDrive size={13} style={{ verticalAlign: '-2px' }} /> {t('Без интернета')} · {a.forever ? t('без срока') : `${t('работает до')} ${a.untilHuman}`}
        {a.registers ? ` · ${t('касс')}: ${a.registers}` : ''}
      </span>
      <span className="solo-line-links">
        <button type="button" className="link" onClick={onRenew} data-testid="solo-renew">{t('Ввести новый код')}</button>
        <button type="button" className="link" onClick={onReset} data-testid="solo-forgot">{t('Забыли пароль?')}</button>
      </span>
    </div>
  )
}

// ── «Настройки»: программа без интернета — срок, кассы, код компьютера, новый код ──
export function ActivationPanel() {
  const t = useT()
  const [info, setInfo] = useState(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => solo()?.info().then(setInfo, () => {})
  useEffect(() => {
    load()
  }, [])
  const a = info?.activation || {}
  const submit = async (e) => {
    e.preventDefault()
    // Enter с экранной клавиатуры отправляет форму и при неполном коде (кнопка тогда выключена)
    if (busy || normalizeCode(code).length !== CODE_LEN) return
    setErr('')
    setOk('')
    setBusy(true)
    const r = await solo()?.activate(code).catch(() => null)
    setBusy(false)
    if (r?.ok) {
      setCode('')
      setOk(r.activation?.forever ? t('Код принят: программа работает без срока.') : `${t('Код принят: программа работает до')} ${r.activation?.untilHuman}.`)
      load()
    } else setErr(t(r?.error || 'Не получилось. Повторите.'))
  }
  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="solo-panel">
      <h2><span className="h2-title"><span className="ic"><LuHardDrive size={17} /></span>{t('Программа без интернета')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 10 }}>
        {t('База магазина хранится на этом компьютере. Сохраняйте копию на флешку хотя бы раз в неделю: «Настройки» → «Резервная копия» → «Сохранить копию в…».')}
      </p>
      <div className="solo-rows">
        <div><span>{t('Работает')}</span><b className={a.warn || a.expired ? 'sync-bad' : ''}>{a.forever ? t('без срока') : a.untilHuman ? `${t('до')} ${a.untilHuman}` : '—'}</b></div>
        <div><span>{t('Касс можно подключить')}</span><b>{a.registers || '—'}</b></div>
      </div>
      {soloMessage(a, t) && <div className={'note ' + (a.expired ? 'err' : 'warn')} style={{ margin: '10px 0' }}>{soloMessage(a, t)}</div>}
      <ComputerCode code={info?.computer} />
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="solo-new-code">{t('Новый код активации')}</label>
          <CodeInput id="solo-new-code" value={code} onChange={(v) => { setCode(v); setErr(''); setOk('') }} />
        </div>
        <Problem text={err} />
        {ok && <div className="note ok" style={{ marginBottom: 10 }}>{ok}</div>}
        <button className="btn" disabled={busy || normalizeCode(code).length !== CODE_LEN} data-testid="solo-panel-submit">{busy ? t('Проверяем…') : t('Ввести код')}</button>
      </form>
    </div>
  )
}
