import { LuLoaderCircle } from 'react-icons/lu'

// Заглушка на время подгрузки lazy-страницы (код страницы загружается по требованию)
export default function PageFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', color: 'var(--muted-2)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <LuLoaderCircle size={30} className="spin" />
        <span style={{ fontSize: 13 }}>Загрузка…</span>
      </div>
    </div>
  )
}
