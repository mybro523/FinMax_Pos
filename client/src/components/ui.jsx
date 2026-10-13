import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { LuCheck, LuTriangleAlert, LuBanknote, LuQrCode, LuCreditCard, LuReceipt, LuEye, LuEyeOff } from 'react-icons/lu'
import { translate as tr } from '../lib/i18n'
import NumberInput from './NumberInput'

// Оверлеи рендерим не внутри контента страницы: тогда position:fixed всегда считается
// от экрана, и модалка стоит строго по центру экрана (родитель с transform/filter не
// может её «утащить» в область контента).
//
// Модалки страниц → в #overlay-root (он внутри .app, у которой нет transform): так они
// и центрируются по экрану, и корректно скрываются вместе со страницей, когда React
// подгружает чанк другой страницы. Если хоста ещё нет — откатываемся на <body>.
export const overlayHost = () => (typeof document === 'undefined' ? null : document.getElementById('overlay-root') || document.body)

const toOverlayHost = (node) => {
  const host = overlayHost()
  return host ? createPortal(node, host) : node
}

// Глобальные диалоги живут выше страниц (провайдер вне Suspense) — им нужен именно <body>,
// иначе после смены страницы портал указывал бы на удалённый хост.
const toBody = (node) => (typeof document === 'undefined' ? node : createPortal(node, document.body))

// ── Поле пароля с «глазком» (показать/скрыть) ──
export function PasswordInput({ value, onChange, ...props }) {
  const [show, setShow] = useState(false)
  return (
    <div className="pw-wrap">
      <input {...props} type={show ? 'text' : 'password'} value={value} onChange={onChange} />
      <button
        type="button"
        className="pw-eye"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? tr('Скрыть пароль') : tr('Показать пароль')}
        aria-pressed={show}
        title={show ? tr('Скрыть пароль') : tr('Показать пароль')}
      >
        {show ? <LuEyeOff size={17} /> : <LuEye size={17} />}
      </button>
    </div>
  )
}

// ── Имя бренда ──
// Набирается текстом, а не картинкой: на синем фоне синяя половина логотипа
// пропала бы. «Fin» золотом, «Max» цветом текста — как в шапке сайта FinMax.
export function BrandWord({ className }) {
  return (
    <span className={'brand-word' + (className ? ' ' + className : '')}>
      <span><span className="fin">Fin</span><span className="brand-max">Max</span></span>
      <span className="brand-pos">POS</span>
    </span>
  )
}

// ── Способы оплаты (единые иконки/подписи) ──
export const PAYMENTS = {
  cash: { label: 'Наличные', Icon: LuBanknote },
  card: { label: 'Карта', Icon: LuCreditCard },
  // Перевод через Alif, DC, Эсхата… — через какой сервис, хранит сам чек (payVia)
  transfer: { label: 'Перевод', Icon: LuQrCode },
  debt: { label: 'В долг', Icon: LuReceipt },
}

// via — сервис перевода из чека: «Перевод · Alif»
export function PayBadge({ type, via }) {
  const p = PAYMENTS[type] || PAYMENTS.cash
  return (
    <span className={'badge ' + type}>
      <p.Icon size={13} /> {tr(p.label)}{type === 'transfer' && via ? ` · ${via}` : ''}
    </span>
  )
}

// ── Тосты ──
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const timerRef = useRef(null)
  const show = useCallback((msg, type = 'ok') => {
    // Сбрасываем таймер предыдущего тоста, чтобы быстрые подряд сообщения не гасили друг друга
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast({ msg, type })
    timerRef.current = setTimeout(() => setToast(null), 2600)
  }, [])
  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={'toast ' + (toast.type === 'err' ? 'err' : '')} role="status" aria-live="polite">
          <span className="ic">{toast.type === 'err' ? <LuTriangleAlert size={17} /> : <LuCheck size={17} />}</span>
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

// Закрытие по клику на затемнённый фон — только если и нажатие, и отпускание были
// на самом фоне. Иначе выделение текста мышью с выходом за пределы окна закрывало бы
// модалку (браузер отправляет click на общего родителя) и терялось всё введённое.
export function useBackdropClose(onClose) {
  const down = useRef(false)
  const up = useRef(false)
  return {
    onPointerDown: (e) => {
      down.current = e.target === e.currentTarget
      up.current = false
    },
    onPointerUp: (e) => {
      up.current = e.target === e.currentTarget
    },
    onClick: (e) => {
      const closeIt = e.target === e.currentTarget && down.current && up.current
      down.current = false
      up.current = false
      if (closeIt) onClose?.()
    },
  }
}

// Закрытие оверлея по Escape
function useEscape(onClose) {
  useEffect(() => {
    if (!onClose) return
    const h = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
}

// ── Модалка ──
export function Modal({ title, children, onClose, className, wide }) {
  useEscape(onClose)
  const backdrop = useBackdropClose(onClose)
  return toOverlayHost(
    <div className={'overlay' + (className ? ' ' + className : '')} {...backdrop}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>,
  )
}

// ── Диалоги confirm/prompt (замена нативным alert/prompt/confirm) ──
const DialogCtx = createContext(null)
export const useDialog = () => useContext(DialogCtx)

export function DialogProvider({ children }) {
  const [req, setReq] = useState(null)

  const confirm = useCallback(
    (opts) => new Promise((resolve) => setReq({ kind: 'confirm', opts, resolve })),
    [],
  )
  const prompt = useCallback(
    (opts) => new Promise((resolve) => setReq({ kind: 'prompt', opts, resolve })),
    [],
  )
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt])

  return (
    <DialogCtx.Provider value={api}>
      {children}
      {req && (
        <DialogView
          req={req}
          onDone={(result) => {
            req.resolve(result)
            setReq(null)
          }}
        />
      )}
    </DialogCtx.Provider>
  )
}

function DialogView({ req, onDone }) {
  const { kind, opts } = req
  const fields = opts.fields || (kind === 'prompt' ? [{ name: 'value', label: opts.label || '' }] : [])
  const [vals, setVals] = useState(() => {
    const o = {}
    fields.forEach((f) => (o[f.name] = f.defaultValue ?? ''))
    return o
  })

  const cancel = () => onDone(kind === 'prompt' ? null : false)
  const ok = () => onDone(kind === 'prompt' ? vals : true)
  useEscape(cancel)
  const backdrop = useBackdropClose(cancel)

  return toBody(
    <div className="overlay" {...backdrop}>
      <div className="modal" style={{ maxWidth: 420 }} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>
          {opts.danger && <span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>}
          {opts.title}
        </h3>
        {opts.message && (
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>{opts.message}</p>
        )}
        {fields.map((f, i) => {
          const common = {
            id: 'dlg_' + f.name,
            value: vals[f.name],
            placeholder: f.placeholder,
            autoFocus: i === 0,
            onChange: (e) => setVals((v) => ({ ...v, [f.name]: e.target.value })),
            onKeyDown: (e) => e.key === 'Enter' && ok(),
          }
          return (
            <div className="field" key={f.name}>
              {f.label && <label htmlFor={'dlg_' + f.name}>{f.label}</label>}
              {f.type === 'password' ? (
                <PasswordInput {...common} autoComplete="new-password" />
              ) : f.type === 'number' ? (
                // Суммы в диалогах — те же деньги: минус и буквы сюда не попадают
                <NumberInput {...common} />
              ) : (
                <input {...common} type={f.type || 'text'} />
              )}
            </div>
          )
        })}
        <div className="modal-actions">
          <button className="btn ghost" onClick={cancel}>{opts.cancelText || tr('Отмена')}</button>
          <button className={'btn' + (opts.danger ? ' danger' : '')} onClick={ok}>
            {opts.confirmText || (kind === 'prompt' ? tr('Сохранить') : tr('Подтвердить'))}
          </button>
        </div>
      </div>
    </div>
  )
}
