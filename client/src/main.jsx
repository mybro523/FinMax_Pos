import './lib/polyfills' // заплатки для старого движка (программа для Windows 7 и 8) — первыми
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App.jsx'
import { unlockAudio } from './lib/sound'
import { startVersionWatch } from './lib/version'
import './lib/theme' // применяет сохранённую тему (светлая/тёмная) при старте
import './lib/lite' // облегчённый вид на слабом компьютере (программа для Windows) — с первого кадра
import './index.css'

// Разблокируем звук сканера при первом жесте пользователя
// Следим за выходом новой версии: без этого вкладка, открытая на весь день,
// продолжает работать по старому коду и не видит выложенных исправлений
startVersionWatch()

const events = ['pointerdown', 'keydown', 'touchend']
function unlockOnce() {
  unlockAudio()
  events.forEach((e) => window.removeEventListener(e, unlockOnce))
}
events.forEach((e) => window.addEventListener(e, unlockOnce))

// ── Адреса разделов ──
// На сайте раздел — это настоящий адрес: /pos, /products. Его можно открыть
// напрямую, потому что хостинг на любой адрес отдаёт одну и ту же страницу.
//
// Программа для Windows открывает свои файлы с диска, и хостинга у неё нет:
// адрес /pos означал бы файл с таким именем, которого не существует, — после
// перезагрузки окна вместо кассы был бы пустой экран. Поэтому в программе раздел
// пишется после решётки (#/pos): файл остаётся тем же, меняется только хвост.
// Выбирается это при сборке (vite build --mode desktop), а не на ходу.
const Router = import.meta.env.MODE === 'desktop' ? HashRouter : BrowserRouter

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>,
)
