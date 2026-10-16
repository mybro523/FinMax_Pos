import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { ToastProvider, DialogProvider, useToast } from './components/ui'
import ErrorBoundary from './components/ErrorBoundary'
import PageFallback from './components/PageFallback'
import Login from './components/Login'
import { setNotifier, startPolling, onChanged } from './db/store'
import { startRealtime, stopRealtime } from './db/realtime'
import { useAuth, refreshMe, getUser, useSuspended, acknowledgeSuspension } from './db/auth'
import Suspended from './components/Suspended'
import { setThemeScope } from './lib/theme'
import { setLangScope } from './lib/i18n'
import { can } from './lib/permissions'

// Ленивые страницы — код грузится по требованию (быстрый первый экран)
const Home = lazy(() => import('./pages/Home'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Pos = lazy(() => import('./pages/Pos'))
const Products = lazy(() => import('./pages/Products'))
const Arrivals = lazy(() => import('./pages/Arrivals'))
const Deferred = lazy(() => import('./pages/Deferred'))
const Orders = lazy(() => import('./pages/Orders'))
const Debts = lazy(() => import('./pages/Debts'))
const Discounts = lazy(() => import('./pages/Discounts'))
const Shift = lazy(() => import('./pages/Shift'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))
const Employees = lazy(() => import('./pages/Employees'))
const Roles = lazy(() => import('./pages/Roles'))
const Expiry = lazy(() => import('./pages/Expiry'))
const Returns = lazy(() => import('./pages/Returns'))
const Obuchenie = lazy(() => import('./pages/Obuchenie'))
// Тур лежит отдельно: главная сборка несёт только его состояние, тексты грузятся при запуске
import TurHost from './components/TurHost'
import { startTour, obucheniePokazano, OBSHIY } from './lib/tur'
const WriteOffs = lazy(() => import('./pages/WriteOffs'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Incomes = lazy(() => import('./pages/Incomes'))
const About = lazy(() => import('./pages/About'))
const Suppliers = lazy(() => import('./pages/Suppliers'))
const SalesReport = lazy(() => import('./pages/SalesReport'))
const SupplierReport = lazy(() => import('./pages/SupplierReport'))
// Панель владельца сервиса: он обслуживает магазины, но своего у него нет
const Admin = lazy(() => import('./pages/Admin'))

// ── Остальные разделы докачиваем в тишине ──
// Код каждого раздела лежит отдельным куском — так первый экран открывается быстро.
// Но за это платит первый переход в каждый раздел: замерено 230 мс против 35 мс,
// когда кусок уже в памяти. И платится это по разу за каждый раздел, всегда в тот
// момент, когда человек уже нажал и смотрит на экран.
//
// Поэтому, отрисовав первый экран, тихо докачиваем остальное в свободное время
// браузера — по одному куску, чтобы не забивать слабую связь магазина. Отчёты идут
// последними: они тянут за собой рисование графиков, самый тяжёлый кусок из всех.
const AHEAD = [
  () => import('./pages/Pos'),
  () => import('./pages/Products'),
  () => import('./pages/Arrivals'),
  () => import('./pages/Expiry'),
  () => import('./pages/Returns'),
  () => import('./pages/Shift'),
  () => import('./pages/Deferred'),
  () => import('./pages/Orders'),
  () => import('./pages/Debts'),
  () => import('./pages/Discounts'),
  () => import('./pages/Settings'),
]
const AHEAD_FOUNDER = [
  () => import('./pages/Dashboard'),
  () => import('./pages/WriteOffs'),
  () => import('./pages/Inventory'),
  () => import('./pages/Employees'),
  () => import('./pages/Roles'),
  () => import('./pages/Expenses'),
  () => import('./pages/Incomes'),
  () => import('./pages/Suppliers'),
  () => import('./pages/Reports'),
  () => import('./pages/SalesReport'),
  () => import('./pages/SupplierReport'),
]

// Пока человек набирает имя и пароль, качаем то, куда он попадёт сразу после входа:
// главный экран и кассу. Иначе после нажатия «Войти» он ждёт не только проверку
// пароля, но и загрузку кода первого экрана.
const AHEAD_LOGIN = [() => import('./pages/Home'), () => import('./pages/Pos')]

function usePrefetchPages(role) {
  useEffect(() => {
    if (role === 'superadmin') return
    const list = !role ? AHEAD_LOGIN : role === 'founder' ? [...AHEAD, ...AHEAD_FOUNDER] : AHEAD
    let stopped = false
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 800))
    const step = (i) => {
      if (stopped || i >= list.length) return
      idle(() =>
        list[i]()
          .catch(() => {}) // не докачалось — не беда, загрузится при переходе
          .then(() => step(i + 1)),
      )
    }
    step(0)
    return () => {
      stopped = true
    }
  }, [role])
}

// Прокидываем тост в слой данных, чтобы фоновые ошибки мутаций были видны
function ErrorBridge() {
  const toast = useToast()
  useEffect(() => {
    setNotifier((msg, type) => toast(msg, type))
  }, [toast])
  return null
}

// Стартовая страница: владелец сервиса — его панель, все остальные — главный экран
const homeFor = (user) => (user?.role === 'superadmin' ? '/admin' : '/')

// ── Раздел по праву ──
// Нет права — на главный экран, где этот раздел показан серым. Проверка здесь —
// для удобства, а не для защиты: сервер отклонит запрос и без неё
function Allowed({ user, perm, owner, children }) {
  const ok = owner ? user?.role === 'founder' : !perm || can(user, perm)
  return ok ? children : <Navigate to="/" replace />
}

function AuthedApp({ user }) {
  // Владелец сервиса работает с другим приложением: у него нет ни кассы, ни склада,
  // ни смен — есть список магазинов. Общее меню ему показывать нечего, а разделы магазина
  // сервер ему и не отдаст: его учётная запись не привязана ни к одной.
  const isService = user?.role === 'superadmin'
  usePrefetchPages(user?.role)

  // ── Чья тема и чей язык ──
  // У панели владельца сервиса своя настройка, у магазина своя. Переключаем до
  // отрисовки (useLayoutEffect, а не useEffect), иначе браузер успел бы показать
  // чужую тему и моргнуть. Вход «как магазин» сюда приходит с ролью магазина —
  // и получает вид магазина, как и должен: владелец смотрит глазами клиента.
  const side = isService ? 'admin' : 'apteka'
  useLayoutEffect(() => {
    setThemeScope(side)
    setLangScope(side)
  }, [side])

  // ── Первый вход нового магазина ──
  // Человек видит программу впервые и не знает, с чего начать. Сразу запускаем
  // общий тур: подсветка по меню и главным местам. Один раз на устройстве —
  // закрыл, пропустил или прошёл, и больше тур сам не выскакивает; снова его
  // запускают из «Обучения». Владельцу сервиса это не нужно: у него другая программа.
  useEffect(() => {
    if (!isService && !obucheniePokazano()) startTour(OBSHIY)
  }, [isService])

  // ── Постоянное соединение держат все ──
  // Раньше панель управления работала без него: считалось, что владельцу сервиса
  // нечего слушать. На деле слушать есть что — какие магазины сейчас за кассой и что
  // в них происходит, — а главное, соединение нужно ему самому, чтобы его решения
  // доходили до магазинов сразу. Опрос остаётся страховкой от потерянного события.
  useEffect(() => {
    startPolling()
    startRealtime()
    return () => stopRealtime()
  }, [])

  // Владелец поменял права роли — открытые окна перечитывают «кто я» и тут же
  // прячут или показывают разделы, не дожидаясь нового входа
  useEffect(() => onChanged((keys) => keys.includes('roles') && refreshMe()), [])

  if (isService) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    )
  }

  const guarded = (perm, el) => <Allowed user={user} perm={perm}>{el}</Allowed>
  const ownerOnly = (el) => <Allowed user={user} owner>{el}</Allowed>

  return (
    <ErrorBoundary>
      <TurHost />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={guarded('dashboard.view', <Dashboard />)} />
          <Route path="/pos" element={guarded('pos.sell', <Pos />)} />
          <Route path="/products" element={guarded('products.view', <Products />)} />
          <Route path="/arrivals" element={guarded('arrivals.view', <Arrivals />)} />
          <Route path="/expiry" element={guarded('expiry.view', <Expiry />)} />
          <Route path="/deferred" element={guarded('deferred.view', <Deferred />)} />
          <Route path="/orders" element={guarded('orders.view', <Orders />)} />
          <Route path="/returns" element={guarded('returns.view', <Returns />)} />
          <Route path="/writeoffs" element={guarded('writeoffs.view', <WriteOffs />)} />
          <Route path="/inventory" element={guarded('inventory.view', <Inventory />)} />
          <Route path="/shift" element={guarded('shift.view', <Shift />)} />
          <Route path="/debts" element={guarded('debts.view', <Debts />)} />
          <Route path="/discounts" element={guarded('discounts.view', <Discounts />)} />
          <Route path="/expenses" element={guarded('expenses.view', <Expenses />)} />
          <Route path="/incomes" element={guarded('incomes.view', <Incomes />)} />
          <Route path="/suppliers" element={guarded('suppliers.view', <Suppliers />)} />
          {/* Прежний адрес «Долги поставщикам» — теперь это вкладка в «Поставщиках» */}
          <Route path="/supplier-debts" element={<Navigate to="/suppliers?tab=debts" replace />} />
          <Route path="/reports" element={guarded('reports.view', <Reports />)} />
          <Route path="/sales-report" element={guarded('reports.view', <SalesReport />)} />
          <Route path="/supplier-report" element={guarded('suppliers.view', <SupplierReport />)} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/obuchenie" element={<Obuchenie />} />
          {/* О компании FinMax — кнопка в шапке главного меню, открыта всем */}
          <Route path="/about" element={<About />} />
          <Route path="/employees" element={ownerOnly(<Employees />)} />
          <Route path="/roles" element={ownerOnly(<Roles />)} />
          <Route path="*" element={<Navigate to={homeFor(user)} replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

function Gate() {
  const user = useAuth()
  const stop = useSuspended()

  // ── Ждём сервер только тогда, когда ждать действительно надо ──
  // Кто вошёл, известно с прошлого раза: и ключ, и сам сотрудник лежат в памяти
  // вкладки. Раньше программа всё равно спрашивала сервер «кто я» и до ответа держала
  // пустой экран — четыреста миллисекунд при каждом открытии, каждый раз одни и те же.
  // А данные разделов и так показываются из сохранённого кэша.
  //
  // Спрашиваем в фоне. Если сессия кончилась, ответ придёт с отказом, и человек
  // окажется на входе — так же, как и раньше, только на полсекунды позже.
  const [checking, setChecking] = useState(() => !getUser())
  useEffect(() => {
    refreshMe().finally(() => setChecking(false))
  }, [])

  // Объяснение поверх всего: работу остановили прямо сейчас, посреди смены
  if (stop) return <Suspended message={stop.message} title={stop.title} onClose={acknowledgeSuspension} />
  if (checking) return <PageFallback />
  if (!user) return <LoginScreen />
  return <AuthedApp user={user} />
}

// Форма входа вместе с тихой докачкой первого экрана
function LoginScreen() {
  usePrefetchPages(null)
  return <Login />
}

export default function App() {
  return (
    <ToastProvider>
      <ErrorBridge />
      <DialogProvider>
        <Gate />
      </DialogProvider>
    </ToastProvider>
  )
}
