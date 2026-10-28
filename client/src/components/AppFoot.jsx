import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LuCircleHelp, LuKeyboard, LuLayoutGrid, LuLock, LuUserRound } from 'react-icons/lu'
import { useAuth, logout } from '../db/auth'
import { useT } from '../lib/i18n'
import { startTour } from '../lib/tur'
import { kassaFirst } from '../lib/permissions'
import VirtualKeyboard, { poleDlyaVvoda } from './VirtualKeyboard'
import WindowButtons from './WindowButtons'
import KassirMenu from './KassirMenu'

// ── Полоса внизу окна: кто работает, «Меню», тур, экранная клавиатура, блокировка ──
// В программе для Windows — ещё «Свернуть» и «Закрыть программу»: она открыта на весь
// экран, и своих кнопок у окна не видно (см. WindowButtons.jsx).
// Одна на весь проект: на любой странице видно, под чьим именем работают, и экран
// можно закрыть, отходя от компьютера. Высокая, с крупными подписями: у кассы на неё
// нажимают пальцем.
//
// razdel — открыт раздел, а не главный экран. Шапки у разделов нет, поэтому сюда
// переехали её кнопки: «Меню» (назад к плиткам) и «?» — тур по разделу (tour — тур
// у раздела есть). У кассира (роль «Кассир») плиток нет: «Меню» открывает окно со
// списком его разделов (KassirMenu.jsx). Значки версии, отправки и касс в сети живут
// только в «Настройках» (вкладка «Профиль»).
//
// Полоса прикреплена к низу окна, а не «липнет»: у страницы задан overflow-x, и
// sticky внутри неё не держится (см. index.css). Место под неё оставляет класс
// has-foot на <html>: по нему страница отступает снизу, а уведомления и экранная
// клавиатура поднимаются над полосой. На узком экране подписи кнопок прячутся —
// остаются значки, подпись видна во всплывающей подсказке.
//
// Экранная клавиатура — в каждом разделе (на главном экране полей нет), только на
// широком экране: моноблок у кассы часто без клавиатуры, а телефон и планшет носят
// свою. Она печатает в поле, где стоит курсор, а если курсора нет — в поле с пометкой
// data-vkb-default (поле сканера кассы) или в первое поле страницы. Клавиатура лежит
// поверх страницы и ничего не сдвигает. Ушли из раздела — клавиатура закрылась: у каждой
// страницы полоса своя
const poleStranicy = {
  get current() {
    return poleDlyaVvoda()
  },
}

export default function AppFoot({ razdel = false, tour = false }) {
  const auth = useAuth()
  const t = useT()
  const { pathname } = useLocation()
  const [kb, setKb] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('has-foot')
    return () => document.documentElement.classList.remove('has-foot')
  }, [])

  if (!auth) return null
  const roleName = auth.roleName || (auth.role === 'founder' ? t('Владелец') : t('Кассир'))
  const kassir = kassaFirst(auth)

  return (
    <>
      {razdel && kb && <VirtualKeyboard fallbackRef={poleStranicy} onClose={() => setKb(false)} />}
      {menu && <KassirMenu onClose={() => setMenu(false)} />}
      <footer className="app-foot" data-tour="app.foot">
        <div className="kf-left">
          <span className="kf-user" title={`${auth.name || ''} (${roleName})`}>
            <span className="ic"><LuUserRound size={18} /></span>
            <span className="kf-pre">{t('Кассир')}:</span> <b>{auth.name || '—'}</b> <span className="kf-role">({roleName})</span>
          </span>
        </div>
        <div className="kf-actions">
          {razdel && tour && (
            <button
              type="button"
              className="btn ghost icon kf-help"
              onClick={() => startTour(pathname)}
              data-tour="app.help"
              title={t('Тур по разделу')}
              aria-label={t('Тур по разделу')}
            >
              <LuCircleHelp size={20} />
            </button>
          )}
          {razdel && kassir && (
            <button
              type="button"
              className={'btn ghost kf-menu' + (menu ? ' on' : '')}
              onClick={() => setMenu(true)}
              data-tour="app.menu"
              title={t('Меню')}
              aria-label={t('Меню')}
              aria-haspopup="dialog"
            >
              <span className="ic"><LuLayoutGrid size={18} /></span> <span className="btn-text">{t('Меню')}</span>
            </button>
          )}
          {razdel && !kassir && (
            <Link to="/" className="btn ghost kf-menu" data-tour="app.menu" title={t('Главное меню')} aria-label={t('Главное меню')}>
              <span className="ic"><LuLayoutGrid size={18} /></span> <span className="btn-text">{t('Меню')}</span>
            </Link>
          )}
          {razdel && (
            <button
              type="button"
              className={'btn ghost kf-kb' + (kb ? ' on' : '')}
              onClick={() => setKb(!kb)}
              aria-pressed={kb}
              data-tour="app.keyboard"
              title={t('Клавиатура')}
              aria-label={t('Клавиатура')}
            >
              <span className="ic"><LuKeyboard size={18} /></span> <span className="btn-text">{t('Клавиатура')}</span>
            </button>
          )}
          <button type="button" className="btn ghost kf-lock" onClick={() => logout()} data-tour="app.lock" title={t('Блокировка')} aria-label={t('Блокировка')}>
            <span className="ic"><LuLock size={18} /></span> <span className="btn-text">{t('Блокировка')}</span>
          </button>
          <WindowButtons className="btn ghost" />
        </div>
      </footer>
    </>
  )
}
