import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LuLayoutDashboard, LuShoppingCart, LuPill, LuPackagePlus, LuLayoutGrid,
  LuClipboardList, LuReceipt, LuTrendingUp, LuSettings, LuClock, LuTag, LuCalculator, LuWifiOff,
  LuUsers, LuCalendarClock, LuUndo2, LuTrash2, LuClipboardCheck, LuTriangleAlert,
  LuGraduationCap, LuCircleHelp, LuHandCoins, LuTruck, LuShieldCheck,
} from 'react-icons/lu'
import { useConnection } from '../db/store'
import { useAuth, leavePharmacy } from '../db/auth'
import { can } from '../lib/permissions'
import { useT } from '../lib/i18n'
import { startTour } from '../lib/tur'
import { isDesktop } from '../lib/desktop'
import SyncBadge from './SyncBadge'
import { BrandWord } from './ui'
import emblem from '../assets/brand/emblem-64.png'

// ── Разделы программы ──
// Бокового меню больше нет: после входа открывается главный экран с плитками
// (pages/Home.jsx), а раздел занимает весь экран. Список здесь один на всех:
// по нему строятся плитки, маршруты, туры и обучение.
//
// perm — право, без которого раздел закрыт (плитка серая, адрес уводит на главный
// экран). owner — только владелец магазина. main — главное действие, золотая плитка.
export const NAV = [
  { section: 'Продажи' },
  { to: '/dashboard', label: 'Панель управления', Icon: LuLayoutDashboard, perm: 'dashboard.view' },
  { to: '/pos', label: 'Касса', Icon: LuShoppingCart, perm: 'pos.sell', main: true },
  { to: '/returns', label: 'Возврат товара', Icon: LuUndo2, perm: 'returns.view' },
  { section: 'Склад' },
  { to: '/products', label: 'Товары', Icon: LuPill, perm: 'products.view' },
  { to: '/arrivals', label: 'Приход товара', Icon: LuPackagePlus, perm: 'arrivals.view' },
  { to: '/expiry', label: 'Срок годности', Icon: LuCalendarClock, perm: 'expiry.view', expiryBadge: true },
  { to: '/writeoffs', label: 'Списание', Icon: LuTrash2, perm: 'writeoffs.view' },
  { to: '/inventory', label: 'Инвентаризация', Icon: LuClipboardCheck, perm: 'inventory.view' },
  { to: '/deferred', label: 'Отложенные штрихкоды', Icon: LuClock, perm: 'deferred.view', badge: true },
  { to: '/orders', label: 'Авто-заявка', Icon: LuClipboardList, perm: 'orders.view' },
  { section: 'Финансы' },
  { to: '/shift', label: 'Смена кассы', Icon: LuCalculator, perm: 'shift.view' },
  { to: '/debts', label: 'Долги клиентов', Icon: LuReceipt, perm: 'debts.view' },
  { to: '/discounts', label: 'История скидок', Icon: LuTag, perm: 'discounts.view' },
  { to: '/suppliers', label: 'Поставщики', Icon: LuTruck, perm: 'suppliers.view' },
  { to: '/expenses', label: 'Расходы', Icon: LuHandCoins, perm: 'expenses.view' },
  { to: '/reports', label: 'Отчёты', Icon: LuTrendingUp, perm: 'reports.view' },
  { section: 'Управление' },
  { to: '/employees', label: 'Сотрудники', Icon: LuUsers, owner: true },
  { to: '/roles', label: 'Роли и права', Icon: LuShieldCheck, owner: true },
  { to: '/settings', label: 'Настройки', Icon: LuSettings },
  // Обучение стоит последним и отдельно от рабочих разделов: в него заходят
  // не по делу, а когда забыли, как что-то делается
  { to: '/obuchenie', label: 'Обучение', Icon: LuGraduationCap, help: true },
]

// Открыт ли раздел этому сотруднику
export const allowedNav = (user, n) => (n.owner ? user?.role === 'founder' : !n.perm || can(user, n.perm))

// hub — это сам главный экран: вместо кнопки «Меню» в шапке стоит имя системы.
// fill — раздел сам занимает всю высоту окна и листается внутри себя (касса
// на широком экране). Остальные разделы растут вниз и листаются страницей.
export default function Layout({ title, subtitle, actions, fill, hub, children }) {
  const conn = useConnection()
  const user = useAuth()
  const t = useT()
  const location = useLocation()
  const navigate = useNavigate()
  // Владелец сервиса смотрит этот магазин от имени его владельца. Показываем крупно
  // и постоянно: перепутать чужой магазин со своим — самая дорогая из возможных
  // ошибок поддержки.
  const support = user?.impersonatedBy

  // ── Тур просит показать меню ──
  // Меню теперь — главный экран. Шаги общего тура сами ведут на него (у них
  // указан адрес), а старый запрос «открой меню» на всякий случай ведёт туда же.
  useEffect(() => {
    const onMenu = (e) => {
      if (e.detail && location.pathname !== '/') navigate('/')
    }
    window.addEventListener('tur:menu', onMenu)
    return () => window.removeEventListener('tur:menu', onMenu)
  }, [location.pathname, navigate])

  // Тур по разделу есть у каждого пункта меню, кроме самого «Обучения»:
  // что у каждого пункта есть урок, стережёт отдельная проверка
  const hasTour = NAV.some((n) => n.to === location.pathname && !n.help)

  return (
    <div className={'app' + (hub ? ' app-hub' : '')}>
      <div className={'main' + (fill ? ' main-fill' : '')}>
        {support && (
          <div className="conn-banner support">
            <span className="ic"><LuTriangleAlert size={15} /></span>
            {t('Вы смотрите чужой магазин от имени владельца')} — {user?.pharmacy?.name || user?.name}
            <button className="back" onClick={() => leavePharmacy()}>{t('вернуться к себе')}</button>
          </div>
        )}
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
            {hub ? (
              <span className="brand-mini" aria-hidden="true">
                <img src={emblem} alt="" width="30" height="30" />
                <BrandWord />
              </span>
            ) : (
              <Link to="/" className="menu-btn" data-tour="topbar.menu" title={t('Главное меню')}>
                <LuLayoutGrid size={18} />
                <span className="menu-btn-text">{t('Меню')}</span>
              </Link>
            )}
            <div className="topbar-title">
              <h1 data-tour="page.title">{title}</h1>
              {subtitle && <div className="sub">{subtitle}</div>}
            </div>
          </div>
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
