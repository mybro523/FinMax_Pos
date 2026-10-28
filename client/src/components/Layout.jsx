import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  LuLayoutDashboard, LuShoppingCart, LuPill, LuPackagePlus,
  LuClipboardList, LuReceipt, LuTrendingUp, LuSettings, LuClock, LuTag, LuCalculator, LuWifiOff,
  LuUsers, LuCalendarClock, LuUndo2, LuTrash2, LuClipboardCheck, LuTriangleAlert,
  LuGraduationCap, LuHandCoins, LuTruck, LuShieldCheck, LuChartColumn, LuScale, LuCoins,
} from 'react-icons/lu'
import { useConnection } from '../db/store'
import { useAuth, leavePharmacy } from '../db/auth'
import { can, kassaFirst } from '../lib/permissions'
import { useT } from '../lib/i18n'
import { isDesktop } from '../lib/desktop'
import AppFoot from './AppFoot'
import { BrandWord } from './ui'
import emblem from '../assets/brand/emblem-64.png'

// ── Разделы программы ──
// Бокового меню больше нет: после входа открывается главный экран с плитками
// (pages/Home.jsx), а раздел занимает весь экран. Список здесь один на всех:
// по нему строятся плитки, маршруты, туры, обучение и окно «Меню» кассира.
//
// perm — право, без которого раздел закрыт (плитка серая, адрес уводит на главный
// экран). owner — только владелец магазина. main — главное действие, золотая плитка.
// Порядок — как попросил владелец магазина (1.5.5), слева направо и сверху вниз: сетка
// меню — 6 колонок × 4 ряда, касса занимает две клетки, и 23 раздела встают в неё ровно
export const NAV = [
  { to: '/dashboard', label: 'Панель управления', Icon: LuLayoutDashboard, perm: 'dashboard.view' },
  { to: '/pos', label: 'Касса', Icon: LuShoppingCart, perm: 'pos.sell', main: true },
  { to: '/shift', label: 'Смена кассы', Icon: LuCalculator, perm: 'shift.view' },
  { to: '/debts', label: 'Долги клиентов', Icon: LuReceipt, perm: 'debts.view' },
  { to: '/discounts', label: 'История скидок', Icon: LuTag, perm: 'discounts.view' },
  { to: '/deferred', label: 'Отложенные штрихкоды', Icon: LuClock, perm: 'deferred.view', badge: true },
  { to: '/sales-report', label: 'Отчёт продажи', Icon: LuChartColumn, perm: 'reports.view' },
  { to: '/arrivals', label: 'Приход товара', Icon: LuPackagePlus, perm: 'arrivals.view' },
  { to: '/products', label: 'Товары', Icon: LuPill, perm: 'products.view' },
  { to: '/returns', label: 'Возврат товара', Icon: LuUndo2, perm: 'returns.view' },
  { to: '/writeoffs', label: 'Списание', Icon: LuTrash2, perm: 'writeoffs.view' },
  { to: '/expiry', label: 'Срок годности', Icon: LuCalendarClock, perm: 'expiry.view', expiryBadge: true },
  { to: '/inventory', label: 'Инвентаризация', Icon: LuClipboardCheck, perm: 'inventory.view' },
  { to: '/orders', label: 'Авто-заявка', Icon: LuClipboardList, perm: 'orders.view' },
  { to: '/suppliers', label: 'Поставщики', Icon: LuTruck, perm: 'suppliers.view' },
  { to: '/supplier-report', label: 'Отчёт поставщиков', Icon: LuScale, perm: 'suppliers.view' },
  { to: '/incomes', label: 'Доходы', Icon: LuCoins, perm: 'incomes.view' },
  { to: '/expenses', label: 'Расходы', Icon: LuHandCoins, perm: 'expenses.view' },
  { to: '/reports', label: 'Отчёт ОПУ', Icon: LuTrendingUp, perm: 'reports.view' },
  { to: '/employees', label: 'Сотрудники', Icon: LuUsers, owner: true },
  { to: '/roles', label: 'Роли и права', Icon: LuShieldCheck, owner: true },
  // Обучение — не рабочий раздел: в него заходят, когда забыли, как что-то делается
  { to: '/obuchenie', label: 'Обучение', Icon: LuGraduationCap, help: true },
  { to: '/settings', label: 'Настройки', Icon: LuSettings },
]

// Открыт ли раздел этому сотруднику
export const allowedNav = (user, n) => (n.owner ? user?.role === 'founder' : !n.perm || can(user, n.perm))

// hub — это сам главный экран: у него одного есть шапка с именем системы.
// fill — раздел сам занимает всю высоту окна и листается внутри себя (касса
// на широком экране). Остальные разделы растут вниз и листаются страницей.
// title и subtitle в разделах на экране не пишутся (шапки там нет): title остаётся
// заголовком для экранного диктора. actions — кнопки раздела, строкой вверху страницы;
// note — сводка раздела слева от них («Общая задолженность: …»), если без неё цифра
// пропала бы с экрана вместе с шапкой
export default function Layout({ title, subtitle, note, actions, fill, hub, children }) {
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
  // У кассира главного экрана нет — его шаги тура пропускаются (lib/tury.js)
  const kassir = kassaFirst(user)
  useEffect(() => {
    const onMenu = (e) => {
      if (e.detail && !kassir && location.pathname !== '/') navigate('/')
    }
    window.addEventListener('tur:menu', onMenu)
    return () => window.removeEventListener('tur:menu', onMenu)
  }, [location.pathname, navigate, kassir])

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
        {/* В программе для Windows полосы «нет связи» нет: касса там работает и без
            интернета, а что ушло на сервер, видно в «Настройках» (вкладка «Профиль») */}
        {conn === 'error' && !isDesktop && (
          <div className="conn-banner">
            <span className="ic"><LuWifiOff size={15} /></span>
            {t('Нет связи с сервером — показаны сохранённые данные, изменения синхронизируются автоматически')}
          </div>
        )}
        {/* Шапка — только у главного экрана: имя системы и его кнопки; закреплена вверху
            окна. В разделах её нет, место отдано странице: «Меню» и «?» стоят в полосе
            внизу (AppFoot.jsx), кнопки раздела — строкой вверху страницы. Значков версии,
            отправки и касс в сети в шапке нет — они в «Настройках» */}
        {hub && (
          <header className="topbar">
            <div className="topbar-left">
              <span className="brand-mini" aria-hidden="true">
                <img src={emblem} alt="" width="30" height="30" />
                <BrandWord />
              </span>
              <div className="topbar-title">
                <h1>{title}</h1>
                {subtitle && <div className="sub">{subtitle}</div>}
              </div>
            </div>
            <div className="topbar-actions">{actions}</div>
          </header>
        )}
        <main className="content" key={location.pathname}>
          {/* Название раздела на экране не пишется, но остаётся заголовком страницы
              для экранного диктора */}
          {!hub && <h1 className="sr-only">{title}</h1>}
          {!hub && (actions || note) ? (
            <div className="page-acts">
              {note && <span className="pa-note" title={note}>{note}</span>}
              <div className="pa-btns">{actions}</div>
            </div>
          ) : null}
          {children}
        </main>
        <AppFoot razdel={!hub} tour={hasTour} />
      </div>

      {/* Хост для модалок страницы. Лежит внутри .app (у неё нет transform, поэтому
          position:fixed по-прежнему считается от экрана), но при этом React прячет его
          вместе со страницей, когда подгружает чанк другой страницы (Suspense). */}
      <div id="overlay-root" />
    </div>
  )
}
