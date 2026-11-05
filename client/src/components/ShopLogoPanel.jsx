// ── Логотип магазина в программе без интернета (1.7.0) ──
// Сервера нет — логотип ставят здесь, в «Настройки» → «Чек и печать». Он печатается на чеках, ленте
// и листах и виден на экране покупателя — как прежде логотип из панели владельца сервиса.
// Сохраняется сразу, как только картинка готова
import { useState } from 'react'
import { LuImage } from 'react-icons/lu'
import LogoField from './LogoField'
import { useToast } from './ui'
import { api } from '../db/api'
import { useShopLogo } from '../lib/logo'
import { useT } from '../lib/i18n'

export default function ShopLogoPanel() {
  const t = useT()
  const toast = useToast()
  const logo = useShopLogo()
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  async function save(value) {
    setSaving(true)
    try {
      await api.post('/shop/logo', { logo: value })
      toast(value ? t('Логотип сохранён') : t('Логотип убран'))
    } catch (e) {
      toast(t(e?.message || 'Не получилось. Повторите.'), 'err')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="shop-logo-panel">
      <h2><span className="h2-title"><span className="ic"><LuImage size={17} /></span>{t('Логотип магазина')}</span></h2>
      <LogoField value={logo} onChange={save} onBusy={setBusy} loading={saving || busy} toast={toast} t={t} />
    </div>
  )
}
