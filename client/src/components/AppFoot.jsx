import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LuCircleHelp, LuKeyboard, LuLayoutGrid, LuLock, LuUserRound } from 'react-icons/lu'
import { useAuth, logout } from '../db/auth'
import { useT } from '../lib/i18n'
import { startTour } from '../lib/tur'
import { isDesktop } from '../lib/desktop'
import SyncBadge from './SyncBadge'
import VirtualKeyboard from './VirtualKeyboard'
import WindowButtons from './WindowButtons'

// ── Полоса внизу окна: кто работает, «Меню», тур, экранная клавиатура, блокировка ──
// В программе для Windows — ещё «Свернуть» и «Закрыть программу»: она открыта на весь
// экран, и своих кнопок у окна не видно (см. WindowButtons.jsx).
// Одна на весь проект: на любой странице видно, под чьим именем работают, и экран
// можно закрыть, отходя от компьютера.
//
// razdel — открыт раздел, а не главный экран. Шапки у разделов нет, поэтому сюда
// переехали её кнопки: «Меню» (назад к плиткам) и «?» — тур по разделу (tour — тур
// у раздела есть). В программе для Windows слева встают значки версии, отправки и
// касс в сети. На главном экране всё это остаётся в его шапке.
//
// Полоса прикреплена к низу окна, а не «липнет»: у страницы задан overflow-x, и
// sticky внутри неё не держится (см. index.css). Место под неё оставляет класс
// has-foot на <html>: по нему страница отступает снизу, а уведомления и экранная
// клавиатура поднимаются над полосой. На узком экране подписи кнопок прячутся —
// остаются значки, подпись видна во всплывающей подсказке.
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

export default function AppFoot({ razdel = false, tour = false }) {
  const auth = useAuth()
  const t = useT()
  const { pathname } = useLocation()
  const naKasse = pathname === '/pos'
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
      <footer className={'app-foot' + (isDesktop ? ' desk' : '')} data-tour="app.foot">
        <div className="kf-left">
          <span className="kf-user" title={`${auth.name || ''} (${roleName})`}>
            <span className="ic"><LuUserRound size={15} /></span>
            <span className="kf-pre">{t('Кассир')}:</span> <b>{auth.name || '—'}</b> <span className="kf-role">({roleName})</span>
          </span>
          {razdel && isDesktop && <div className="kf-status"><SyncBadge /></div>}
        </div>
        <div className="kf-actions">
          {razdel && tour && (
            <button
              type="button"
              className="btn ghost sm icon kf-help"
              onClick={() => startTour(pathname)}
              data-tour="app.help"
              title={t('Тур по разделу')}
              aria-label={t('Тур по разделу')}
            >
              <LuCircleHelp size={17} />
            </button>
          )}
          {razdel && (
            <Link to="/" className="btn ghost sm kf-menu" data-tour="app.menu" title={t('Главное меню')} aria-label={t('Главное меню')}>
              <span className="ic"><LuLayoutGrid size={15} /></span> <span className="btn-text">{t('Меню')}</span>
            </Link>
          )}
          {naKasse && (
            <button
              type="button"
              className={'btn ghost sm kf-kb' + (kb ? ' on' : '')}
              onClick={() => setKb(!kb)}
              aria-pressed={kb}
              data-tour="app.keyboard"
              title={t('Клавиатура')}
              aria-label={t('Клавиатура')}
            >
              <span className="ic"><LuKeyboard size={15} /></span> <span className="btn-text">{t('Клавиатура')}</span>
            </button>
          )}
          <button type="button" className="btn ghost sm kf-lock" onClick={() => logout()} data-tour="app.lock" title={t('Блокировка')} aria-label={t('Блокировка')}>
            <span className="ic"><LuLock size={15} /></span> <span className="btn-text">{t('Блокировка')}</span>
          </button>
          <WindowButtons />
        </div>
      </footer>
    </>
  )
}
