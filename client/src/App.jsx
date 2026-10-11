import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { ToastProvider, DialogProvider, useToast } from './components/ui'
import ErrorBoundary from './components/ErrorBoundary'
import PageFallback from './components/PageFallback'
import Login from './components/Login'
import { setNotifier, startPolling } from './db/store'
import { startRealtime, stopRealtime } from './db/realtime'
import { useAuth, refreshMe, getUser, useSuspended, acknowledgeSuspension } from './db/auth'
import Suspended from './components/Suspended'
import { setThemeScope } from './lib/theme'
import { setLangScope } from './lib/i18n'

// Ленивые страницы — код грузится по требованию (быстрый первый экран)
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
const Expiry = lazy(() => import('./pages/Expiry'))
const Returns = lazy(() => import('./pages/Returns'))
const Obuchenie = lazy(() => import('./pages/Obuchenie'))
// Тур лежит отдельно: главная сборка несёт только его состояние, тексты грузятся при запуске
import TurHost from './components/TurHost'
import { startTour, obucheniePokazano, OBSHIY } from './lib/tur'
const WriteOffs = lazy(() => import('./pages/WriteOffs'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Suppliers = lazy(() => import('./pages/Suppliers'))
// Панель владельца сервиса: он обслуживает аптеки, но своей у него нет
const Admin = lazy(() => import('./pages/Admin'))

// ── Остальные разделы докачиваем в тишине ──
// Код каждого раздела лежит отдельным куском — так первый экран открывается быстро.
// Но за это платит первый переход в каждый раздел: замерено 230 мс против 35 мс,
// когда кусок уже в памяти. И платится это по разу за каждый раздел, всегда в тот
// момент, когда человек уже нажал и смотрит на экран.
//
// Поэтому, отрисовав первый экран, тихо докачиваем остальное в свободное время
// браузера — по одному куску, чтобы не забивать слабую связь аптеки. Отчёты идут
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
  () => import('./pages/Expenses'),
  () => import('./pages/Suppliers'),
  () => import('./pages/Reports'),
]

// Пока человек набирает имя и пароль, качаем то, куда он попадёт сразу после входа.
// Иначе после нажатия «Войти» он ждёт не только проверку пароля, но и загрузку кода
// первого экрана — а набирает он пароль несколько секунд, и всё это время связь
// простаивает.
const AHEAD_LOGIN = [() => import('./pages/Dashboard'), () => import('./pages/Pos')]

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

// Стартовая страница зависит от роли: основатель — панель управления, кассир — касса
const homeFor = (user) =>
  user?.role === 'superadmin' ? '/admin' : user?.role === 'founder' ? '/' : '/pos'

// Роут только для владельца — кассира отправляем на его стартовую страницу
// (именно на homeFor, а не на '/', иначе у кассира вышло бы кольцо редиректов)
function FounderRoute({ user, children }) {
  return user?.role === 'founder' ? children : <Navigate to={homeFor(user)} replace />
}

function AuthedApp({ user }) {
  // Владелец сервиса работает с другим приложением: у него нет ни кассы, ни склада,
  // ни смен — есть список аптек. Общее меню ему показывать нечего, а разделы аптеки
  // сервер ему и не отдаст: его учётная запись не привязана ни к одной.
  const isService = user?.role === 'superadmin'
  usePrefetchPages(user?.role)

  // ── Чья тема и чей язык ──
  // У панели владельца сервиса своя настройка, у аптеки своя. Переключаем до
  // отрисовки (useLayoutEffect, а не useEffect), иначе браузер успел бы показать
  // чужую тему и моргнуть. Вход «как аптека» сюда приходит с ролью аптеки —
  // и получает аптечный вид, как и должен: владелец смотрит глазами клиента.
  const side = isService ? 'admin' : 'apteka'
  useLayoutEffect(() => {
    setThemeScope(side)
    setLangScope(side)
  }, [side])

  // ── Первый вход новой аптеки ──
  // Человек видит программу впервые и не знает, с чего начать. Сразу запускаем
  // общий тур: подсветка по меню и главным местам. Один раз на устройстве —
  // закрыл, пропустил или прошёл, и больше тур сам не выскакивает; снова его
  // запускают из «Обучения». Владельцу сервиса это не нужно: у него другая программа.
  useEffect(() => {
    if (!isService && !obucheniePokazano()) startTour(OBSHIY)
  }, [isService])

  // ── Постоянное соединение держат все ──
  // Раньше панель управления работала без него: считалось, что владельцу сервиса
  // нечего слушать. На деле слушать есть что — какие аптеки сейчас за кассой и что
  // в них происходит, — а главное, соединение нужно ему самому, чтобы его решения
  // доходили до аптек сразу. Опрос остаётся страховкой от потерянного события.
  useEffect(() => {
    startPolling()
    startRealtime()
    return () => stopRealtime()
  }, [])

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

  return (
    <ErrorBoundary>
      <TurHost />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<FounderRoute user={user}><Dashboard /></FounderRoute>} />
          <Route path="/pos" element={<Pos />} />
          <Route path="/products" element={<Products />} />
          <Route path="/arrivals" element={<Arrivals />} />
          <Route path="/expiry" element={<Expiry />} />
          <Route path="/deferred" element={<Deferred />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/writeoffs" element={<FounderRoute user={user}><WriteOffs /></FounderRoute>} />
          <Route path="/inventory" element={<FounderRoute user={user}><Inventory /></FounderRoute>} />
          <Route path="/shift" element={<Shift />} />
          <Route path="/debts" element={<Debts />} />
          <Route path="/discounts" element={<Discounts />} />
          <Route path="/expenses" element={<FounderRoute user={user}><Expenses /></FounderRoute>} />
          <Route path="/suppliers" element={<FounderRoute user={user}><Suppliers /></FounderRoute>} />
          <Route path="/reports" element={<FounderRoute user={user}><Reports /></FounderRoute>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/obuchenie" element={<Obuchenie />} />
          <Route path="/employees" element={<FounderRoute user={user}><Employees /></FounderRoute>} />
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
  // Кто вошёл, известно с прошлого раза: и токен, и сам сотрудник лежат в браузере.
  // Раньше программа всё равно спрашивала сервер «кто я» и до ответа держала пустой
  // экран — четыреста миллисекунд при каждом открытии, каждый раз одни и те же.
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
