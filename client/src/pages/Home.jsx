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
// Внизу — кто вошёл, тема и выход. В программе для Windows ещё «Закрыть программу»:
// у кассы часто нет мыши с крестиком под рукой.

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
  const roleName = user?.roleName || (user?.role === 'founder' ? t('Владелец') : t('Кассир'))

  return (
    <Layout
      hub
      title={t('Главное меню')}
      subtitle={user?.pharmacy?.name || ''}
      actions={
        <Link to="/about" className="btn ghost" data-tour="hub.about">
          <span className="ic"><LuInfo size={16} /></span> {t('О компании')}
        </Link>
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
                        лицензии, ссылка на Icons8 стоит на странице входа): раздел узнаётся по
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

        <div className="hub-user" data-tour="side.user">
          <div className="hub-user-info">
            <div className="hub-user-name">{user?.name || '—'}</div>
            <div className="hub-user-role">{roleName}</div>
          </div>
          <div className="hub-user-actions">
            <button className="btn ghost" onClick={toggleTheme}>
              <span className="ic">{theme === 'dark' ? <LuSun size={16} /> : <LuMoon size={16} />}</span>
              {theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')}
            </button>
            <button className="btn ghost" onClick={logout} data-tour="hub.logout">
              <span className="ic"><LuLogOut size={16} /></span> {t('Выйти')}
            </button>
            {isDesktop && (
              <button className="btn ghost" onClick={closeApp}>
                <span className="ic"><LuPower size={16} /></span> {t('Закрыть программу')}
              </button>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
