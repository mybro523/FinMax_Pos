import { useEffect, useRef, useState } from 'react'

// ── Поиск и фильтры, закреплённые вверху ──
// Владелец (31.10.2026): «поиск и категории — закреплены наверху и при скролле не исчезают»,
// во всех разделах с поиском. Полоса липнет к верху окна (position: sticky — см. index.css,
// «.stick-top»), а пока она прилипла, снизу у неё тень: видно, что список едет под ней.
//
// «Липкий» элемент держится только в пределах своего родителя. Поэтому полоса должна
// стоять прямо в том, что содержит весь список: на странице — среди её блоков, в панели —
// прямо в панели, а не в обёртке с отступами (та короткая — полоса уехала бы с ней).
//
// panel — полоса в панели: фон панели, края панели; pad — отступы внутри полосы (они
// заменяют отступы обёртки, из которой полосу вынули).
//
// «Прилипла» узнаём по метке перед полосой: метка ушла за верх окна — значит, полоса
// держится сама. Метка — пустая строка высотой в пиксель, на раскладку не влияет.
// Окно для метки продлено далеко вниз: «видна» — значит, ниже верхнего края. Иначе
// прокрутка рывком (End, ползунок) переносила метку из-под окна сразу за его верх, не
// показав ни разу, — наблюдатель молчал, и тень не появлялась
export default function StickyBar({ panel = false, pad, className = '', children, ...rest }) {
  const mark = useRef(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = mark.current
    if (!el || typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { rootMargin: '0px 0px 100000px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const cls = ['stick-top', panel && 'in-panel', stuck && 'is-stuck', className].filter(Boolean).join(' ')
  return (
    <>
      <div ref={mark} className="stick-mark" aria-hidden="true" />
      <div {...rest} className={cls}>
        {pad != null ? <div className="stick-pad" style={{ padding: pad }}>{children}</div> : children}
      </div>
    </>
  )
}
