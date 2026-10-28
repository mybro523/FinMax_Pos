import { useLocation, useNavigate } from 'react-router-dom'
import { LuInfo, LuLayoutGrid, LuMoon, LuSun } from 'react-icons/lu'
import { Modal } from './ui'
import { NAV, allowedNav } from './Layout'
import { useAuth } from '../db/auth'
import { useT } from '../lib/i18n'
import { useTheme, toggleTheme } from '../lib/theme'

// ── «Меню» кассира ──
// Кассир (встроенная роль «Кассир») плиток главного меню не видит: после входа сразу
// открывается касса. Кнопка «Меню» в полосе внизу открывает посреди экрана это окно —
// столбик крупных строк с картинками, как привычное меню кассовых программ: только
// разделы, открытые его роли, в том же порядке, что плитки у владельца. Ниже — «О компании»
// и тема: у кассира нет шапки главного меню, где они стоят у владельца.
export default function KassirMenu({ onClose }) {
  const user = useAuth()
  const t = useT()
  const theme = useTheme()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const items = NAV.filter((n) => allowedNav(user, n))
  const go = (to) => {
    onClose()
    if (to !== pathname) navigate(to)
  }
  const temaText = theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')
  return (
    <Modal
      className="km-overlay"
      title={<><span className="ic"><LuLayoutGrid size={18} /></span>{t('Меню')}</>}
      onClose={onClose}
    >
      <nav className="km-list" aria-label={t('Разделы')} data-testid="kassir-menu">
        {items.map((n) => (
          <button
            key={n.to}
            type="button"
            className={'km-item' + (n.main ? ' gold' : '') + (n.to === pathname ? ' current' : '')}
            aria-current={n.to === pathname ? 'page' : undefined}
            onClick={() => go(n.to)}
          >
            <img className="km-pic" src={`/menu/${n.to.slice(1)}.png`} alt="" width="40" height="40" draggable="false" />
            <span className="km-name">{t(n.label)}</span>
          </button>
        ))}
      </nav>
      <div className="km-extra">
        <button type="button" className="km-item small" onClick={() => go('/about')}>
          <span className="km-ic"><LuInfo size={20} /></span>
          <span className="km-name">{t('О компании')}</span>
        </button>
        <button type="button" className="km-item small" onClick={toggleTheme}>
          <span className="km-ic">{theme === 'dark' ? <LuSun size={20} /> : <LuMoon size={20} />}</span>
          <span className="km-name">{temaText}</span>
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </Modal>
  )
}
