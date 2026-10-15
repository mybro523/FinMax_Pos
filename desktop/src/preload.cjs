// ── Мост между окном и основной частью программы ──
//
// Окно — это веб-страница, и работает она в «песочнице»: ни к диску, ни к системе,
// ни к сети у неё доступа нет. Всё, что ей разрешено, перечислено в этом файле.
// Список намеренно короткий: каждая функция здесь — дверь, и лишних быть не должно.
//
// Файл написан в старом стиле (require), а не как остальная программа: в песочнице
// по-другому нельзя.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('apteka', {
  // По этому признаку интерфейс понимает, что он в программе, а не на сайте
  desktop: true,

  // Запрос за данными. Адрес целиком окно указать не может — только путь внутри
  // нашего API. Откуда придёт ответ — из локальной базы или с сервера — решает
  // основная часть; ключ входа подставляет тоже она
  request: (req) => ipcRenderer.invoke('api:request', req),

  app: {
    // «Закрыть программу» с главного экрана
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  session: {
    // Выход: за кассой больше никого. Без нового входа основная часть не выполнит
    // ни одного запроса окна
    clear: () => ipcRenderer.invoke('session:clear'),
  },

  realtime: {
    start: () => ipcRenderer.invoke('realtime:start'),
    stop: () => ipcRenderer.invoke('realtime:stop'),
    // Подписка на события: «раздел изменился», «подписку продлили». Возвращает
    // функцию отписки
    on: (fn) => {
      const handler = (_event, msg) => fn(msg)
      ipcRenderer.on('realtime:event', handler)
      return () => ipcRenderer.removeListener('realtime:event', handler)
    },
  },

  // Версия программы — для экрана настроек и обращений в поддержку
  info: () => ipcRenderer.invoke('app:info'),

  // ── Состояние программы ──
  // Есть ли связь, сколько чеков ждёт отправки, сколько осталось работать без связи.
  // Изменения приходят событием «status» (см. realtime.on), здесь — спросить сразу
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    // Обменяться с сервером прямо сейчас
    now: () => ipcRenderer.invoke('sync:now'),
    // Загрузить весь магазин с сервера заново
    resync: () => ipcRenderer.invoke('sync:resync'),
    // Что сервер не принял (видит только владелец) и «разобрался»
    rejected: () => ipcRenderer.invoke('sync:rejected'),
    dismiss: (id) => ipcRenderer.invoke('sync:dismiss', id),
  },

  // Резервная копия локальной базы
  backup: {
    now: () => ipcRenderer.invoke('backup:now'),
    // Выбрать вторую папку (другой диск, флешка). Саму папку человек указывает
    // в системном окне — путь из окна программы сюда не передаётся
    chooseFolder: () => ipcRenderer.invoke('backup:folder'),
    clearFolder: () => ipcRenderer.invoke('backup:folderClear'),
    // Открыть папку с копиями в Проводнике
    open: () => ipcRenderer.invoke('backup:open'),
  },

  // Печать на чековом принтере (ESC/POS). Не настроен — программа отвечает «system»,
  // и окно печатает как на сайте, через окно печати Windows
  print: {
    config: () => ipcRenderer.invoke('print:config'),
    setConfig: (cfg) => ipcRenderer.invoke('print:setConfig', cfg),
    // Чек или Z-отчёт готовыми строками (client/src/lib/ticket.js)
    ticket: (ticket) => ipcRenderer.invoke('print:ticket', ticket),
    test: () => ipcRenderer.invoke('print:test'),
    // Свой экран печати: лента на выбранный принтер, лист как страница, PDF в файл
    raw: (req) => ipcRenderer.invoke('print:raw', req),
    page: (req) => ipcRenderer.invoke('print:page', req),
    pdf: () => ipcRenderer.invoke('print:pdf'),
  },

  // Обновление программы
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    // Перезапустить и поставить уже скачанное обновление
    install: () => ipcRenderer.invoke('update:install'),
  },
})
