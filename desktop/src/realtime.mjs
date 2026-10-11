// ── Постоянное соединение с сервером ──
//
// На сайте его держит сама страница. В программе — основная часть: соединение
// открывается по ключу входа, а ключ лежит здесь. События сервера идут не прямо
// в окно, а тому, кто отвечает за данные (gateway.mjs): «раздел изменился» значит
// «забери его в локальную базу», и уже после этого окно узнаёт, что пора перечитать.
//
// Чем открывать соединение и куда слать события, передаётся снаружи — модуль
// проверяется без запуска программы.

// События сервера, которые нужны аптеке. «service» и «presence» — для панели
// владельца сервиса, в программе её нет.
const FORWARD = ['changed', 'subscription', 'suspended', 'resumed']

export function createRealtime({ io, origin, session, send }) {
  let socket = null
  // По какому ключу открыто нынешнее соединение. Ключ меняется при входе другого
  // сотрудника и при смене пароля; прежнее соединение осталось бы жить со старым
  let socketToken = ''
  // Нужно ли соединение вообще. Открывается оно только при наличии ключа входа:
  // до входа и после выхода слушать сервер некому
  let wanted = false

  function close() {
    socketToken = ''
    if (!socket) return
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }

  function open() {
    const token = session.get()
    if (!token || !origin) return
    if (socket && socketToken === token) return
    close()
    socketToken = token
    socket = io(origin, {
      auth: { token },
      // Сначала постоянное соединение; если сеть заведения его режет — обычные
      // запросы. Настройки те же, что у сайта (client/src/db/realtime.js)
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    })
    socket.on('connect', () => send('connect'))
    socket.on('disconnect', () => send('disconnect'))
    socket.on('connect_error', () => send('disconnect'))
    for (const type of FORWARD) socket.on(type, (payload) => send(type, payload))
  }

  return {
    start() {
      wanted = true
      open()
    },
    stop() {
      wanted = false
      close()
      send('disconnect')
    },
    // Ключ входа сменился — переоткрываем под новым, если соединение вообще нужно.
    // Сервер разбирает ключ один раз, при подключении, и сам об этом не узнает.
    sessionChanged() {
      if (!wanted) return
      close()
      open()
    },
    isOpen: () => !!socket,
  }
}
