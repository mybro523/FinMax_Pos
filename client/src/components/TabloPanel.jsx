import { useEffect, useState } from 'react'
import { LuMonitorDot, LuRefreshCw } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { useT } from '../lib/i18n'
import { TABLO_SKOROSTI, tabloSkorost, tabloVid } from '../lib/tablo'
import { tabloProba, tabloSohranit, tabloVybratPort, tabloWebMozhno, tabloZagruzit } from '../lib/tabloPort'
import { useToast } from './ui'

// ── Табло покупателя на COM-порту (1.7.6) ──
// Маленькое табло сзади моноблока: цифровое на 8 цифр (сумма и лампочки) или двухстрочное
// 2×20. Во время продажи — «Итого», после оплаты — сдача. Настройка относится к этому
// компьютеру (сайт — к этому браузеру). В программе порт выбирают из списка COM-портов
// Windows, на сайте — окном браузера «Выбрать порт» (Chrome и Edge)
const VIDY = [
  ['off', 'Выключено'],
  ['led8', 'Цифровое (8 цифр)'],
  ['vfd', 'Двухстрочное (2×20)'],
]

export default function TabloPanel() {
  const t = useT()
  const toast = useToast()
  const desk = !!bridge?.tablo
  const [cfg, setCfg] = useState(null)
  const [ports, setPorts] = useState([])
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    tabloZagruzit().then((c) => alive && setCfg(c))
    return () => {
      alive = false
    }
  }, [])
  const loadPorts = async () => {
    if (!desk) return
    setBusy('ports')
    try {
      setPorts((await bridge.tablo.ports()) || [])
    } finally {
      setBusy('')
    }
  }
  useEffect(() => {
    loadPorts()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return null
  const set = (patch) => {
    const next = { ...cfg, ...patch }
    if (patch.vid) next.baud = tabloSkorost(undefined, patch.vid)
    setCfg(next)
  }
  async function save(quiet = false) {
    setBusy('save')
    try {
      const saved = await tabloSohranit(cfg)
      if (saved) setCfg(saved)
      if (!quiet) toast(t('Сохранено'))
      return true
    } catch (e) {
      toast(e.message, 'err')
      return false
    } finally {
      setBusy('')
    }
  }
  async function vybrat() {
    try {
      const usb = await tabloVybratPort()
      const next = { ...cfg, usb }
      setCfg(next)
      await tabloSohranit(next)
      toast(t('Порт выбран'))
    } catch (e) {
      if (e?.name !== 'NotFoundError') toast(e.message, 'err')
    }
  }
  async function proba() {
    if (!(await save(true))) return
    setBusy('test')
    try {
      await tabloProba(cfg)
      toast(t('На табло отправлено 1234.56'))
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setBusy('')
    }
  }

  const vid = tabloVid(cfg.vid)
  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="tablo-panel">
      <h2>
        <span className="h2-title"><span className="ic"><LuMonitorDot size={17} /></span>{t('Табло покупателя (маленький экран)')}</span>
      </h2>
      <p className="tag-cat" style={{ lineHeight: 1.6, marginBottom: 12 }}>
        {t('Маленькое табло сзади моноблока на COM-порту: во время продажи — итог, после оплаты — сдача.')}
      </p>
      {!desk && !tabloWebMozhno() && <div className="note err" style={{ marginBottom: 12 }}>{t('Этот браузер не работает с COM-портами. Откройте сайт в Chrome или Edge.')}</div>}
      <div className="field">
        <label>{t('Вид табло')}</label>
        <div className="chips">
          {VIDY.map(([k, label]) => (
            <button key={k} type="button" className={'chip' + (vid === k ? ' active' : '')} onClick={() => set({ vid: k })} data-vid={k}>
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {vid !== 'off' && (
        <>
          <div className="row">
            <div className="field">
              <label htmlFor="tablo-port">{t('Порт')}</label>
              {desk ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select id="tablo-port" value={cfg.port || ''} onChange={(e) => set({ port: e.target.value })} data-testid="tablo-port">
                    <option value="">{t('— выберите —')}</option>
                    {[...new Set([...(cfg.port ? [cfg.port] : []), ...ports])].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <button type="button" className="btn ghost icon" onClick={loadPorts} disabled={busy === 'ports'} title={t('Обновить список')} aria-label={t('Обновить список')}>
                    <LuRefreshCw size={15} />
                  </button>
                </div>
              ) : (
                <button type="button" className="btn ghost" onClick={vybrat} data-testid="tablo-pick">
                  {t('Выбрать порт')}
                </button>
              )}
            </div>
            <div className="field">
              <label htmlFor="tablo-baud">{t('Скорость')}</label>
              <select id="tablo-baud" value={cfg.baud} onChange={(e) => set({ baud: Number(e.target.value) })} data-testid="tablo-baud">
                {TABLO_SKOROSTI.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {t('Обычно цифровое табло — 2400, двухстрочное — 9600. Не показывает — попробуйте другую скорость.')}
          </div>
        </>
      )}
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn" onClick={() => save()} disabled={!!busy} data-testid="tablo-save">{t('Сохранить')}</button>
        {vid !== 'off' && (
          <button type="button" className="btn ghost" onClick={proba} disabled={!!busy} data-testid="tablo-test">{busy === 'test' ? t('Отправляем…') : t('Проверить')}</button>
        )}
      </div>
    </div>
  )
}
