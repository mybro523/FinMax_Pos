import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
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
// Экранная клавиатура — только в кассе: в меню и других разделах её кнопки нет. Она
// печатает в поле, где стоит курсор, а если курсора нет — в поле с пометкой
// data-vkb-default (поле сканера). Ушли из кассы — клавиатура закрылась: у каждой
// страницы полоса своя, и при возвращении касса откроется без неё
const poleSkanera = {
  get current() {
    return typeof document !== 'undefined' ? document.querySelector('[data-vkb-default]') : null
  },
}

export default function AppFoot() {
  const auth = useAuth()
  const t = useT()
  const naKasse = useLocation().pathname === '/pos'
  const [kb, setKb] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('has-foot')
    return () => document.documentElement.classList.remove('has-foot')
  }, [])

  if (!auth) return null
  const roleName = auth.roleName || (auth.role === 'founder' ? t('Владелец') : t('Кассир'))

  return (
    <>
      {naKasse && kb && <VirtualKeyboard fallbackRef={poleSkanera} onClose={() => setKb(false)} />}
      <footer className="app-foot" data-tour="app.foot">
        <span className="kf-user" title={`${auth.name || ''} (${roleName})`}>
          <span className="ic"><LuUserRound size={15} /></span>
          {t('Кассир')}: <b>{auth.name || '—'}</b> <span className="kf-role">({roleName})</span>
        </span>
        <div className="kf-actions">
          {naKasse && (
            <button type="button" className={'btn ghost sm kf-kb' + (kb ? ' on' : '')} onClick={() => setKb(!kb)} aria-pressed={kb} data-tour="app.keyboard">
              <span className="ic"><LuKeyboard size={15} /></span> {t('Клавиатура')}
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => logout()} data-tour="app.lock">
            <span className="ic"><LuLock size={15} /></span> {t('Блокировка')}
          </button>
        </div>
      </footer>
    </>
  )
}
