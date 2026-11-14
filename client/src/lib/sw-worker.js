// ── Service worker сайта FinMax POS (14.11.2026): сайт открывается и без интернета ──
//
// Это не модуль приложения: сборка (плагин в vite.config.js) кладёт этот текст в dist/sw.js,
// приписав первой строкой список файлов и номер версии (self.__FINMAX_SW__, lib/swFiles.js).
// В программе для Windows его нет — её файлы и так на компьютере.
//
// Что делает:
//   • при установке кладёт в кэш браузера всё, что нужно для открытия кассы без сети
//     (файлы, уже скачанные прежней версией, берёт из её кэша — после выкладки качается
//     только изменившееся);
//   • страница (переход по адресу сайта) — сначала из сети: с интернетом человек всегда
//     получает новую версию сайта. Сеть молчит дольше NAV_TIMEOUT_MS или её нет — страница
//     из кэша, той же версии, что и код в кэше (смешать версии нельзя — был бы белый экран);
//   • код, стили, шрифты, картинки — из кэша, чего нет — из сети;
//   • запросы к серверу (API, постоянное соединение) и чужие адреса не трогает вовсе.
// Хранит две последние версии: открытая вкладка старой версии догружает свои разделы.

const MANIFEST = self.__FINMAX_SW__ || { version: 'dev', entries: [] }
const PREFIX = 'finmax-site-'
const CACHE = PREFIX + MANIFEST.version
const KEEP = 2
const NAV_TIMEOUT_MS = 4000
const STATIC = /^\/(assets|fonts|menu|brand|pokupatel)\//

const keyOf = (e) => (e.rev ? e.url + '?__v=' + e.rev : e.url)

// Ответ после переадресации браузер не даёт отдать странице как есть — переписываем
async function clean(res) {
  if (!res.redirected) return res
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(
        MANIFEST.entries.map(async (e) => {
          const key = keyOf(e)
          if (await cache.match(key)) return
          // Этот же файл (то же имя и отпечаток) уже скачала прежняя версия
          const old = await caches.match(key)
          if (old) return cache.put(key, old)
          const res = await fetch(e.url, { cache: e.rev ? 'no-cache' : 'default', credentials: 'same-origin' })
          if (!res.ok) throw new Error('не скачался ' + e.url)
          await cache.put(key, await clean(res))
        }),
      )
      // Новая версия начинает работать сразу, не дожидаясь закрытия всех вкладок
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Порядок имён — порядок создания: оставляем текущую и одну прежнюю
      const others = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE)
      const drop = others.slice(0, Math.max(0, others.length - (KEEP - 1)))
      await Promise.all(drop.map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

// Файл по адресу: сначала в кэше этой версии, потом в прежней
async function lookup(path) {
  const cur = await caches.open(CACHE)
  return (await cur.match(path, { ignoreSearch: true })) || (await caches.match(path, { ignoreSearch: true })) || null
}

async function fromCache(request, url) {
  const hit = await lookup(url.pathname)
  if (hit) return hit
  const res = await fetch(request)
  // Код новой версии, скачанный с интернетом, — тоже в кэш (имя с отпечатком, не устареет)
  if (res.ok && url.pathname.startsWith('/assets/')) {
    const copy = res.clone()
    caches
      .open(CACHE)
      .then((c) => c.put(url.pathname, copy))
      .catch(() => {})
  }
  return res
}

async function navigate(request, url) {
  try {
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('долго')), NAV_TIMEOUT_MS)
      fetch(request).then(
        (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
    // Хостинг прилёг — лучше вчерашняя страница из кэша, чем ошибка
    if (res.status >= 500) throw new Error('сервер сайта')
    return res
  } catch {
    const page = url.pathname.startsWith('/pokupatel') ? '/pokupatel/index.html' : '/index.html'
    return (await lookup(page)) || Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  // Сервер и чужие адреса — мимо: API живёт на своём адресе, а данные кассы — её дело
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request, url))
    return
  }
  if (STATIC.test(url.pathname)) event.respondWith(fromCache(request, url))
})
