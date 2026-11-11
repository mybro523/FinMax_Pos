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
const NAME = 'finmax-pokupatel'
const URL = '/pokupatel/index.html'

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

export default function PokupatelPanel() {
  const t = useT()
  const lang = useLang()
  const toast = useToast()
  const shop = useAuth()?.pharmacy?.name || ''
  const [open, setOpen] = useState(pokupatelOtkryt)
  const [busy, setBusy] = useState(false)

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
      const s = await vtoroyEkran()
      const feat = s
        ? `popup,fullscreen,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
        : 'popup,width=1024,height=640'
      const w = window.open(URL, NAME, feat)
      if (!w) {
        toast(t('Браузер не дал открыть окно. Нажмите ещё раз или разрешите всплывающие окна для этого сайта.'), 'err')
        return
      }
      if (s) {
        try {
          w.moveTo(s.availLeft, s.availTop)
          w.resizeTo(s.availWidth, s.availHeight)
        } catch {
          /* окно уже на своём месте */
        }
      }
      toast(s ? t('Окно покупателя открыто на втором экране. Нажмите в нём «Во весь экран».') : t('Окно покупателя открыто. Перетащите его на второй экран и нажмите в нём «Во весь экран».'))
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
