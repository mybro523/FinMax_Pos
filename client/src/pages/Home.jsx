import { Link } from 'react-router-dom'
import { LuLogOut, LuMoon, LuSun, LuPower, LuLock, LuInfo } from 'react-icons/lu'
import Layout, { NAV, allowedNav } from '../components/Layout'
import { useCollection } from '../db/store'
import { useAuth, logout } from '../db/auth'
import { expiringProducts } from '../lib/expiry'
import { useT } from '../lib/i18n'
import { useTheme, toggleTheme } from '../lib/theme'
import { isDesktop, bridge } from '../lib/desktop'

// ── Главный экран ──
// Открывается после входа вместо бокового меню: квадратные плитки с объёмными
// картинками одной сплошной сеткой, как на кассовом аппарате. Заголовков групп нет
// и ряды не разрываются: разделы идут в порядке групп (продажи, склад, финансы,
// управление), и группа читается по соседям и картинке. Касса — главное действие:
// золотая и вдвое шире остальных. Раздел, на который у сотрудника нет права, остаётся
// на месте, но серый: человек видит, что такой раздел есть, и понимает, что его
// открывает владелец.
//
// Кто вошёл, видно в полосе внизу окна (она одна на весь проект). Тема, выход и — в
// программе для Windows — «Закрыть программу» стоят в правом верхнем углу шапки,
// рядом с «О компании»: у кассы часто нет мыши с крестиком под рукой. На телефоне
// у этих кнопок остаются значки, подпись — во всплывающей подсказке.

// Закрыть программу: просим основную часть, а если её нет (сайт) — окно само
const closeApp = () => {
  if (bridge?.app?.quit) bridge.app.quit().catch(() => window.close())
  else window.close()
}

export default function Home() {
  const user = useAuth()
  const t = useT()
  const theme = useTheme()
  const deferred = useCollection('deferred')
  const products = useCollection('products')
  const expiring = expiringProducts(products).length

  // Плитки подряд, без заголовков. Каждая помнит свою группу: общий тур подсвечивает группу целиком
  const items = []
  let группа = null
  for (const n of NAV) {
    if (n.section) группа = n.section
    else items.push({ ...n, группа })
  }
  const temaText = theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')

  return (
    <Layout
      hub
      title={t('Главное меню')}
      subtitle={user?.pharmacy?.name || ''}
      actions={
        // В программе для Windows рядом стоят ещё значки версии, отправки и касс в сети:
        // на экране уже 1700 у этих кнопок остаются значки, иначе название меню
        // сжимается в столбик (см. .hub-acts.desk в index.css)
        <div className={'hub-acts' + (isDesktop ? ' desk' : '')}>
          <Link to="/about" className="btn ghost" data-tour="hub.about" title={t('О компании')} aria-label={t('О компании')}>
            <span className="ic"><LuInfo size={16} /></span> <span className="btn-text">{t('О компании')}</span>
          </Link>
          <button type="button" className="btn ghost" onClick={toggleTheme} data-tour="hub.theme" title={temaText} aria-label={temaText}>
            <span className="ic">{theme === 'dark' ? <LuSun size={16} /> : <LuMoon size={16} />}</span> <span className="btn-text">{temaText}</span>
          </button>
          <button type="button" className="btn ghost" onClick={logout} data-tour="hub.logout" title={t('Выйти')} aria-label={t('Выйти')}>
            <span className="ic"><LuLogOut size={16} /></span> <span className="btn-text">{t('Выйти')}</span>
          </button>
          {isDesktop && (
            <button type="button" className="btn ghost" onClick={closeApp} data-tour="hub.quit" title={t('Закрыть программу')} aria-label={t('Закрыть программу')}>
              <span className="ic"><LuPower size={16} /></span> <span className="btn-text">{t('Закрыть программу')}</span>
            </button>
          )}
        </div>
      }
    >
      <div className="hub" data-tour="sidebar">
        <div className="hub-grid">
          {items.map((n) => {
                const ok = allowedNav(user, n)
                const badge = n.badge && deferred.length > 0 ? deferred.length : n.expiryBadge && expiring > 0 ? expiring : 0
                const cls = 'hub-tile' + (n.main ? ' gold wide' : '') + (ok ? '' : ' off')
                const inner = (
                  <>
                    <span className="hub-name">{t(n.label)}</span>
                    {/* Объёмная картинка раздела (Icons8 «3D Fluency», 100 px — размер бесплатной
                        лицензии, ссылка на Icons8 стоит внизу «О компании»): раздел узнаётся по
                        картинке, а не по надписи */}
                    <img className="hub-pic" src={`/menu/${n.to.slice(1)}.png`} alt="" width="100" height="100" loading="lazy" draggable="false" />
                    {badge > 0 && <span className={'hub-badge' + (n.expiryBadge ? ' warn' : '')}>{badge}</span>}
                    {!ok && <span className="hub-lock" aria-hidden="true"><LuLock size={14} /></span>}
                  </>
                )
                return ok ? (
                  <Link key={n.to} to={n.to} className={cls} data-tour={'nav:' + n.to} data-tour-grp={n.группа}>
                    {inner}
                  </Link>
                ) : (
                  <div
                    key={n.to}
                    className={cls}
                    data-tour={'nav:' + n.to}
                    data-tour-grp={n.группа}
                    title={t('Доступно по решению владельца')}
                    aria-disabled="true"
                  >
                    {inner}
                  </div>
                )
          })}
        </div>
      </div>
    </Layout>
  )
}
