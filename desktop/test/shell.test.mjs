// ── Оболочка программы: то, что должно сходиться между файлами ──
//
// Программа собрана из нескольких частей, которые знают друг о друге только по
// именам: мост называет каналы, основная часть их слушает, упаковщик кладёт файлы.
// Разойдутся имена — и ничего не упадёт при сборке: просто кнопка перестанет
// работать или в установщике не окажется нужного файла. Эти проверки ловят такое
// до того, как программа уедет в аптеку.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLog } from '../src/log.mjs'
import { createWindowState, sanitizeState } from '../src/window-state.mjs'
import { electronEnv, loadEnv } from '../scripts/env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(join(ROOT, p), 'utf8')

test('мост и основная часть называют каналы одинаково', () => {
  const bridge = [...read('src/preload.cjs').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]).sort()
  const main = [...read('src/main.mjs').matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]).sort()
  assert.ok(bridge.length >= 4, 'в мосте подозрительно мало функций')
  assert.deepEqual(bridge, main, 'мост зовёт канал, которого основная часть не слушает (или наоборот)')
})

test('события сервера: мост слушает тот же канал, в который их шлёт основная часть', () => {
  const listen = read('src/preload.cjs').match(/ipcRenderer\.on\('([^']+)'/)?.[1]
  const send = read('src/main.mjs').match(/webContents\.send\('([^']+)'/)?.[1]
  assert.ok(listen && send)
  assert.equal(listen, send)
})

test('окно создаётся в песочнице и без Node на странице', () => {
  // Эти три строки — замок между страницей и компьютером аптеки. Убрать любую
  // значит дать странице доступ к диску и к ключу входа.
  const main = read('src/main.mjs')
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.doesNotMatch(main, /webSecurity: false/)
  assert.doesNotMatch(main, /allowRunningInsecureContent/)
  // Инструменты разработчика в собранной программе выключены
  assert.match(main, /devTools: DEV\b/)
})

test('в мосте нет прямого доступа к системе', () => {
  const bridge = read('src/preload.cjs')
  for (const bad of ["require('fs')", "require('child_process')", "require('node:", 'ipcRenderer.send(', 'process.env', 'eval(']) {
    assert.equal(bridge.includes(bad), false, `в мост попало «${bad}»`)
  }
  // Сам ipcRenderer страница не получает — только обёрнутые функции
  assert.doesNotMatch(bridge, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
})

test('упаковщик кладёт в программу всё, что она открывает при запуске', () => {
  const yml = read('electron-builder.yml')
  for (const need of ['src/**/*', 'renderer/**/*', 'assets/fonts/**/*', 'assets/icon.png', 'build-config.json', 'package.json']) {
    assert.ok(yml.includes(`- ${need}`), `в установщик не попадёт: ${need}`)
  }
  // Сценарии сборки, проверки и настройки с адресами в установщик уходить не должны
  for (const extra of ['scripts', 'test/', 'e2e', '.env']) {
    assert.equal(new RegExp(`^\\s*-\\s*${extra.replace(/[.*/]/g, '\\$&')}`, 'm').test(yml), false, `в установщик уходит лишнее: ${extra}`)
  }
})

test('удаление программы не стирает её данные', () => {
  // В данных лежат ключи входа и локальная база с чеками, которые ещё не ушли на сервер
  assert.match(read('electron-builder.yml'), /deleteAppDataOnUninstall:\s*false/)
})

test('библиотека локальной базы попадает в программу — и лежит там, откуда Windows может её загрузить', () => {
  const yml = read('electron-builder.yml')
  // Это настоящая библиотека Windows: изнутри архива программы она не загрузится
  assert.match(yml, /asarUnpack:\s*-\s*node_modules\/better-sqlite3\/prebuilds\/\*\.node/)
  // Пересборка потребовала бы компилятор на компьютере сборки — готовый файл подходит как есть
  assert.match(yml, /npmRebuild:\s*false/)
  // Сам готовый файл для 64-разрядной Windows на месте и не исключён из сборки
  assert.ok(fs.existsSync(join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node')))
  assert.doesNotMatch(yml, /!node_modules\/better-sqlite3\/prebuilds\/win32-x64/)
  const pkg = JSON.parse(read('package.json'))
  for (const dep of ['better-sqlite3', 'decimal.js', 'socket.io-client']) {
    assert.ok(pkg.dependencies[dep], `«${dep}» должен быть обычной зависимостью: в программу попадают только они`)
  }
})

test('окно не получает доступа к локальной базе — только запросы через основную часть', () => {
  const bridge = read('src/preload.cjs')
  for (const bad of ['sqlite', 'local/', 'gateway']) {
    assert.equal(bridge.includes(bad), false, `в мост попало «${bad}»`)
  }
  // База открывается только в основной части программы
  const main = read('src/main.mjs')
  assert.match(main, /openDb\(/)
  assert.match(main, /createGateway\(/)
})

test('на исполняемом файле стоят замки', () => {
  const yml = read('electron-builder.yml')
  assert.match(yml, /runAsNode:\s*false/)
  assert.match(yml, /enableNodeCliInspectArguments:\s*false/)
  assert.match(yml, /enableNodeOptionsEnvironmentVariable:\s*false/)
  assert.match(yml, /onlyLoadAppFromAsar:\s*true/)
})

test('шрифты, на которые ссылается стиль, лежат рядом', () => {
  const css = read('assets/fonts/inter.css')
  const files = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => m[1])
  assert.equal(files.length, 12)
  for (const f of files) assert.ok(fs.existsSync(join(ROOT, 'assets', 'fonts', f)), `нет файла шрифта: ${f}`)
  // Таджикские буквы (ғ қ ҳ ҷ ӣ ӯ) лежат в расширенной кириллице — без неё они
  // показывались бы другим шрифтом посреди слова
  assert.match(css, /cyrillic-ext/)
  assert.match(css, /U\+0460-052F/)
})

test('сборка интерфейса для программы подключает свой шрифт, а не Google', () => {
  const vite = fs.readFileSync(join(ROOT, '..', 'client', 'vite.config.js'), 'utf8')
  assert.match(vite, /\.\/_fonts\/inter\.css/)
  assert.match(vite, /outDir: '\.\.\/desktop\/renderer'/)
  assert.match(vite, /base: '\.\/'/)
})

// ── Размер окна ──

test('размер окна: мусор в файле даёт размер по умолчанию', () => {
  assert.deepEqual(sanitizeState(null), { width: 1366, height: 800, maximized: true })
  assert.deepEqual(sanitizeState({ width: 'x', height: -5, maximized: 'да' }), { width: 1366, height: 800, maximized: true })
  assert.deepEqual(sanitizeState({ width: 50, height: 99999999 }), { width: 1366, height: 800, maximized: true })
  assert.deepEqual(sanitizeState({ width: 1024.7, height: 700, maximized: false }), { width: 1024, height: 700, maximized: false })
})

test('размер окна запоминается и читается обратно', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-window-'))
  const st = createWindowState({ file: join(dir, 'window.json'), fs })
  assert.deepEqual(st.load(), { width: 1366, height: 800, maximized: true })
  st.save({ width: 1100, height: 720, maximized: false, x: -5000, y: 12 })
  // Положение не сохраняем: окно, открывшееся за краем отключённого монитора, не достать
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'window.json'), 'utf8')), { width: 1100, height: 720, maximized: false })
  assert.deepEqual(st.load(), { width: 1100, height: 720, maximized: false })
})

// ── Журнал ──

test('журнал пишет строки со временем и не растёт без предела', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-log-'))
  const file = join(dir, 'main.log')
  const log = createLog({ file, fs, now: () => new Date('2026-10-04T12:00:00.000Z') })
  log.info('запуск', { v: 1 })
  log.error('беда', new Error('что-то сломалось'))
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^2026-10-04T12:00:00\.000Z INFO {2}запуск \{"v":1\}$/m)
  assert.match(text, /ERROR беда Error: что-то сломалось/)

  // Дорос до предела — прежний уходит в «.old», начинается новый
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10))
  log.warn('после предела')
  assert.ok(fs.existsSync(file + '.old'))
  assert.ok(fs.statSync(file).size < 1000)
})

test('журнал не роняет программу, если писать некуда', () => {
  const broken = {
    statSync: () => {
      throw new Error('ENOENT')
    },
    appendFileSync: () => {
      throw new Error('EACCES')
    },
    renameSync: () => {},
  }
  const log = createLog({ file: 'x:/нет/main.log', fs: broken })
  assert.doesNotThrow(() => log.error('некуда писать'))
})

// ── Настройки сценариев ──

test('файл .env читается, но окружение сильнее него', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-env-'))
  fs.writeFileSync(
    join(dir, '.env'),
    ['# пояснение', 'APTEKA_API_URL=https://from-file.example/api', 'QUOTED="в кавычках"', '  SPACED = значение  ', 'ПЛОХОЕ ИМЯ=1', ''].join('\r\n'),
  )
  const env = loadEnv(dir, { APTEKA_API_URL: 'https://from-env.example/api', OTHER: 'x' })
  assert.equal(env.APTEKA_API_URL, 'https://from-env.example/api')
  assert.equal(env.QUOTED, 'в кавычках')
  assert.equal(env.SPACED, 'значение')
  assert.equal(env.OTHER, 'x')
  assert.equal(Object.keys(env).some((k) => k.includes('ПЛОХОЕ')), false)
  // Без переменной в окружении берётся значение из файла
  assert.equal(loadEnv(dir, {}).APTEKA_API_URL, 'https://from-file.example/api')
})

test('пометка редактора «запускать как Node» снимается', () => {
  // Терминал VS Code ставит её сам: с ней программа открылась бы не окном, а голым Node
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = electronEnv({ APTEKA_DEV_URL: 'http://127.0.0.1:5181' })
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
    assert.equal(env.APTEKA_DEV_URL, 'http://127.0.0.1:5181')
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE
  }
})
