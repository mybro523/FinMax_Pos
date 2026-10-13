import { useEffect } from 'react'

// ── Просмотр фото на весь экран ──
// Клик по миниатюре товара открывает снимок поверх всего; закрывается кликом
// в любом месте и клавишей Esc. Это просто просмотр — никаких действий внутри.
export default function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!src) return null
  return (
    <div className="lightbox" role="dialog" aria-label={alt || ''} onClick={onClose}>
      <img src={src} alt={alt || ''} />
      {alt && <div className="lightbox-name">{alt}</div>}
    </div>
  )
}
