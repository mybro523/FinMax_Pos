import { useCallback, useEffect, useRef, useState } from 'react'

// ── Списки целиком, без страниц ──
// Владелец попросил (1.5.5): никаких страниц «1 2 3 … 20» — каждый список раздела
// показывается весь, одной лентой. Чтобы моноблок на Windows 7 не задумывался на тысячах
// товаров, строки дорисовываются при прокрутке: сначала первые FIRST, дальше по STEP, когда
// низ списка подходит к экрану (заранее, за 800 px). Для человека это один длинный список
// без кнопок. Поиск и фильтры раздела работают по всему списку, как и раньше.
//
// Хук и компонент сохранили прежние имена и поля (slice, start, total…) — разделам ничего
// менять не пришлось. resetKey — при смене фильтра или периода список снова рисуется с начала
const FIRST = 80
const STEP = 160

export function usePagination(items, _perPage, resetKey) {
  const list = Array.isArray(items) ? items : []
  const [shown, setShown] = useState(FIRST)
  // Сброс при смене фильтра — синхронно в рендере (без «мигания» и гонки эффектов)
  const keyRef = useRef(resetKey)
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey
    if (shown !== FIRST) setShown(FIRST)
  }
  const total = list.length
  const more = total > shown
  const slice = more ? list.slice(0, shown) : list
  const loadMore = useCallback(() => setShown((n) => n + STEP), [])
  return { page: 1, setPage: () => {}, pages: 1, slice, total, start: 0, perPage: total, more, shown, loadMore }
}

// Метка в конце списка: подошла к экрану — дорисовать ещё. После каждой дорисовки
// наблюдение начинается заново: метка всё ещё у экрана (строки короткие, экран высокий) —
// дорисовывается следующая порция, пока она не уйдёт вниз
export function Pagination({ more, shown, loadMore }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!more || !loadMore) return undefined
    const el = ref.current
    if (!el) return undefined
    if (typeof IntersectionObserver !== 'function') {
      loadMore()
      return undefined
    }
    const io = new IntersectionObserver((list) => {
      if (list.some((e) => e.isIntersecting)) loadMore()
    }, { rootMargin: '0px 0px 800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, shown, loadMore])
  if (!more) return null
  return <div ref={ref} className="list-more" aria-hidden="true" data-testid="list-more" />
}
