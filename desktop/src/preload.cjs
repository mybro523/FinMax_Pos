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
    // «Закрыть программу» и «Свернуть»: программа открыта на весь экран, системных
    // кнопок окна не видно — эти стоят в полосе внизу и на экране входа
    quit: () => ipcRenderer.invoke('app:quit'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    // Ссылка со страницы «О компании». Окно называет только имя ссылки (site, phone…),
    // адрес знает основная часть: произвольный адрес отсюда не открыть
    open: (key) => ipcRenderer.invoke('app:open', key),
  },

  // ── Обмен кассами по местной сети ──
  // Кто из соседних касс на связи; адрес соседа вручную, если кассы не нашли друг друга
  lan: {
    status: () => ipcRenderer.invoke('lan:status'),
    add: (address) => ipcRenderer.invoke('lan:add', address),
    remove: (address) => ipcRenderer.invoke('lan:remove', address),
    forget: (id) => ipcRenderer.invoke('lan:forget', id),
    now: () => ipcRenderer.invoke('lan:now'),
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
    // Снять свежую копию и положить её в папку, которую человек выберет в системном окне
    saveTo: () => ipcRenderer.invoke('backup:saveTo'),
    // Загрузить копию: список копий (под номерами — путей окно не видит), копии из папки,
    // выбранной в системном окне, и сама загрузка: программа перезапустится
    copies: () => ipcRenderer.invoke('backup:copies'),
    pick: () => ipcRenderer.invoke('backup:pick'),
    restore: (id, confirm) => ipcRenderer.invoke('backup:restore', { id, acceptForeign: confirm?.acceptForeign === true, acceptLoss: confirm?.acceptLoss === true }),
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

  // Выгрузка в Excel: страница собирает файл, основная часть спрашивает, куда его
  // сохранить, и записывает. Скачать файл обычным способом окно в программе не может
  file: {
    saveXlsx: (name, bytes) => ipcRenderer.invoke('file:save-xlsx', { name, bytes }),
  },

  // Обновление программы
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    // Перезапустить и поставить уже скачанное обновление
    install: () => ipcRenderer.invoke('update:install'),
  },
})
