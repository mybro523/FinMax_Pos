import { lazy, Suspense } from 'react'
import { useTourState } from '../lib/tur'

// ── Место, где живёт тур ──
// Сам тур с текстами всех разделов грузится только тогда, когда его запустили.
// Пока тур не идёт, здесь ничего нет — ни разметки, ни загрузки.
const TurRunner = lazy(() => import('./TurRunner'))

export default function TurHost() {
  const s = useTourState()
  if (!s.id) return null
  return (
    <Suspense fallback={null}>
      <TurRunner id={s.id} index={s.index} />
    </Suspense>
  )
}
