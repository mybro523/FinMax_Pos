import { useState } from 'react'
import { LuReceiptText } from 'react-icons/lu'
import { useToast } from './ui'
import { useAuth } from '../db/auth'
import { getRekvizity, saveRekvizity } from '../lib/rekvizity'
import { useT } from '../lib/i18n'

// ── Данные чека ──
// Что печатается на чеке под названием аптеки: адрес, телефон и подпись внизу.
// Название приходит с сервера само, а эти строки владелец вписывает один раз.
// Хранятся они на этом устройстве: чек печатает касса, и у каждой кассы они свои
// (обычно касса одна-две, и строки совпадают).
export default function ChekPanel() {
  const t = useT()
  const toast = useToast()
  const auth = useAuth()
  const code = auth?.pharmacy?.code
  const [r, setR] = useState(() => getRekvizity(code))
  const set = (patch) => setR({ ...r, ...patch })

  function save() {
    setR(saveRekvizity(code, r))
    toast(t('Сохранено'))
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-tour="set.chek">
      <h2><span className="h2-title"><span className="ic"><LuReceiptText size={17} /></span>{t('Данные чека')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Эти строки печатаются на каждом чеке этой кассы под названием аптеки. Название добавляется само.')}
      </p>
      <div className="field">
        <label htmlFor="chk-address">{t('Адрес на чеке')}</label>
        <input id="chk-address" value={r.address} onChange={(e) => set({ address: e.target.value })} placeholder={t('г. Душанбе, ул. Рудаки, 10')} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="chk-phone">{t('Телефон на чеке')}</label>
        <input id="chk-phone" value={r.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+992 900 00 00 00" autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="chk-footer">{t('Подпись внизу чека')}</label>
        <input id="chk-footer" value={r.footer} onChange={(e) => set({ footer: e.target.value })} placeholder={t('Будьте здоровы!')} autoComplete="off" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={save}>{t('Сохранить')}</button>
      </div>
    </div>
  )
}
