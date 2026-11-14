import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { LuCamera } from 'react-icons/lu'
import { isDesktop } from '../lib/desktop'
import { useT } from '../lib/i18n'

const CameraScanner = lazy(() => import('./CameraScanner'))

// ── Кнопка «Камера» у полей штрихкода (1.8.1) ──
// Мобильная версия: телефон или планшет (палец — основной указатель) с камерой.
// Нажали — окно камеры; код распознан — окно закрывается, а код уходит в onCode,
// как будто его отсканировал USB-сканер. На компьютере и в программе для Windows
// кнопки нет: там сканер, а у моноблока камера смотрит на кассира.
const QUERY = '(pointer: coarse)'
function subscribe(cb) {
  try {
    const m = window.matchMedia(QUERY)
    m.addEventListener?.('change', cb)
    return () => m.removeEventListener?.('change', cb)
  } catch {
    return () => {}
  }
}
function snapshot() {
  try {
    return !isDesktop && !!navigator.mediaDevices?.getUserMedia && window.matchMedia(QUERY).matches
  } catch {
    return false
  }
}

export function useKameraNuzhna() {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

// onCode(code) — распознанный код; label — подпись рядом со значком (по умолчанию
// только значок); testid — для проверок; always — показывать и на компьютере
export default function KameraKnopka({ onCode, label, testid, className = '', always = false, style }) {
  const t = useT()
  const nuzhna = useKameraNuzhna()
  const [open, setOpen] = useState(false)
  if (!nuzhna && !always) return null
  return (
    <>
      <button
        type="button"
        className={'btn ghost kamera-btn ' + className}
        data-testid={testid || 'kamera-btn'}
        title={t('Сканировать камерой')}
        aria-label={t('Сканировать камерой')}
        style={style}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <span className="ic"><LuCamera size={18} /></span>
        {label ? <span>{label}</span> : null}
      </button>
      {open && (
        <Suspense fallback={null}>
          <CameraScanner
            onDetect={(code) => {
              setOpen(false)
              onCode?.(code)
            }}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
