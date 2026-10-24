import { useEffect, useState } from 'react'
import { LuMonitor } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { money } from '../db/store'
import { useAuth } from '../db/auth'
import { useT, useLang } from '../lib/i18n'
import { customerLabels } from '../lib/customerScreen'
import { useToast } from './ui'

// ── Экран покупателя (программа для Windows) ──
// Второй экран моноблока — сторона покупателя: товары в корзине и итог, после оплаты —
// «Спасибо за покупку!». Программа включает его сама, если у компьютера есть второй экран;
// здесь его можно выключить, выбрать экран и показать пробу.
//
// Настройка относится к этому компьютеру, а не к магазину: у каждой кассы свои экраны.
export default function CustomerScreenPanel() {
  const t = useT()
  const lang = useLang()
  const toast = useToast()
  const auth = useAuth()
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    const load = () => bridge.customer.config().then((c) => alive && setCfg(c), () => {})
    load()
    // Экраны подключают и отключают на ходу — список держим свежим
    const id = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (!cfg) return null
  const free = (cfg.displays || []).filter((d) => !d.main)
  const value = cfg.mode === 'pick' && free.some((d) => d.id === cfg.display) ? cfg.display : cfg.mode === 'off' ? 'off' : 'auto'
  const showing = (cfg.displays || []).find((d) => d.id === cfg.showing)
  const screenName = (d) => `${t('Экран')} ${d.n} — ${d.width}×${d.height}`

  async function choose(v) {
    setBusy('save')
    try {
      const next = v === 'auto' || v === 'off' ? { mode: v, display: '' } : { mode: 'pick', display: v }
      const saved = await bridge.customer.setConfig(next)
      if (!saved) throw new Error()
      setCfg(saved)
      toast(t('Сохранено'))
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setBusy('test')
    try {
      const r = await bridge.customer.test({
        lang,
        shop: auth?.pharmacy?.name || '',
        labels: customerLabels(t),
        items: [
          { name: t('Проверка экрана покупателя'), sub: `2 ${t('уп')} × ${money(15)}`, sum: money(30) },
          { name: t('Если этот текст виден покупателю — экран настроен верно'), sub: `1 ${t('шт')} × ${money(8)}`, sum: money(8) },
        ],
        total: money(38),
      })
      if (r?.ok) toast(t('Проба показана на экране покупателя'))
      else toast(t('Экран покупателя сейчас не показывается'), 'err')
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="customer-panel">
      <h2><span className="h2-title"><span className="ic"><LuMonitor size={17} /></span>{t('Экран покупателя')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Второй экран моноблока — сторона покупателя: товары в корзине и итог, после оплаты — «Спасибо за покупку!». В Windows режим экранов должен быть «Расширить» (клавиши Win + P).')}
      </p>

      <div className="field">
        <label htmlFor="cs-where">{t('Где показывать')}</label>
        <select id="cs-where" value={value} disabled={!!busy} onChange={(e) => choose(e.target.value)} data-testid="customer-where">
          <option value="auto">{t('Сам — на втором экране')}</option>
          <option value="off">{t('Выключен')}</option>
          {free.map((d) => (
            <option key={d.id} value={d.id}>{screenName(d)}</option>
          ))}
        </select>
      </div>

      <div className={showing ? 'note info' : 'tag-cat'} style={{ margin: '8px 0 12px' }} data-testid="customer-status">
        {showing
          ? `${t('Сейчас показывается')}: ${screenName(showing)}`
          : cfg.mode === 'off'
            ? t('Экран покупателя выключен.')
            : t('Второй экран не найден. Подключите его и выберите в Windows режим «Расширить» (клавиши Win + P).')}
      </div>

      <button type="button" className="btn ghost" disabled={!!busy || !showing} onClick={test} data-testid="customer-test">
        {busy === 'test' ? t('Показываем…') : t('Показать пробу')}
      </button>
    </div>
  )
}
