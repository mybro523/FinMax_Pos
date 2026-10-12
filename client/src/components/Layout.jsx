import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LuLayoutDashboard, LuShoppingCart, LuPill, LuPackagePlus,
  LuClipboardList, LuReceipt, LuTrendingUp, LuSettings, LuMenu, LuX, LuClock, LuTag, LuCalculator, LuWifiOff,
  LuUsers, LuLogOut, LuCalendarClock, LuUndo2, LuTrash2, LuClipboardCheck, LuTriangleAlert,
  LuGraduationCap, LuCircleHelp, LuHandCoins, LuTruck, LuSun, LuMoon,
} from 'react-icons/lu'
import { useCollection, useConnection } from '../db/store'
import { useAuth, logout, leavePharmacy } from '../db/auth'
import { expiringProducts } from '../lib/expiry'
import { useT } from '../lib/i18n'
import { startTour } from '../lib/tur'
import { isDesktop } from '../lib/desktop'
import SyncBadge from './SyncBadge'
import { BrandWord } from './ui'
import { useTheme, toggleTheme } from '../lib/theme'
import emblem from '../assets/brand/emblem-64.png'

export const NAV = [
  { section: 'Продажи' },
  { to: '/', label: 'Панель управления', Icon: LuLayoutDashboard, end: true, founderOnly: true },
  { to: '/pos', label: 'Касса', Icon: LuShoppingCart },
  { to: '/returns', label: 'Возврат товара', Icon: LuUndo2 },
  { section: 'Склад' },
  { to: '/products', label: 'Товары', Icon: LuPill },
  { to: '/arrivals', label: 'Приход товара', Icon: LuPackagePlus },
  { to: '/expiry', label: 'Срок годности', Icon: LuCalendarClock, expiryBadge: true },
  { to: '/writeoffs', label: 'Списание', Icon: LuTrash2, founderOnly: true },
  { to: '/inventory', label: 'Инвентаризация', Icon: LuClipboardCheck, founderOnly: true },
  { to: '/deferred', label: 'Отложенные штрихкоды', Icon: LuClock, badge: true },
  { to: '/orders', label: 'Авто-заявка', Icon: LuClipboardList },
  { section: 'Финансы' },
  { to: '/shift', label: 'Смена кассы', Icon: LuCalculator },
  { to: '/debts', label: 'Долги клиентов', Icon: LuReceipt },
  { to: '/discounts', label: 'История скидок', Icon: LuTag },
  { to: '/suppliers', label: 'Поставщики', Icon: LuTruck, founderOnly: true },
  { to: '/expenses', label: 'Расходы', Icon: LuHandCoins, founderOnly: true },
  { to: '/reports', label: 'Отчёты', Icon: LuTrendingUp, founderOnly: true },
  { section: 'Управление' },
  { to: '/employees', label: 'Сотрудники', Icon: LuUsers, founderOnly: true },
  { to: '/settings', label: 'Настройки', Icon: LuSettings },
  // Обучение стоит последним и отдельно от рабочих разделов: в него заходят
  // не по делу, а когда забыли, как что-то делается
  { to: '/obuchenie', label: 'Обучение', Icon: LuGraduationCap, help: true },
]

// ── Меню помнит, докуда его пролистали ──
// Рамку с меню каждая страница рисует сама, поэтому при переходе в другой раздел меню
// появляется заново — пролистанным в самый верх. Нажал внизу «Сотрудники», а пункт, по
// которому только что нажал, уехал за край: приходилось листать меню после каждого
// нажатия. Положение хранится здесь, вне страницы, и возвращается меню раньше, чем его
// успеют показать.
let navScroll = 0

// Пункт открытого раздела должен быть виден. В раздел попадают и мимо меню — по ссылке,
// кнопкой «назад», после перезагрузки страницы; тогда меню докручивается до него само.
// Считаем руками, а не scrollIntoView: тот прокрутил бы заодно и страницу
function keepActiveVisible(nav) {
  const active = nav.querySelector('a.active')
  if (!active) return
  const pad = 8
  const top = active.offsetTop - nav.offsetTop
  const bottom = top + active.offsetHeight
  if (top < nav.scrollTop) nav.scrollTop = Math.max(0, top - pad)
  else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight + pad
}

// Меню под роль: убираем пункты не для этой роли, а затем заголовки разделов,
// под которыми не осталось ни одного пункта (чтобы не висел пустой заголовок).
function navFor(isFounder) {
  const items = NAV.filter((n) => !n.founderOnly || isFounder)
  return items.filter((n, i) => !n.section || (items[i + 1] && !items[i + 1].section))
}

export default function Layout({ title, subtitle, actions, fill, children }) {
  const [open, setOpen] = useState(false)
  const deferred = useCollection('deferred')
  const products = useCollection('products')
  const conn = useConnection()
  const user = useAuth()
  const t = useT()
  const theme = useTheme()
  const location = useLocation()
  const isFounder = user?.role === 'founder'
  const expiringCount = expiringProducts(products).length
  // Состояние подписки приходит вместе с «кто я». Предупреждаем заранее, чтобы
  // кассир не встретил отказ посреди продажи, а владелец успел оплатить.
  const sub = user?.subscription
  // Владелец сервиса смотрит эту аптеку от имени её владельца. Показываем крупно
  // и постоянно: перепутать чужую аптеку со своей — самая дорогая из возможных
  // ошибок поддержки.
  const support = user?.impersonatedBy

  // ── Тур просит открыть или закрыть меню ──
  // На телефоне меню спрятано, а шаги общего тура показывают именно его.
  // Состоянием меню владеет эта страница — тур просит событием, а не лезет внутрь.
  useEffect(() => {
    const onMenu = (e) => setOpen(!!e.detail)
    window.addEventListener('tur:menu', onMenu)
    return () => window.removeEventListener('tur:menu', onMenu)
  }, [])

  // Меню возвращается туда, где его оставили, — до того, как страницу покажут
  const navRef = useRef(null)
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    nav.scrollTop = navScroll
    keepActiveVisible(nav)
    navScroll = nav.scrollTop
    // Положение запоминается и в тот миг, когда страницу убирают. Одного события
    // прокрутки мало: оно приходит с задержкой, и нажатие сразу после прокрутки
    // успевало раньше него — меню возвращалось туда, где было до прокрутки.
    // Спрятанное меню (высоты нет) не спрашиваем: у него положение всегда ноль
    return () => {
      if (nav.clientHeight > 0) navScroll = nav.scrollTop
    }
  }, [location.pathname, isFounder])

  // Тур по разделу есть у каждого пункта меню, кроме самого «Обучения»:
  // что у каждого пункта есть урок, стережёт отдельная проверка
  const hasTour = NAV.some((n) => n.to === location.pathname && !n.help)

  // Каждый пункт меню помнит свою группу: общий тур подсвечивает группу целиком
  let группа = null
  const пункты = navFor(isFounder).map((n) => {
    if (n.section) группа = n.section
    return { ...n, группа }
  })

  return (
    <div className="app">
      {open && <div className="nav-backdrop" onClick={() => setOpen(false)} />}

      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="brand">
          <span className="logo"><img src={emblem} alt="" width="26" height="26" /></span>
          <span className="brand-name">
            <BrandWord />
            {/* Под именем системы — имя аптеки: в какой из них сейчас работают */}
            <small title={user?.pharmacy?.name || ''}>{user?.pharmacy?.name || t('Касса и склад')}</small>
          </span>
          <button className="nav-close" onClick={() => setOpen(false)} aria-label="Закрыть меню">
            <LuX size={16} />
          </button>
        </div>
        <nav
          data-tour="sidebar"
          ref={navRef}
          onScroll={(e) => {
            if (e.currentTarget.clientHeight > 0) navScroll = e.currentTarget.scrollTop
          }}
        >
          {пункты.map((n, i) =>
            n.section ? (
              <div key={'s' + i} className="nav-section" data-tour-grp={n.section}>{t(n.section)}</div>
            ) : (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                data-tour={'nav:' + n.to}
                data-tour-grp={n.группа}
                className={({ isActive }) => (isActive ? 'active' : '')}
                onClick={() => setOpen(false)}
              >
                <span className="ic"><n.Icon size={18} /></span>
                {t(n.label)}
                {n.badge && deferred.length > 0 && <span className="nav-badge">{deferred.length}</span>}
                {n.expiryBadge && expiringCount > 0 && <span className="nav-badge warn">{expiringCount}</span>}
              </NavLink>
            ),
          )}
        </nav>
        <div className="side-user" data-tour="side.user">
          <div className="su-info">
            <div className="su-name">{user?.name || '—'}</div>
            <div className="su-role">{isFounder ? t('Основатель') : t('Кассир')}</div>
          </div>
          <button
            className="su-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')}
            aria-label={theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')}
          >
            {theme === 'dark' ? <LuSun size={16} /> : <LuMoon size={16} />}
          </button>
          <button className="su-logout" onClick={logout} title={t('Выйти')} aria-label={t('Выйти')}><LuLogOut size={16} /></button>
        </div>
      </aside>

      {/* fill — раздел сам занимает всю высоту окна и листается внутри себя (касса
          на широком экране). Остальные разделы растут вниз и листаются страницей */}
      <div className={'main' + (fill ? ' main-fill' : '')}>
        {support && (
          <div className="conn-banner support">
            <span className="ic"><LuTriangleAlert size={15} /></span>
            {t('Вы смотрите чужую аптеку от имени владельца')} — {user?.pharmacy?.name || user?.name}
            <button className="back" onClick={() => leavePharmacy()}>{t('вернуться к себе')}</button>
          </div>
        )}
        {/* ── Про подписку здесь больше не говорим ──
            Раньше над каждым разделом висела оранжевая полоса «подписка
            заканчивается». Владелец сервиса попросил убрать её отовсюду, кроме
            «Настроек»: кассир к деньгам за программу отношения не имеет, а полоса
            весь день маячила у него перед глазами.

            Там, где отказ действительно мешает работать, объяснение осталось
            на месте: касса при закрытых продажах пишет об этом прямо в окне
            оплаты. Упереться в отказ без причины кассир не должен. */}
        {/* В программе для Windows о связи говорит значок в шапке: касса там работает
            и без интернета, и полоса «нет связи» только пугала бы */}
        {conn === 'error' && !isDesktop && (
          <div className="conn-banner">
            <span className="ic"><LuWifiOff size={15} /></span>
            {t('Нет связи с сервером — показаны сохранённые данные, изменения синхронизируются автоматически')}
          </div>
        )}
        <header className="topbar">
          <div className="topbar-left">
            <button className="burger" onClick={() => setOpen(true)} aria-label="Меню">
              <LuMenu size={20} />
            </button>
            <div>
              <h1 data-tour="page.title">{title}</h1>
              {subtitle && <div className="sub">{subtitle}</div>}
            </div>
          </div>
          {(actions || hasTour || isDesktop) && (
            <div className="topbar-actions">
              {isDesktop && <SyncBadge />}
              {hasTour && (
                <button
                  className="btn ghost icon tur-help"
                  data-tour="topbar.help"
                  onClick={() => startTour(location.pathname)}
                  title={t('Тур по разделу')}
                  aria-label={t('Тур по разделу')}
                >
                  <LuCircleHelp size={18} />
                </button>
              )}
              {actions}
            </div>
          )}
        </header>
        <main className="content" key={location.pathname}>{children}</main>
      </div>

      {/* Хост для модалок страницы. Лежит внутри .app (у неё нет transform, поэтому
          position:fixed по-прежнему считается от экрана), но при этом React прячет его
          вместе со страницей, когда подгружает чанк другой страницы (Suspense). */}
      <div id="overlay-root" />
    </div>
  )
}
