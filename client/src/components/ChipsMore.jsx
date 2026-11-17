import { useLayoutEffect, useRef, useState } from 'react'
import { LuChevronDown, LuChevronUp } from 'react-icons/lu'
import { useT } from '../lib/i18n'

// ── Ряд кнопок-фильтров, которых бывает много (категории) ──
// На телефоне (17.11.2026, просьба владельца: ничего не листается вбок, кнопки — в несколько
// рядов) ряд показывает не больше двух строк, а остальное — по кнопке «Ещё» (index.css,
// .chips-more). На компьютере это обычный ряд .chips. Кнопка «Ещё» появляется, только если
// что-то действительно не поместилось; раскрытый ряд сворачивается той же кнопкой — и сам,
// когда выбрали кнопку из ряда: иначе раскрытая полоса закрывала бы полэкрана. Выбранная
// кнопка в свёрнутом ряду встаёт первой (index.css), поэтому выбор всегда виден
export default function ChipsMore({ className = '', children, ...rest }) {
  const t = useT()
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  // Проверка после каждой отрисовки: кнопок могло стать больше или меньше, а высота ряда
  // при этом не меняется (она ограничена двумя строками)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const check = () => setOver(el.scrollHeight > el.clientHeight + 2)
    check()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  })
  return (
    <>
      <div
        ref={ref}
        className={'chips chips-more' + (open ? ' open' : '') + (className ? ' ' + className : '')}
        {...rest}
        onClick={(e) => {
          rest.onClick?.(e)
          if (open && e.target.closest?.('.chip')) setOpen(false)
        }}
      >
        {children}
      </div>
      {(over || open) && (
        <button type="button" className="chips-more-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="chips-more">
          {open ? <LuChevronUp size={15} /> : <LuChevronDown size={15} />} {open ? t('Свернуть') : t('Ещё')}
        </button>
      )}
    </>
  )
}
