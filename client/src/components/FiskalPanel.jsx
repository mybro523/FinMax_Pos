import { useEffect, useState } from 'react'
import { LuReceiptText } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { useT } from '../lib/i18n'
import { useToast } from './ui'

// ── Фискальный принтер Fiscat (программа для Windows) ──
// Устройство стоит в сети магазина и печатает юридический чек в налоговую (ОФД). Когда
// фискализация включена, продажа и смена проводятся через него: нет чека — нет продажи.
// Настройка относится к этому компьютеру: у каждой кассы своё устройство.
//
// СНО и ставка НДС — одни на весь магазин (решение владельца). Разные ставки на разные
// товары — отдельная задача на будущее.
const TAX_TYPES = [
  ['GENERAL', 'Общий режим'],
  ['SIMPLIFIED1', 'Упрощёнка 6%'],
  ['SIMPLIFIED2', 'Упрощёнка 13%'],
  ['SIMPLIFIED3', 'Упрощёнка 18%'],
  ['SPECIAL', 'Специальный режим'],
  ['SIMPLIFIED4', 'Упрощёнка (−50%) 3%'],
  ['SIMPLIFIED5', 'Упрощёнка (−50%) 6,5%'],
  ['SIMPLIFIED6', 'Упрощёнка (−50%) 9%'],
]
const VAT_CODES = [
  ['STANDARD', 'НДС 14% (стандартная ставка)'],
  ['REDUCED1', 'НДС 7% (стройка, гостиницы, общепит)'],
  ['REDUCED2', 'НДС 5% (сельхозпродукция, обучение, медицина)'],
  ['REDUCED3', 'НДС 2,5% (птицеводство)'],
  ['REDUCED4', 'НДС 10% (переработка пшеницы)'],
  ['ZERO_TAX', 'Без НДС (освобождение)'],
  ['ZERO_TAX_EXPORT', 'НДС 0% (экспорт)'],
]
const COMMODITIES = [
  ['GOODS', 'Товар'],
  ['SERVICE', 'Услуга'],
  ['JOB', 'Работа'],
  ['ADVANCE', 'Аванс'],
]

export default function FiskalPanel() {
  const t = useT()
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    bridge.fiskal.config().then((c) => alive && setCfg(c), () => {})
    return () => {
      alive = false
    }
  }, [])

  if (!cfg) return null
  const set = (patch) => setCfg({ ...cfg, ...patch })
  // Адрес не из сети магазина программа не запоминает — говорим словами, введённое оставляем
  const hostRefused = (saved) => saved?.refused === 'host'
  const badHost = () => toast(t('Адрес устройства должен быть из сети магазина — четыре числа через точку, например 192.168.1.50.'), 'err')

  async function saveCfg() {
    const saved = await bridge.fiskal.setConfig(cfg)
    if (!saved) throw new Error()
    if (hostRefused(saved)) {
      badHost()
      return null
    }
    setCfg(saved)
    return saved
  }

  async function save() {
    setBusy('save')
    try {
      if (await saveCfg()) toast(t('Сохранено'))
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setBusy('test')
    try {
      if (!(await saveCfg())) return
      const r = await bridge.fiskal.test()
      if (r?.ok) toast(t('Фискальный принтер на связи'))
      else toast(t(r?.message || 'Фискальный принтер не отвечает. Проверьте, что он включён и в той же сети.'), 'err')
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="fiskal-panel">
      <h2><span className="h2-title"><span className="ic"><LuReceiptText size={17} /></span>{t('Фискальный принтер')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Устройство в сети магазина печатает чек в налоговую. Когда фискализация включена, продажа и смена идут через него — нет чека от устройства, нет продажи. Настройка этого компьютера.')}
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 12 }}>
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} style={{ width: 16, height: 16 }} data-testid="fiskal-enabled" />
        {t('Включить фискализацию на этой кассе')}
      </label>

      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label>{t('Адрес устройства в сети')}</label>
          <input value={cfg.host} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.50" data-testid="fiskal-host" />
          <div className="tag-cat">{t('Адрес устройства и порт (обычно 8002) берут у того, кто устанавливал фискальный принтер.')}</div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>{t('Порт')}</label>
          <input type="number" min="1" max="65535" value={cfg.port} onChange={(e) => set({ port: e.target.value })} data-testid="fiskal-port" />
        </div>
      </div>

      <div className="field">
        <label>{t('Режим налогообложения (СНО)')}</label>
        <select value={cfg.taxType} onChange={(e) => set({ taxType: e.target.value })} data-testid="fiskal-taxType">
          {TAX_TYPES.map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}
        </select>
      </div>

      <div className="field">
        <label>{t('Ставка НДС')}</label>
        <select value={cfg.vatCode} onChange={(e) => set({ vatCode: e.target.value })} data-testid="fiskal-vatCode">
          {VAT_CODES.map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}
        </select>
        <div className="tag-cat">{t('Цены в магазине с НДС внутри — налог устройство посчитает из суммы чека.')}</div>
      </div>

      <div className="field">
        <label>{t('Предмет расчёта')}</label>
        <select value={cfg.commodity} onChange={(e) => set({ commodity: e.target.value })} data-testid="fiskal-commodity">
          {COMMODITIES.map(([v, label]) => <option key={v} value={v}>{t(label)}</option>)}
        </select>
      </div>

      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" disabled={!!busy} onClick={save}>{busy === 'save' ? t('Сохранение…') : t('Сохранить')}</button>
        <button className="btn ghost" disabled={!!busy} onClick={test}>{busy === 'test' ? t('Проверяем…') : t('Проверить связь')}</button>
      </div>
    </div>
  )
}
