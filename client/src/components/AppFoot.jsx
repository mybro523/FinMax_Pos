import { useEffect, useState } from 'react'
import { LuKeyboard, LuLock, LuUserRound } from 'react-icons/lu'
import { useAuth, logout } from '../db/auth'
import { useT } from '../lib/i18n'
import VirtualKeyboard from './VirtualKeyboard'

// ── Полоса внизу окна: кто работает, экранная клавиатура, блокировка ──
// Одна на весь проект, как шапка сверху, только внизу: на любой странице видно, под
// чьим именем работают, и экран можно закрыть, отходя от компьютера. Раньше она
// была только в кассе.
//
// Полоса прикреплена к низу окна, а не «липнет»: у страницы задан overflow-x, и
// sticky внутри неё не держится (см. index.css). Место под неё оставляет класс
// has-foot на <html>: по нему страница отступает снизу, а уведомления и экранная
// клавиатура поднимаются над полосой.
//
// Экранная клавиатура печатает в поле, где стоит курсор, а если курсора нет — в
// поле с пометкой data-vkb-default (в кассе это поле сканера). Открытая клавиатура
// остаётся открытой и при переходе в другой раздел.
const poleSkanera = {
  get current() {
    return typeof document !== 'undefined' ? document.querySelector('[data-vkb-default]') : null
  },
}
let kbOtkryta = false

export default function AppFoot() {
  const auth = useAuth()
  const t = useT()
  const [kb, setKbState] = useState(kbOtkryta)
  const setKb = (v) => {
    kbOtkryta = v
    setKbState(v)
  }

  // Клавиатура живёт в слое окон страницы (#overlay-root). При переходе в другой
  // раздел этот слой у новой страницы появляется только вместе с ней — до этого
  // клавиатура «прицепилась» бы к слою старой страницы и исчезла вместе с ней.
  // Поэтому показываем её, когда страница уже на месте
  const [gotovo, setGotovo] = useState(false)
  useEffect(() => {
    document.documentElement.classList.add('has-foot')
    setGotovo(true)
    return () => document.documentElement.classList.remove('has-foot')
  }, [])

  if (!auth) return null
  const roleName = auth.roleName || (auth.role === 'founder' ? t('Владелец') : t('Кассир'))

  return (
    <>
      {kb && gotovo && <VirtualKeyboard fallbackRef={poleSkanera} onClose={() => setKb(false)} />}
      <footer className="app-foot" data-tour="app.foot">
        <span className="kf-user" title={`${auth.name || ''} (${roleName})`}>
          <span className="ic"><LuUserRound size={15} /></span>
          {t('Кассир')}: <b>{auth.name || '—'}</b> <span className="kf-role">({roleName})</span>
        </span>
        <div className="kf-actions">
          <button type="button" className={'btn ghost sm kf-kb' + (kb ? ' on' : '')} onClick={() => setKb(!kb)} aria-pressed={kb} data-tour="app.keyboard">
            <span className="ic"><LuKeyboard size={15} /></span> {t('Клавиатура')}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => logout()} data-tour="app.lock">
            <span className="ic"><LuLock size={15} /></span> {t('Блокировка')}
          </button>
        </div>
      </footer>
    </>
  )
}
