import { LuKeyRound } from 'react-icons/lu'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../db/auth'
import { useDesktopStatus } from '../db/desktopStatus'
import { soloMessage } from '../lib/aktivaciya'
import { useT } from '../lib/i18n'

// ── Магазин без интернета: срок работы (1.7.1) ──
// Пробный срок или код скоро кончаются — напоминание владельцу; кончились — всем: продавать и
// менять нельзя, смотреть и считать можно (и в кассе — сверху, а не только под кнопкой продажи).
// Код вводят на главном компьютере («Настройки» → «Профиль»), на кассе — только объяснение
export default function LicenceBanner() {
  const t = useT()
  const user = useAuth()
  const st = useDesktopStatus()
  const navigate = useNavigate()
  const a = st?.activation
  if (!user?.standalone || !a || a.free) return null
  const stop = !a.active
  if (!stop && !(a.warn && user.role === 'founder')) return null
  const text = soloMessage(a, t)
  if (!text) return null
  const tail = stop && !a.register && !a.stopped ? ` ${t('Продажи и изменения остановлены, просмотр и отчёты работают.')}` : ''
  return (
    <div className={'note ' + (stop ? 'err' : 'warn') + ' licence-banner'} role="status" data-testid="licence-banner">
      <span className="ic"><LuKeyRound size={16} /></span>
      <span className="licence-banner-text">{text}{tail}</span>
      {!a.register && (
        <button type="button" className="btn sm gold" onClick={() => navigate('/settings', { state: { razdel: 'profil', focus: 'code' } })} data-testid="licence-banner-code">
          {t('Ввести код')}
        </button>
      )}
    </div>
  )
}
