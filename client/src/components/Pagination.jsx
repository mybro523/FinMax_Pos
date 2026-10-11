import { useState, useRef } from 'react'
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu'

// Хук пагинации: срез текущей страницы + управление. resetKey сбрасывает на 1-ю страницу
// при смене фильтра/периода. По умолчанию 10 строк на страницу.
export function usePagination(items, perPage = 10, resetKey) {
  const list = Array.isArray(items) ? items : []
  const [page, setPage] = useState(1)
  // Сброс на 1-ю страницу при смене фильтра — синхронно в рендере (без «мигания» и гонки эффектов)
  const keyRef = useRef(resetKey)
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey
    if (page !== 1) setPage(1)
  }
  const total = list.length
  const pages = Math.max(1, Math.ceil(total / perPage))
  // Клэмп ВО ВРЕМЯ рендера — нет пустого/обратного кадра при сжатии списка
  const cur = Math.min(Math.max(1, page), pages)
  const start = (cur - 1) * perPage
  const slice = list.slice(start, start + perPage)
  return { page: cur, setPage, pages, slice, total, start, perPage }
}

// Компактный список номеров страниц: 1 … 4 5 6 … 20
function pageList(cur, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const out = [1]
  const from = Math.max(2, cur - 1)
  const to = Math.min(pages - 1, cur + 1)
  if (from > 2) out.push('…')
  for (let p = from; p <= to; p++) out.push(p)
  if (to < pages - 1) out.push('…')
  out.push(pages)
  return out
}

export function Pagination({ page, pages, setPage, total, start, perPage }) {
  if (total <= perPage) return null
  const from = start + 1
  const to = Math.min(start + perPage, total)
  return (
    <div className="pager">
      <span className="pager-info">{from}–{to} из {total}</span>
      <div className="pager-btns">
        <button className="pager-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Назад">
          <LuChevronLeft size={16} />
        </button>
        {pageList(page, pages).map((p, i) =>
          p === '…' ? (
            <span key={'d' + i} className="pager-dots">…</span>
          ) : (
            <button key={p} className={'pager-btn' + (p === page ? ' active' : '')} onClick={() => setPage(p)}>
              {p}
            </button>
          ),
        )}
        <button className="pager-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Вперёд">
          <LuChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}
