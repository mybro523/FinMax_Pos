// ── Общее для сценариев запуска и сборки ──
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CLIENT = join(DESKTOP, '..', 'client')

// Настройки из файла desktop/.env (а за ним .env.local): строки ВИДА ИМЯ=значение.
// То, что уже задано в окружении, файл не перебивает — так адрес сервера можно
// задать и разово в командной строке, и постоянно в файле.
export function loadEnv(dir = DESKTOP, base = process.env) {
  const out = {}
  for (const name of ['.env', '.env.local']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m || line.trim().startsWith('#')) continue
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return { ...out, ...base }
}

// ── Окружение для запуска самой программы ──
// Редактор VS Code сам построен на Electron и оставляет в своём терминале пометку
// ELECTRON_RUN_AS_NODE. С ней наша программа запустилась бы не программой, а голым
// Node: без окна, с ошибкой «app is undefined». Снимаем пометку всегда — тот, кто
// запускает из терминала редактора, о ней и не подозревает.
export function electronEnv(extra = {}) {
  const env = { ...loadEnv(), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

// Путь к исполняемому файлу Electron. Пакет electron, запрошенный из обычного Node,
// возвращает именно его
export function electronBinary() {
  return createRequire(import.meta.url)('electron')
}

// Сценарий из папки client (сборщик Vite) — запускаем тем же Node, без npx:
// на Windows npx — это файл .cmd, и путь с пробелом разваливает такой вызов
export function clientBin(...parts) {
  return join(CLIENT, 'node_modules', ...parts)
}
