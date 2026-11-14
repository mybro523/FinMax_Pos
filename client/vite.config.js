import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { swEntries, swScript } from './src/lib/swFiles.js'

// ── Сайт без интернета: service worker (14.11.2026) ──
// После сборки сайта в dist кладётся sw.js: список всего, что нужно кассе без сети (страница,
// код, стили, шрифты, картинки), с отпечатками содержимого, и сам service worker
// (src/lib/sw-worker.js). Только сайт: у программы для Windows файлы и так на компьютере
function serviceWorker() {
  let root = '.'
  let outDir = 'dist'
  return {
    name: 'finmax-sw',
    apply: 'build',
    configResolved(cfg) {
      root = cfg.root
      outDir = resolve(cfg.root, cfg.build.outDir)
    },
    closeBundle() {
      if (!existsSync(join(outDir, 'index.html'))) return
      const files = []
      const walk = (dir, rel) => {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? rel + '/' + d.name : d.name
          if (d.isDirectory()) walk(join(dir, d.name), r)
          else files.push({ path: r, hash: createHash('sha256').update(readFileSync(join(dir, d.name))).digest('hex').slice(0, 12) })
        }
      }
      walk(outDir, '')
      const template = readFileSync(join(root, 'src', 'lib', 'sw-worker.js'), 'utf8')
      writeFileSync(join(outDir, 'sw.js'), swScript(template, swEntries(files)))
    },
  }
}

// ── Знакомство с сервером начинаем заранее ──
// Пока браузер качает и разбирает код программы, соединения с сервером ещё нет.
// Первый же запрос платит за всё сразу: найти адрес, установить связь, договориться
// о шифровании. Из Душанбе до Амстердама это около трети секунды — при том, что сам
// ответ приходит за сто.
//
// Строчка preconnect говорит браузеру начать это знакомство немедленно, параллельно
// с загрузкой кода. К моменту первого запроса всё уже готово.
//
// Отдельным плагином, а не прямо в index.html: адрес сервера известен только при
// сборке, а подставить его в href обычной подстановкой Vite не даёт — он пытается
// разобрать «%VITE_API_URL%» как адрес и спотыкается.
function preconnectApi() {
  let resolved = ''
  return {
    name: 'preconnect-api',
    // Берём адрес так же, как его видит сама программа. Vite собирает env из файлов
    // .env и из переменных окружения хостинга — то есть ровно то же значение, что
    // попадёт в код. Читать process.env отдельно не надо и нельзя: этот файл
    // проверяется теми же правилами, что и код для браузера.
    configResolved(cfg) {
      resolved = cfg.env?.VITE_API_URL || ''
    },
    transformIndexHtml(html, ctx) {
      const api = ctx?.server ? '' : resolved
      // В разработке сервер тот же, что и страница, — знакомиться не с кем
      if (!api || api.startsWith('/')) return html
      let origin
      try {
        origin = new URL(api).origin
      } catch {
        return html
      }
      return html.replace(
        '</head>',
        `  <link rel="preconnect" href="${origin}" crossorigin />
  </head>`,
      )
    },
  }
}

// ── Шрифт для программы Windows ──
// Сайт берёт шрифт Inter со своего адреса (/fonts, блок inter:start…inter:end в index.html).
// Программа обязана выглядеть одинаково и без интернета, а свой шрифт у неё лежит внутри
// (его отдаёт desktop/src/protocol.mjs) — в её сборке этот блок заменяется одной ссылкой
// на него. Блока нет — сборка останавливается: программа осталась бы без шрифта
function localFonts() {
  return {
    name: 'local-fonts',
    transformIndexHtml(html) {
      const re = /[ \t]*<!-- inter:start[\s\S]*?<!-- inter:end -->/
      if (!re.test(html)) throw new Error('index.html: нет блока шрифта inter:start…inter:end')
      return html.replace(re, '    <link rel="stylesheet" href="./_fonts/inter.css" />')
    },
  }
}

// Общие для сайта и программы части сборки
// Тяжёлые библиотеки — в отдельные файлы. Они меняются редко, поэтому браузер
// берёт их из кэша даже после выкладки новой версии программы.
const rollupOptions = {
  output: {
    manualChunks: {
      react: ['react', 'react-dom', 'react-router-dom'],
      charts: ['recharts'],
      scanner: ['@zxing/browser', '@zxing/library'],
    },
  },
}

// ── Сборка для программы Windows: vite build --mode desktop ──
// Отличий от сайта три, и все вынужденные:
//   • base './' — файлы программы лежат на диске, и пути к ним должны считаться
//     от самой страницы, а не от корня сайта, которого нет;
//   • сборка кладётся прямо в папку программы (desktop/renderer);
//   • шрифт свой, без обращения в интернет.
// Сертификат для разработки (basicSsl) и «знакомство с сервером» программе не нужны:
// её окно в сеть не ходит.
const desktop = {
  base: './',
  plugins: [react(), localFonts()],
  build: {
    outDir: '../desktop/renderer',
    emptyOutDir: true,
    rollupOptions,
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    open: false,
  },
}

export default defineConfig(({ mode }) => (mode === 'desktop' ? desktop : {
  plugins: [react(), basicSsl(), preconnectApi(), serviceWorker()],
  build: {
    rollupOptions,
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: true, // доступ с телефона по локальной сети (LAN IP)
    port: 5180,
    open: true,
    // В деве запросы /api проксируются на локальный бэкенд NestJS (порт 3000),
    // чтобы не было CORS и работало даже с телефона через один адрес.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      // Постоянное соединение для мгновенных обновлений — тоже на локальный бэкенд
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
}))
