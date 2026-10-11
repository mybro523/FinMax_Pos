import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

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
// Сайт берёт шрифт Inter у Google. Программе так нельзя: она обязана выглядеть
// одинаково и без интернета, а окну программы выход в сеть закрыт вовсе.
// Поэтому в её сборке ссылки на Google заменяются одной ссылкой на шрифт,
// который лежит внутри самой программы (его отдаёт desktop/src/protocol.mjs).
function localFonts() {
  return {
    name: 'local-fonts',
    transformIndexHtml(html) {
      return html
        .replace(/\s*<!--[^>]*Inter[^>]*-->/, '')
        .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.[^>]*>/g, '')
        .replace(
          /<link href="https:\/\/fonts\.googleapis\.com[^>]*>/,
          '<link rel="stylesheet" href="./_fonts/inter.css" />',
        )
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
  plugins: [react(), basicSsl(), preconnectApi()],
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
