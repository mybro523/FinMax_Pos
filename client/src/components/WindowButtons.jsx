import { LuMinus, LuPower } from 'react-icons/lu'
import { bridge, isDesktop } from '../lib/desktop'
import { useT } from '../lib/i18n'
import { useDialog } from './ui'

// ── «Свернуть» и «Закрыть программу» ──
// Программа для Windows открывается на весь экран: ни заголовка окна с его кнопками,
// ни панели задач. Чтобы свернуть или закрыть её, не нужно знать сочетаний клавиш —
// эти кнопки есть в самой программе: в полосе внизу окна и на экране входа.
// F11 выходит из полноэкранного режима и возвращает его (desktop/src/window-state.mjs).
// На сайте кнопок нет: окном браузера управляет сам браузер.
//
// Закрыть программу — переспрашиваем: кнопка стоит рядом с «Блокировкой», и случайное
// нажатие выключило бы кассу посреди очереди.

export function useCloseApp() {
  const dialog = useDialog()
  const t = useT()
  return async () => {
    const ok = await dialog.confirm({
      title: t('Закрыть программу?'),
      message: t('Всё сделанное сохранено. При следующем запуске нужно будет войти заново.'),
      confirmText: t('Закрыть'),
    })
    if (!ok) return
    if (bridge?.app?.quit) bridge.app.quit().catch(() => window.close())
    else window.close()
  }
}

const minimize = () => bridge?.app?.minimize?.().catch(() => {})

export default function WindowButtons({ className = 'btn ghost sm' }) {
  const t = useT()
  const closeApp = useCloseApp()
  if (!isDesktop) return null
  return (
    <>
      <button type="button" className={className} onClick={minimize} data-tour="app.minimize" title={t('Свернуть программу. F11 — выйти из полноэкранного режима')}>
        <span className="ic"><LuMinus size={15} /></span> {t('Свернуть')}
      </button>
      <button type="button" className={className} onClick={closeApp} data-tour="app.quit" title={t('Закрыть программу')}>
        <span className="ic"><LuPower size={15} /></span> {t('Закрыть программу')}
      </button>
    </>
  )
}
