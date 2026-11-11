import { useEffect, useState } from 'react'
import { LuMonitor } from 'react-icons/lu'
import { useAuth } from '../db/auth'
import { useLang, useT } from '../lib/i18n'
import { customerLabels, customerNow, onPokupatel, pokupatelOtkryt, showCustomer } from '../lib/customerScreen'
import { useToast } from './ui'

// ── Экран покупателя на сайте (1.7.5) ──
// Двусторонний моноблок, касса работает на сайте: заднюю сторону занимает окно покупателя —
// то же, что в программе для Windows (приветствие, корзина с итогом, «Спасибо» и сдача).
// Окно открывается отсюда кнопкой: сам браузер окно не откроет (только по нажатию), поэтому
// после запуска Chrome его открывают один раз. Где второй экран, браузер говорит после
// разрешения «Управление окнами» (Chrome и Edge); без него окно открывается обычным, и его
// перетаскивают на второй экран. Во весь экран — кнопкой в самом окне или F11.
//
// 1.7.6: окно открывается СРАЗУ по нажатию (раньше — после вопроса Chrome о разрешении, и
// браузер уже не считал это нажатием), а потом переезжает на второй экран и растягивается на
// него целиком. Имя окна каждый раз новое: со старым именем Chrome открывал страницу в уже
// существующей вкладке. Сколько экранов видит браузер — screen.isExtended (без разрешения)
const URL = '/pokupatel/index.html'
let okno = null // открытое отсюда окно покупателя

async function razreshenoOkna() {
  try {
    const st = await navigator.permissions.query({ name: 'window-management' })
    return st.state
  } catch {
    return 'unknown'
  }
}
async function vtoroyEkran() {
  try {
    if (typeof window.getScreenDetails !== 'function') return null
    const d = await window.getScreenDetails()
    const drugie = (d.screens || []).filter((s) => s !== d.currentScreen)
    return drugie.find((s) => !s.isPrimary) || drugie[0] || null
  } catch {
    return null // не разрешили или браузер не умеет
  }
}
const naEkran = (w, s) => {
  try {
    w.moveTo(s.left, s.top)
    w.resizeTo(s.width, s.height)
  } catch {
    /* окно закрыли */
  }
}

export default function PokupatelPanel() {
  const t = useT()
  const lang = useLang()
  const toast = useToast()
  const shop = useAuth()?.pharmacy?.name || ''
  const [open, setOpen] = useState(pokupatelOtkryt)
  const [busy, setBusy] = useState(false)
  // Видит ли браузер второй экран (у Windows режим «Расширить эти экраны»)
  const [dvaEkrana, setDvaEkrana] = useState(() => (typeof window.screen?.isExtended === 'boolean' ? window.screen.isExtended : null))
  useEffect(() => {
    const upd = () => setDvaEkrana(typeof window.screen?.isExtended === 'boolean' ? window.screen.isExtended : null)
    window.screen?.addEventListener?.('change', upd)
    return () => window.screen?.removeEventListener?.('change', upd)
  }, [])

  useEffect(() => {
    const tick = () => setOpen(pokupatelOtkryt())
    const off = onPokupatel(tick)
    const id = setInterval(tick, 2500)
    return () => {
      off()
      clearInterval(id)
    }
  }, [])

  async function otkryt() {
    if (busy) return
    setBusy(true)
    try {
      // Касса ещё ничего не показывала — окно откроется с приветствием и названием магазина
      if (!customerNow()) showCustomer({ mode: 'idle', lang, shop, labels: customerLabels(t) })
      try {
        if (okno && !okno.closed) okno.close()
      } catch {
        /* уже закрыто */
      }
      const name = 'finmax-pk-' + Date.now()
      // Разрешение уже есть — экран известен сразу, и окно открывается прямо на нём (во весь
      // экран, если браузер это умеет). Нет — окно открывается сейчас же, пока нажатие ещё
      // «свежее», и переезжает, когда разрешат
      const st = await razreshenoOkna()
      let s = st === 'granted' ? await vtoroyEkran() : null
      const w = s
        ? window.open(URL, name, `popup,fullscreen,left=${s.left},top=${s.top},width=${s.width},height=${s.height}`)
        : window.open(URL, name, 'popup,width=900,height=560,left=40,top=40')
      if (!w) {
        toast(t('Браузер не дал открыть окно. Нажмите ещё раз или разрешите всплывающие окна для этого сайта.'), 'err')
        return
      }
      okno = w
      if (!s) s = await vtoroyEkran()
      if (s) {
        naEkran(w, s)
        // Окно ещё грузится — ещё раз, когда загрузится
        setTimeout(() => naEkran(w, s), 700)
      }
      toast(s ? t('Окно покупателя открыто на втором экране.') : t('Второй экран не найден: окно открыто здесь. Перетащите его на второй экран.'), s ? undefined : 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="pokupatel-panel">
      <h2>
        <span className="h2-title"><span className="ic"><LuMonitor size={17} /></span>{t('Экран покупателя (второй экран)')}</span>
      </h2>
      <p className="tag-cat" style={{ lineHeight: 1.6, marginBottom: 12 }}>
        {t('Для двустороннего моноблока: на втором экране покупатель видит товары, итог, «Спасибо за покупку» и сдачу. После запуска браузера окно открывают один раз этой кнопкой. Chrome спросит «Управление окнами» — нажмите «Разрешить».')}
      </p>
      {dvaEkrana === false && (
        <div className="note err" style={{ marginBottom: 12 }} data-testid="pokupatel-one-screen">
          {t('Браузер видит только один экран. В Windows откройте «Параметры → Система → Дисплей» и выберите «Расширить эти экраны» — тогда задний экран станет отдельным.')}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={otkryt} disabled={busy} data-testid="pokupatel-open">
          <span className="ic"><LuMonitor size={16} /></span> {open ? t('Открыть заново') : t('Открыть экран покупателя')}
        </button>
        <span className={'badge ' + (open ? 'ok' : 'low')} data-testid="pokupatel-state">
          {open ? t('открыт') : t('не открыт')}
        </span>
      </div>
    </div>
  )
}
