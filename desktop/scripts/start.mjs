// ── Запустить программу из исходников на уже собранном интерфейсе ──
// Нужен после «npm run electron:build -- --dir» или любой сборки интерфейса:
// открывает программу без установки. Адрес сервера — из APTEKA_API_URL
// (в окружении или в desktop/.env).
//
// Запуск:  npm start   (в папке desktop)
import { spawn } from 'node:child_process'
import { DESKTOP, electronBinary, electronEnv } from './env.mjs'

const child = spawn(electronBinary(), ['.', ...process.argv.slice(2)], {
  cwd: DESKTOP,
  env: electronEnv(),
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
