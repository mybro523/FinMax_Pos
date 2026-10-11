// ── Разработка: программа с живой подменой кода интерфейса ──
// Поднимает сервер интерфейса (Vite, режим desktop) и открывает программу, которая
// смотрит на него. Поправили файл в client/ — окно обновилось само, без пересборки.
//
// Запуск:  npm run electron:dev   (в папке desktop)
// Адрес сервера — из APTEKA_API_URL (в окружении или в desktop/.env).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CLIENT, DESKTOP, clientBin, electronBinary, electronEnv, loadEnv } from './env.mjs'

const DEV_URL = 'http://127.0.0.1:5181'

const vite = clientBin('vite', 'bin', 'vite.js')
if (!existsSync(vite)) {
  console.error('Не найден сборщик интерфейса. Выполните «npm install» в папке client.')
  process.exit(1)
}
const env = loadEnv()
if (!env.APTEKA_API_URL && !env.VITE_API_URL) {
  console.error('Не задан адрес сервера. Укажите APTEKA_API_URL в окружении или в файле desktop/.env')
  console.error('(образец — desktop/.env.example).')
  process.exit(1)
}

const ui = spawn(process.execPath, [vite, '--mode', 'desktop'], { cwd: CLIENT, stdio: 'inherit' })
let app = null

function stop(code = 0) {
  if (app && !app.killed) app.kill()
  if (!ui.killed) ui.kill()
  process.exit(code)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
ui.on('exit', (code) => {
  if (!app) {
    console.error('Сервер интерфейса не запустился.')
    process.exit(code || 1)
  }
})

// Ждём, пока сервер интерфейса начнёт отвечать: открытая раньше времени программа
// показала бы пустое окно с ошибкой загрузки
async function waitForUi() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(DEV_URL)
      if (res.ok) return true
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

if (!(await waitForUi())) {
  console.error('Сервер интерфейса не ответил за 30 секунд.')
  stop(1)
}

app = spawn(electronBinary(), ['.'], {
  cwd: DESKTOP,
  env: electronEnv({ APTEKA_DEV_URL: DEV_URL }),
  stdio: 'inherit',
})
// Закрыли окно программы — гасим и сервер интерфейса
app.on('exit', (code) => stop(code ?? 0))
