// ── Постоянное соединение с сервером ──
// Кассир пробил чек — владелец видит это сразу, не дожидаясь фонового опроса.
// По сети идёт только название изменившегося раздела, сами данные устройство
// забирает обычным запросом: так на экране всегда ровно то, что в базе.
//
// Соединение держат все, включая владельца сервиса. Раньше панель управления
// работала без него — и решения, принятые в панели, доходили до аптеки лишь
// при следующей перезагрузке страницы, то есть иногда через сутки.
//
// Что приходит с сервера:
//   changed      — раздел устарел, перезапроси
//   subscription — подписка изменилась: продлили, возобновили, поправили срок
//   suspended    — работу остановили, вот причина (следом связь оборвётся)
//   service      — в панели что-то изменилось (только владельцу сервиса)
//   presence     — кто из аптек сейчас на связи (только владельцу сервиса)
import { io } from 'socket.io-client'
import { invalidate, notify, refreshAll, setRealtimeConnected } from './store.js'
import { refreshDesktopStatus, setDesktopStatus } from './desktopStatus.js'
import { bridge } from '../lib/desktop.js'

const TOKEN_KEY = 'apteka_token'

// Сервер отдаёт API по адресу вида https://…/api, а соединение живёт в корне
export function serverOrigin(apiUrl) {
  const base = String(apiUrl || '').replace(/\/+$/, '')
  if (!base || base.startsWith('/')) return '' // в разработке — тот же адрес, что и страница
  return base.replace(/\/api$/, '')
}

let socket = null
// По какому токену открыто нынешнее соединение. Токен меняется чаще, чем кажется:
// вход под владельцем аптеки, возврат к себе, смена собственного пароля. Каждый раз
// прежнее соединение остаётся жить со старым токеном — оно слушает не ту комнату,
// а после отзыва токена сервер его вовсе не пустит.
let socketToken = ''

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '' // токен живёт во вкладке, как и в auth.js
  } catch {
    return '' // приватный режим
  }
}

// ── Новости для панели управления ──
// Панель слушает их сама: держать этот список внутри React неудобно, соединение
// живёт дольше любой открытой страницы.
const serviceListeners = new Set()
let online = []

export function onService(fn) {
  serviceListeners.add(fn)
  return () => serviceListeners.delete(fn)
}

export function onlineCodes() {
  return online
}

function tellService(event) {
  for (const fn of [...serviceListeners]) {
    try {
      fn(event)
    } catch {
      /* один сломавшийся слушатель не должен мешать остальным */
    }
  }
}

// ── Что делать с пришедшим ──
// Обработчики вынесены отдельно, потому что дорог к ним две: на сайте события
// приходят прямо из соединения в окне, а в программе для Windows соединение держит
// её основная часть (ключ входа лежит там) и пересылает события в окно.

function whenConnected() {
  setRealtimeConnected(true)
  // Пока связи не было, в базе могло измениться что угодно. Сбрасываем всё
  // разом: без этого после короткого обрыва на экране остаются вчерашние остатки.
  refreshAll()
}

// Сервер прислал список устаревших разделов
const whenChanged = (keys) => invalidate(Array.isArray(keys) ? keys : [keys])

// ── Подписку продлили, возобновили или поправили срок ──
// Переспрашиваем «кто я»: от ответа зависят и предупреждение наверху, и то,
// разрешена ли продажа. Ждать перезагрузки нельзя — касса открыта во вкладке
// весь день, и клиент, который только что заплатил, будет звонить снова.
async function whenSubscription(e) {
  const { refreshMe } = await import('./auth')
  await refreshMe().catch(() => {})
  refreshAll()
  if (e?.note) notify(e.note, 'ok')
}

// ── Работу остановили ──
async function whenSuspended(e) {
  const { suspendNow } = await import('./auth')
  // Заголовок приходит только от программы для Windows: она закрывает работу и по
  // своей причине — слишком долго не было связи с сервером
  suspendNow(e?.message, e?.title)
}

// ── Сервер принял нас обратно ──
// Само по себе «подключились» ничего не значит: приостановленную аптеку сервер
// сначала пускает и только потом, сверившись с базой, обрывает. Поэтому снимаем
// объявление не по факту соединения, а по слову сервера — оно приходит только
// тем, кого он действительно пустил работать.
//
// Нужно это тем, кто заплатил, пока объявление висело на экране: кассир никуда
// не нажимал, а работа уже вернулась.
async function whenResumed() {
  const { clearSuspension } = await import('./auth')
  clearSuspension()
}

// ── Программа для Windows ──
// Соединение открывает её основная часть, сюда приходят уже готовые события.
// Подписываемся один раз на всю жизнь окна: соединение переоткрывается при каждой
// смене ключа входа, а слушатель остаётся тем же.
let desktopListening = false

function startDesktopRealtime() {
  if (!readToken()) return null
  if (!desktopListening) {
    desktopListening = true
    bridge.realtime.on((msg) => {
      const { type, payload } = msg || {}
      if (type === 'connect') whenConnected()
      else if (type === 'disconnect') setRealtimeConnected(false)
      else if (type === 'changed') whenChanged(payload)
      else if (type === 'subscription') whenSubscription(payload)
      else if (type === 'suspended') whenSuspended(payload)
      else if (type === 'resumed') whenResumed()
      // Связь, очередь на отправку, копия базы, обновление — для значка в шапке
      else if (type === 'status') setDesktopStatus(payload)
    })
    // Windows сообщила, что сеть появилась, — не ждём очередной попытки по таймеру
    window.addEventListener('online', () => bridge.sync?.now().catch(() => {}))
  }
  bridge.realtime.start().catch(() => {})
  refreshDesktopStatus()
  return true
}

export function startRealtime() {
  if (bridge) return startDesktopRealtime()

  const token = readToken()
  if (!token) return null
  if (socket && socketToken === token) return socket
  if (socket) stopRealtime()
  socketToken = token

  socket = io(serverOrigin(import.meta.env?.VITE_API_URL) || undefined, {
    auth: { token },
    // ── Сразу постоянное соединение, с откатом на обычные запросы ──
    // Раньше связь всегда начиналась с обычных запросов и лишь потом переходила
    // на постоянное соединение — лишний круг при каждом запуске. Хуже другое:
    // на обычных запросах уход человека замечается только по молчанию, до полуминуты,
    // и отметка «сейчас за кассой» гасла с большим опозданием.
    //
    // Теперь пробуем постоянное соединение первым. Если сеть заведения его режет —
    // а такое бывает, — socket.io сам откатится на обычные запросы: за это отвечает
    // tryAllTransports. Без него откат бы не сработал, и связи не было бы вовсе.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  })

  socket.on('connect', whenConnected)
  socket.on('disconnect', () => setRealtimeConnected(false))
  socket.on('connect_error', () => setRealtimeConnected(false))
  socket.on('changed', whenChanged)
  socket.on('subscription', whenSubscription)
  socket.on('suspended', whenSuspended)
  socket.on('resumed', whenResumed)

  // ── Только владельцу сервиса ──
  socket.on('service', (e) => tellService(e || {}))
  socket.on('presence', (e) => {
    online = Array.isArray(e?.online) ? e.online : []
    tellService({ what: 'presence', online })
  })

  return socket
}

// Токен сменился — переоткрываем связь под новым. Вызывается из auth.js при
// каждой смене: соединение живёт дольше страницы и само об этом не узнает.
export function resyncRealtime() {
  // В программе для Windows ключ входа меняет её основная часть — она же сама
  // переоткрывает соединение под новым. Окну остаётся только включить или выключить
  if (bridge) {
    if (readToken()) startDesktopRealtime()
    else stopRealtime()
    return
  }
  if (socket && socketToken === readToken()) return
  stopRealtime()
  if (readToken()) startRealtime()
}

export function stopRealtime() {
  setRealtimeConnected(false)
  online = []
  socketToken = ''
  if (bridge) {
    bridge.realtime.stop().catch(() => {})
    return
  }
  if (!socket) return
  socket.removeAllListeners()
  socket.disconnect()
  socket = null
}
