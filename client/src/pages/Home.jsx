import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { LuLogOut, LuMoon, LuSun, LuPower, LuLock, LuInfo } from 'react-icons/lu'
import Layout, { NAV, allowedNav } from '../components/Layout'
import { useCollection } from '../db/store'
import { useAuth, logout } from '../db/auth'
import { expiringProducts } from '../lib/expiry'
import { useLang, useT } from '../lib/i18n'
import { customerLabels, showCustomer } from '../lib/customerScreen'
import { useTheme, toggleTheme } from '../lib/theme'
import { isDesktop } from '../lib/desktop'
import { useCloseApp } from '../components/WindowButtons'

// ── Главный экран ──
// Открывается после входа вместо бокового меню: плитки с объёмными картинками одной
// сплошной сеткой, как на кассовом аппарате. Сетка одна на любом экране, кроме
// телефона: 6 колонок × 4 ряда, без прокрутки — плитки растягиваются под экран (см.
// index.css). Порядок разделов — как попросил владелец (NAV в Layout.jsx). Касса —
// главное действие: золотая и вдвое шире остальных. Раздел, на который у сотрудника нет
// права, остаётся на месте, но серый: человек видит, что такой раздел есть, и понимает,
// что его открывает владелец. Кассир (роль «Кассир») этого экрана не видит вовсе —
// после входа у него сразу касса (App.jsx).
//
// Кто вошёл, видно в полосе внизу окна (она одна на весь проект). Тема, выход и — в
// программе для Windows — «Закрыть программу» стоят в правом верхнем углу шапки,
// рядом с «О компании»: у кассы часто нет мыши с крестиком под рукой. На телефоне
// у этих кнопок остаются значки, подпись — во всплывающей подсказке.

export default function Home() {
  const user = useAuth()
  const t = useT()
  // Закрыть программу — с тем же вопросом, что и кнопка в полосе внизу
  const closeApp = useCloseApp()
  const theme = useTheme()
  const deferred = useCollection('deferred')
  const products = useCollection('products')
  const expiring = expiringProducts(products).length

  const temaText = theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')

  // Экран покупателя (программа для Windows): после входа, при входе в другой магазин и
  // при смене языка — название магазина и «Добро пожаловать». Корзину покажет касса
  const lang = useLang()
  const shop = user?.pharmacy?.name || ''
  useEffect(() => {
    showCustomer({ mode: 'idle', lang, shop, labels: customerLabels(t) })
  }, [lang, shop, t])

  // ── Код главных разделов — заранее, пока человек смотрит на главный экран ──
  // Первое открытие кассы, товаров или панели иначе ждёт загрузки своего кода — на
  // слабом компьютере (часто это Windows 7) это заметная пауза. Грузим по одному, когда
  // окно свободно, и только разделы, которые этому сотруднику открыты. Только в программе:
  // код у неё на диске, а сайт с телефона тратил бы на это трафик
  const role = user?.role
  useEffect(() => {
    if (!isDesktop) return undefined
    const open = (to) => {
      const n = NAV.find((x) => x.to === to)
      return !!n && allowedNav(user, n)
    }
    const jobs = []
    if (open('/pos')) jobs.push(() => import('./Pos'))
    if (open('/products')) jobs.push(() => import('./Products'))
    if (open('/dashboard')) jobs.push(() => import('./Dashboard'), () => import('../components/DashboardCharts'))
    let stopped = false
    let at = 0
    const idle = (fn) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 400))
    const next = () => {
      if (stopped || at >= jobs.length) return
      jobs[at++]().catch(() => {}).finally(() => idle(next))
    }
    const start = setTimeout(() => idle(next), 1500)
    return () => {
      stopped = true
      clearTimeout(start)
    }
    // Права меняются вместе с ролью — по ней и перезапускаем
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role])

  return (
    <Layout
      hub
      title={t('Главное меню')}
      subtitle={user?.pharmacy?.name || ''}
      actions={
        <div className="hub-acts">
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
          {NAV.map((n) => {
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
                  <Link key={n.to} to={n.to} className={cls} data-tour={'nav:' + n.to}>
                    {inner}
                  </Link>
                ) : (
                  <div
                    key={n.to}
                    className={cls}
                    data-tour={'nav:' + n.to}
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
