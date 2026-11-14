import { useState } from 'react'
import { LuReceiptText } from 'react-icons/lu'
import { useToast } from './ui'
import { useAuth } from '../db/auth'
import { getRekvizity, saveRekvizity } from '../lib/rekvizity'
import { useT } from '../lib/i18n'
import { pechatPoGotovo, setPechatPoGotovo } from '../lib/pechatGotovo'

// ── Данные чека ──
// Что печатается на чеке под названием магазина: адрес, телефон и подпись внизу.
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
  // «Печатать чек при нажатии „Готово“» — запоминается сразу, без «Сохранить»
  const [gotovo, setGotovo] = useState(pechatPoGotovo)
  function toggleGotovo(on) {
    const v = setPechatPoGotovo(on)
    setGotovo(v)
    toast(v === on ? (on ? t('Чек будет печататься при нажатии «Готово»') : t('Печать по «Готово» выключена')) : t('Не удалось сохранить на этом устройстве'), v === on ? undefined : 'err')
  }

  function save() {
    setR(saveRekvizity(code, r))
    toast(t('Сохранено'))
  }

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-tour="set.chek">
      <h2><span className="h2-title"><span className="ic"><LuReceiptText size={17} /></span>{t('Данные чека')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Эти строки печатаются на каждом чеке этой кассы под названием магазина. Название добавляется само.')}
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
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14.5, fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={gotovo} onChange={(e) => toggleGotovo(e.target.checked)} style={{ width: 18, height: 18 }} data-testid="chek-gotovo-print" />
          {t('Печатать чек при нажатии «Готово»')}
        </label>
        <div className="tag-cat" style={{ marginTop: 6, lineHeight: 1.6 }}>
          {t('Кассир проводит продажу и жмёт «Готово» — окно чека закрывается, а чек сам уходит на печать, без кнопки «Печать». Настройка этого компьютера.')}
        </div>
      </div>
    </div>
  )
}
