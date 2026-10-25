import { useEffect, useState } from 'react'
import { LuGauge } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { applyLite } from '../lib/lite'
import { useT } from '../lib/i18n'
import { useToast } from './ui'

// ── Скорость работы (программа для Windows) ──
// Облегчённый вид: без теней, анимаций и плавных переходов — на старом компьютере (часто
// это Windows 7) тормозят именно они. Программа включает вид сама, если компьютер слабый;
// здесь его можно включить всегда или выключить. Настройка — этого компьютера.
const num = (x) => String(x).replace('.', ',')

export default function LitePanel() {
  const t = useT()
  const toast = useToast()
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    bridge?.lite?.get?.().then((s) => alive && s && setSt(s), () => {})
    // Вид поменялся сам, пока раздел открыт (программа узнала, что видеокарта не ускоряет
    // отрисовку) — подпись «Сейчас: …» не должна отставать
    let off = null
    try {
      off = bridge?.lite?.onChange?.((s) => alive && s && setSt(s))
    } catch {
      off = null
    }
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [])

  if (!st) return null

  async function choose(mode) {
    setBusy(true)
    try {
      const s = await bridge.lite.set(mode)
      if (!s) throw new Error()
      setSt(s)
      applyLite(s.active)
      toast(t('Сохранено'))
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy(false)
    }
  }

  // Почему компьютер слабый — словами
  const why = st.reasons
    .map((r) =>
      r === 'memory'
        ? `${t('мало памяти')}${st.memoryGb ? ` (${num(st.memoryGb)} ${t('ГБ')})` : ''}`
        : r === 'cpu'
          ? `${t('мало ядер процессора')} (${st.cpus})`
          : t('видеокарта не ускоряет отрисовку'),
    )
    .join(', ')

  let status
  if (st.active) status = st.mode === 'auto' ? `${t('Сейчас: облегчённый вид включён — компьютер слабый')}: ${why}.` : t('Сейчас: облегчённый вид включён.')
  else if (st.mode === 'auto') status = t('Сейчас: обычный вид — компьютер достаточно быстрый.')
  else status = why ? `${t('Сейчас: обычный вид. Компьютер слабый')} (${why}) — ${t('облегчённый вид ускорил бы работу.')}` : t('Сейчас: обычный вид.')

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="lite-panel">
      <h2><span className="h2-title"><span className="ic"><LuGauge size={17} /></span>{t('Скорость работы')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('На слабом компьютере программа сама включает облегчённый вид: без теней, анимаций и плавных переходов. Так окна открываются и кнопки откликаются быстрее, а внешне почти ничего не меняется.')}
      </p>
      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor="lite-mode">{t('Облегчённый вид')}</label>
        <select id="lite-mode" value={st.mode} disabled={busy} onChange={(e) => choose(e.target.value)} data-testid="lite-mode">
          <option value="auto">{t('Сам — на слабом компьютере')}</option>
          <option value="on">{t('Всегда включён')}</option>
          <option value="off">{t('Выключен')}</option>
        </select>
      </div>
      <div className="tag-cat" data-testid="lite-status">{status}</div>
    </div>
  )
}
