// ── Самообновление программы ──
// Касса работает во вкладке, открытой на весь день. Программа одностраничная:
// переходя по разделам, она не перезагружает себя, и после выкладки новой версии
// на устройстве продолжает работать старый код — сколько бы раз мы ни выложили
// исправление. Именно так исправленный приход товара несколько часов «не работал»
// у владельца, хотя на сайте уже лежала рабочая версия.
//
// Поэтому программа сама сверяет свою сборку с той, что лежит на сайте, и
// перезагружается. Имя файла сборки содержит отпечаток содержимого: изменился
// код — изменилось имя. Ничего не поменялось — перезагрузки не будет.

// Модуль намеренно ни от чего не зависит: его подключает и слой данных, и касса,
// а лишние связи здесь легко превратились бы в кольцо импортов.

// Имя файла, из которого прямо сейчас работает программа
const FILE = (() => {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() || ''
  } catch {
    return ''
  }
})()

// Программу для Windows обновляет она сама — целиком, установщиком, а не подменой
// одного файла. Сверяться с сайтом ей не с чем: её файлы лежат на компьютере.
const DESKTOP = typeof window !== 'undefined' && window.apteka?.desktop === true

// В режиме разработки сборки нет (файлы отдаются по одному) — не мешаем работать
const ENABLED = !DESKTOP && /^index-.+\.js$/.test(FILE)

const CHECK_MS = 2 * 60 * 1000 // как часто спрашивать сайт о новой версии
const RETRY_MS = 5000 // как часто пробовать перезагрузиться, когда версия найдена

let pending = false // новая версия найдена, ждём удобного момента
let blockers = 0
let retryTimer = null

// Достаёт имя файла сборки из HTML главной страницы
export function entryFromHtml(html) {
  const m = String(html || '').match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
  return m ? m[1] : null
}

// Пока идёт продажа, программу перезагружать нельзя: набранная корзина живёт
// в памяти страницы и пропадёт вместе с ней. Касса берёт такую защиту на время,
// пока в корзине есть товар.
export function blockUpdate() {
  blockers++
  let released = false
  return () => {
    if (released) return
    released = true
    blockers--
    // Перезагружаемся не сразу: корзина могла просто перестроиться, и защиту
    // тут же возьмут заново. Повторную попытку сделает таймер.
  }
}

// Опасно перезагружаться, если корзина не пуста, идёт запись на сервер
// (обе ситуации держат защиту через blockUpdate) или открыто окно с формой
function busy() {
  if (blockers > 0) return true
  if (typeof document !== 'undefined' && document.querySelector('.overlay')) return true
  return false
}

// Отложена ли сейчас перезагрузка — для проверок и отладки
export const isUpdateHeld = () => busy()

function reloadIfSafe() {
  if (!pending || busy()) return
  window.location.reload()
}

async function check() {
  if (!ENABLED || pending) return
  try {
    // no-store — иначе браузер отдаст ту же страницу из кэша и новой версии мы не увидим
    const res = await fetch('/?_v=' + Date.now(), { cache: 'no-store' })
    if (!res.ok) return
    const latest = entryFromHtml(await res.text())
    if (!latest || latest === FILE) return

    pending = true
    reloadIfSafe()
    if (!retryTimer) retryTimer = setInterval(reloadIfSafe, RETRY_MS)
  } catch {
    /* связи нет — проверим в следующий раз */
  }
}

export function startVersionWatch() {
  if (!ENABLED) return
  setInterval(check, CHECK_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('focus', check)
  check()
}
