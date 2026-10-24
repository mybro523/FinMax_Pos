// ── Мост страницы экрана покупателя ──
// Странице покупателя дано одно: получать, что показать (корзину и итог присылает окно
// кассы через основную часть программы). Ни запросов к базе, ни к серверу, ни к диску.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('customerScreen', {
  // Что показать сейчас (страница только открылась)
  ready: () => ipcRenderer.invoke('customer:ready'),
  // Корзина изменилась — показать новое
  onState: (cb) => {
    if (typeof cb !== 'function') return
    ipcRenderer.on('customer:state', (_event, state) => cb(state))
  },
})
