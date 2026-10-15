import { useEffect, useState } from 'react'
import { LuPrinter } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { forgetPrintConfig } from '../lib/print'
import { useT } from '../lib/i18n'
import { useToast } from './ui'

// ── Печать чеков (программа для Windows) ──
// По умолчанию чек печатается как на сайте — через окно печати Windows. Если в
// магазине стоит чековый принтер, владелец выбирает его здесь: тогда чек уходит в
// принтер сразу, без окна печати, и может печататься сам после каждой продажи.
//
// Настройка относится к этому компьютеру, а не к магазину: у каждой кассы свой принтер.
export default function PrintPanel() {
  const t = useT()
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    bridge.print.config().then((c) => alive && setCfg(c), () => {})
    return () => {
      alive = false
    }
  }, [])

  if (!cfg) return null
  const set = (patch) => setCfg({ ...cfg, ...patch })
  const escpos = cfg.mode !== 'system'
  // Программа принимает только адрес из сети магазина. Чужой адрес она не запоминает
  // (прежняя настройка остаётся как была) — говорим об этом словами и оставляем
  // введённое на экране, чтобы его поправили
  const hostRefused = (saved) => saved?.refused === 'host'
  const badHost = () => toast(t('Адрес принтера должен быть из сети магазина — четыре числа через точку, например 192.168.1.50.'), 'err')

  async function save() {
    setBusy('save')
    try {
      const saved = await bridge.print.setConfig(cfg)
      if (!saved) throw new Error()
      if (hostRefused(saved)) return badHost()
      setCfg({ ...saved, printers: cfg.printers })
      forgetPrintConfig()
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
      // Пробуем с тем, что сейчас на экране: сначала сохранить, потом печатать
      const saved = await bridge.print.setConfig(cfg)
      if (hostRefused(saved)) return badHost()
      if (saved) setCfg({ ...saved, printers: cfg.printers })
      forgetPrintConfig()
      const r = await bridge.print.test()
      if (r?.ok) toast(t('Пробный чек отправлен на принтер'))
      else toast(t(r?.error || 'Не удалось отправить задание на принтер.'), 'err')
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="print-panel">
      <h2><span className="h2-title"><span className="ic"><LuPrinter size={17} /></span>{t('Печать чеков')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Настройка этого компьютера. Обычный принтер печатает через окно печати Windows; чековый — сразу, без окна.')}
      </p>

      <div className="field">
        <label>{t('Как печатать')}</label>
        <select value={cfg.mode} onChange={(e) => set({ mode: e.target.value })} data-testid="print-mode">
          <option value="system">{t('Обычный принтер (окно печати Windows)')}</option>
          <option value="network">{t('Чековый принтер по сети')}</option>
          <option value="windows">{t('Чековый принтер, подключённый к этому компьютеру')}</option>
        </select>
      </div>

      {cfg.mode === 'network' && (
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label>{t('Адрес принтера в сети')}</label>
            <input value={cfg.host} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.50" data-testid="print-host" />
            <div className="tag-cat">{t('Адрес написан на пробной распечатке самого принтера и обычно начинается на 192.168.')}</div>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{t('Порт')}</label>
            <input type="number" min="1" max="65535" value={cfg.port} onChange={(e) => set({ port: e.target.value })} data-testid="print-port" />
          </div>
        </div>
      )}

      {cfg.mode === 'windows' && (
        <div className="field">
          <label>{t('Принтер')}</label>
          <select value={cfg.name} onChange={(e) => set({ name: e.target.value })} data-testid="print-name">
            <option value="">{t('— выберите принтер —')}</option>
            {(cfg.printers || []).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="tag-cat">{t('Принтер должен быть установлен в Windows. В списке — все принтеры этого компьютера.')}</div>
        </div>
      )}

      {escpos && (
        <>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t('Ширина ленты')}</label>
              <select value={cfg.width} onChange={(e) => set({ width: Number(e.target.value) })} data-testid="print-width">
                <option value={32}>{t('58 мм (32 знака)')}</option>
                <option value={42}>{t('80 мм (42 знака)')}</option>
                <option value={48}>{t('80 мм (48 знаков)')}</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('Таблица букв принтера')}</label>
              <select value={cfg.codepage} onChange={(e) => set({ codepage: e.target.value })}>
                <option value="cp866">CP866</option>
                <option value="cp1251">CP1251</option>
              </select>
            </div>
          </div>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {t('Если на пробном чеке вместо русских букв непонятные знаки — выберите другую таблицу. Таджикские буквы чековые принтеры не печатают: вместо «қ» будет «к».')}
          </div>
          {[
            ['auto', t('Печатать чек сразу после продажи')],
            ['logo', t('Эмблема FinMax в начале чека')],
            ['cut', t('Отрезать чек')],
            ['drawer', t('Открывать денежный ящик')],
          ].map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginBottom: 8 }}>
              <input type="checkbox" checked={!!cfg[key]} onChange={(e) => set({ [key]: e.target.checked })} style={{ width: 16, height: 16 }} data-testid={'print-' + key} />
              {label}
            </label>
          ))}
        </>
      )}

      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" disabled={!!busy} onClick={save}>{busy === 'save' ? t('Сохранение…') : t('Сохранить')}</button>
        {escpos && (
          <button className="btn ghost" disabled={!!busy} onClick={test}>{busy === 'test' ? t('Печатаем…') : t('Пробная печать')}</button>
        )}
      </div>
    </div>
  )
}
