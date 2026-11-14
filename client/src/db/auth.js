// ── Авторизация на клиенте ──
// Токен и пользователь хранятся во вкладке (sessionStorage); подписка через useSyncExternalStore.
import { useSyncExternalStore } from 'react'
import { api, setAuthErrorHandler } from './api'
import { rehydrateForShop, resetStore } from './store'
import { bridge } from '../lib/desktop'
import { can as canUser } from '../lib/permissions'
import { hasOfflineLogin, openOfflineLogin, saveOfflineLogin } from '../lib/offlineLogin'
import { offlineNow } from '../lib/offlineSales'

// ── Ключ входа живёт только во вкладке ──
// sessionStorage, а не localStorage: закрыли вкладку или программу — в следующий
// раз снова вводится пароль. Так попросил владелец: касса стоит в общем зале, и
// открытый вход на чужом компьютере опаснее лишнего набора пароля. Новая вкладка
// тоже просит пароль — у неё своё хранилище.
const LS_TOKEN = 'apteka_token'
const LS_USER = 'apteka_user'
// Спрятанный токен владельца сервиса на время, пока он смотрит чужой магазин
const LS_ADMIN = 'apteka_service_token'
// Прежние версии держали ключ в localStorage — подчищаем, чтобы он там не лежал
try {
  for (const k of [LS_TOKEN, LS_USER, LS_ADMIN]) localStorage.removeItem(k)
} catch {
  /* приватный режим */
}

let token = null
let user = null
try {
  token = sessionStorage.getItem(LS_TOKEN) || null
  const u = sessionStorage.getItem(LS_USER)
  user = u ? JSON.parse(u) : null
} catch {
  /* приватный режим */
}

const listeners = new Set()
const emit = () => listeners.forEach((l) => l())
const subscribe = (cb) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setAuth(t, u) {
  const tokenChanged = t !== token
  token = t
  user = u
  try {
    if (t) {
      sessionStorage.setItem(LS_TOKEN, t)
      sessionStorage.setItem(LS_USER, JSON.stringify(u))
    } else {
      sessionStorage.removeItem(LS_TOKEN)
      sessionStorage.removeItem(LS_USER)
    }
  } catch {
    /* ignore */
  }
  // Вошли в магазин в этой же вкладке — его сохранённые списки (товары, смена) сразу на
  // экран, не дожидаясь сервера: без интернета их иначе не было бы вовсе
  if (t && u) rehydrateForShop()
  // ── Программа для Windows ──
  // Настоящий ключ входа лежит не в окне, а в основной части программы. Вышли здесь —
  // значит и там его надо стереть: иначе на экране был бы вход, а ключ продолжал бы
  // действовать, и следующий запрос ушёл бы от имени того, кто уже вышел.
  if (!t && bridge) bridge.session.clear().catch(() => {})
  emit()
  // Постоянное соединение открыто по прежнему токену и слушает прежний магазин.
  // Само оно об этом не узнает: сервер разбирает токен один раз, при подключении.
  if (tokenChanged) {
    import('./realtime').then((m) => m.resyncRealtime()).catch(() => {})
  }
}

export function getUser() {
  return user
}

// ── Работу магазина остановили прямо сейчас ──
// Отдельное состояние, а не просто выход: если сразу показать форму входа, человек
// решит, что его «выкинуло», попробует войти снова, не сможет — и позвонит спросить,
// что сломалось. Причину надо сначала прочитать, и только потом закрыть.
let suspended = null

export function useSuspended() {
  return useSyncExternalStore(subscribe, () => suspended, () => suspended)
}

export function suspendNow(message, title) {
  suspended = { message: message || 'Работа программы приостановлена', title: title || '' }
  emit()
}

// Работу вернули, пока объявление ещё висело на экране. Такое бывает: клиент
// заплатил через десять минут, а кассир всё это время смотрел на объявление и
// никуда не нажимал. Убираем его молча — он снова может работать.
export function clearSuspension() {
  if (!suspended) return
  suspended = null
  emit()
}

// Прочитал — выходим. Токен ещё действует, но делать в системе больше нечего:
// сервер откажет в любой записи, а связь уже разорвана с той стороны.
export function acknowledgeSuspension() {
  suspended = null
  logout()
}
export function isFounder() {
  return user?.role === 'founder'
}

// ── Права вошедшего ──
// can('products.edit') — есть ли право (любое из перечисленных). Владелец может всё.
// useCan() — то же для компонентов: перерисовка, когда «кто я» обновился
export function can(...keys) {
  return canUser(user, ...keys)
}
export function useCan() {
  const u = useAuth()
  return (...keys) => canUser(u, ...keys)
}

// ── Вход без интернета (сайт, 14.11.2026) ──
// Если сервер не ответил — входим по записи этого браузера (lib/offlineLogin.js): ключ
// входа, зашифрованный паролем. Связи нет совсем (браузер это знает) — не ждём сервер
// вовсе; связь «есть», но сервер молчит — ждём его OFFLINE_WAIT_MS, потом запись. Сервер
// ответил позже — молча берём его свежий ключ. Программа для Windows входит по-своему
const OFFLINE_WAIT_MS = 4000
const noLink = (e) => !!e && e.status === 0
const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false
export const NO_OFFLINE_LOGIN = 'Нет связи с интернетом. Без интернета войти может только тот, кто уже входил в этом браузере.'
const WRONG_PASSWORD = 'Неверное имя или пароль'

export async function login(name, password) {
  suspended = null
  const online = api.post('/auth/login', { name, password })
  if (bridge || !hasOfflineLogin(name)) {
    let res
    try {
      res = await online
    } catch (e) {
      // Сайт без связи, а записи для этого логина в браузере нет — так и сказать
      if (!bridge && noLink(e)) {
        const err = new Error(NO_OFFLINE_LOGIN)
        err.status = 0
        throw err
      }
      throw e
    }
    return finishLogin(res, name, password)
  }
  online.catch(() => {}) // ответ разберём ниже; без этого браузер ругался бы на «необработанный»
  const first = await Promise.race([
    online.then(
      (res) => ({ res }),
      (err) => ({ err }),
    ),
    new Promise((r) => setTimeout(() => r({ slow: true }), browserOffline() ? 0 : OFFLINE_WAIT_MS)),
  ])
  if (first.res) return finishLogin(first.res, name, password)
  // Сервер ответил отказом по существу (неверный пароль, магазин остановлен) — это ответ
  if (first.err && !noLink(first.err)) throw first.err
  const off = await openOfflineLogin({ login: name, password })
  if (off.token) {
    setAuth(off.token, off.user)
    // Сервер всё-таки ответил — переходим на его свежий ключ, пока это всё ещё тот же вход
    if (first.slow) {
      online.then(
        (res) => {
          if (token === off.token && res?.token && res.user && res.user.role !== 'superadmin') finishLogin(res, name, password).catch(() => {})
        },
        () => {},
      )
    }
    return off.user
  }
  // Запись не открылась, а сервер ещё думает — ждём его ответа (пароль могли сменить)
  if (first.slow && !browserOffline()) return finishLogin(await online, name, password)
  const err = new Error(off.error === 'password' ? WRONG_PASSWORD : NO_OFFLINE_LOGIN)
  err.status = off.error === 'password' ? 401 : 0
  throw err
}

async function finishLogin(res, name, password) {
  // ── Владельцу сервиса программа для Windows не нужна ──
  // Она сделана для магазина: касса, склад, работа без интернета. У владельца сервиса
  // ничего этого нет — у него список магазинов, и он целиком живёт на сайте. Пустить его
  // сюда значило бы показать панель, половина которой в программе не работает.
  if (bridge && res.user?.role === 'superadmin') {
    await bridge.session.clear().catch(() => {})
    throw new Error('Панель владельца сервиса работает на сайте. Эта программа — для магазина.')
  }
  setAuth(res.token, res.user)
  // Запомнить вход для работы без интернета (только сайт, не владелец сервиса). В фоне:
  // шифрование паролем занимает долю секунды, а человек уже вошёл
  if (!bridge && res.user?.role !== 'superadmin') {
    saveOfflineLogin({ login: name, password, token: res.token, user: res.user }).catch(() => {})
  }
  return res.user
}

// Смена своего пароля. Сервер отзывает все ранее выданные токены — включая тот,
// которым мы пользуемся прямо сейчас, — и возвращает новый. Сохраняем его, иначе
// человек вылетал бы из системы сразу после смены собственного пароля.
export async function changePassword(oldPassword, newPassword) {
  const res = await api.post('/auth/change-password', { oldPassword, newPassword })
  if (res && res.token) {
    setAuth(res.token, res.user || user)
    // Запись для входа без интернета — под новый пароль (старым её больше не открыть)
    if (!bridge && user?.name && user.role !== 'superadmin' && !isImpersonating()) {
      saveOfflineLogin({ login: user.name, password: newPassword, token: res.token, user }).catch(() => {})
    }
  }
  return res
}

export function logout() {
  suspended = null
  try {
    sessionStorage.removeItem(LS_ADMIN)
  } catch {
    /* ignore */
  }
  // Выход без связи: сохранённые товары этого магазина остаются — следующий вход без
  // интернета (lib/offlineLogin.js) должен найти их, иначе продавать нечем
  const shop = !bridge && offlineNow() ? user?.pharmacy?.code || '' : ''
  setAuth(null, null)
  resetStore({ keepShop: shop }) // чтобы следующий пользователь не видел чужой кэш
  dropRealtime()
}

// ── Вход под владельцем магазина (поддержка) ──
// Половина обращений — «у меня не работает», и посмотреть самому быстрее, чем
// объяснять по телефону, куда нажимать. Свой токен на это время прячем: выйти
// обратно должно быть одним нажатием, иначе владелец сервиса будет заново
// вводить пароль после каждого разбора.
export async function enterPharmacy(pharmacyId) {
  const res = await api.post(`/admin/pharmacies/${pharmacyId}/enter`)
  try {
    sessionStorage.setItem(LS_ADMIN, token)
  } catch {
    /* приватный режим — вернуться придётся входом заново */
  }
  resetStore()
  // Ставим то, что уже знаем, чтобы экран не мигнул формой входа; настоящие
  // данные (подписка, пометка о поддержке) придут следом
  setAuth(res.token, { id: '', name: res.owner, role: 'founder', pharmacy: res.pharmacy })
  await refreshMe()
  return res
}

export function isImpersonating() {
  try {
    return !!sessionStorage.getItem(LS_ADMIN)
  } catch {
    return false
  }
}

// Вернуться к себе. Если спрятанный токен потерялся (приватный режим, чистка
// хранилища) — просто выходим: это честнее, чем оставить человека в чужом магазине.
export async function leavePharmacy() {
  let admin = null
  try {
    admin = sessionStorage.getItem(LS_ADMIN)
    sessionStorage.removeItem(LS_ADMIN)
  } catch {
    /* ignore */
  }
  resetStore()
  dropRealtime()
  if (!admin) {
    setAuth(null, null)
    return
  }
  setAuth(admin, { id: '', name: '', role: 'superadmin', pharmacy: null })
  await refreshMe()
}

// Постоянное соединение рвём при выходе и при истёкшей сессии: оно открыто
// по токену, который только что перестал действовать
async function dropRealtime() {
  const { stopRealtime } = await import('./realtime')
  stopRealtime()
}

// Проверить/обновить сессию по сохранённому токену
export async function refreshMe() {
  if (!token) return null
  try {
    const u = await api.get('/auth/me')
    setAuth(token, u)
    return u
  } catch (e) {
    // Нет связи или сервер прилёг — человек остаётся, кем был: касса на сайте продаёт и
    // без интернета (вошли без связи, обновили страницу — выкидывать нельзя). Выходим
    // только по ответу сервера: ключ недействителен, работа остановлена
    if (!e?.status || e.status >= 500) return user
    setAuth(null, null)
    resetStore()
    return null
  }
}

// Сессия истекла (401 от сервера при наличии токена)
setAuthErrorHandler(() => {
  setAuth(null, null)
  resetStore()
  dropRealtime()
})

// ── Подписка меняется сама по себе ──
// Дни идут, и вчера оплаченный магазин сегодня уже в отсрочке. Касса при этом
// открыта во вкладке сутками и «кто я» спрашивает только при запуске — предупреждение
// появилось бы лишь после перезагрузки. Поэтому переспрашиваем при возвращении
// на вкладку: запрос крошечный, а узнать о просрочке лучше до первого отказа.
if (typeof document !== 'undefined') {
  const recheck = () => {
    if (token && document.visibilityState === 'visible') refreshMe().catch(() => {})
  }
  document.addEventListener('visibilitychange', recheck)
  window.addEventListener('focus', recheck)
}

export function useAuth() {
  return useSyncExternalStore(subscribe, () => user, () => user)
}
