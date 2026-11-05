// ── Логотип магазина: выбрать картинку, заменить, убрать ──
// Картинка готовится здесь же (lib/logoImage.js): поля обрезаются, размер — до 720×360, PNG или
// JPEG. Поле общее: панель владельца сервиса (магазин с сервером) и «Настройки» → «Чек и печать»
// в программе без интернета (1.7.0)
import { useRef, useState } from 'react'
import { LuImagePlus, LuX } from 'react-icons/lu'
import { prepareLogo, LOGO_TYPES } from '../lib/logoImage'

export default function LogoField({ value, onChange, onBusy, loading = false, toast, t }) {
  const input = useRef(null)
  const [working, setWorking] = useState(false)
  // Пока картинка готовится, окно не сохраняет (onBusy): иначе «Сохранено» ушло бы без неё
  const busy = (on) => {
    setWorking(on)
    onBusy?.(on)
  }
  async function pick(e) {
    const file = e.target.files?.[0]
    // Тот же файл можно выбрать ещё раз
    e.target.value = ''
    if (!file) return
    busy(true)
    try {
      const r = await prepareLogo(file)
      onChange(r.dataUrl)
    } catch (err) {
      toast(t(err?.message || 'Картинку не удалось открыть — возможно, файл повреждён'), 'err')
    } finally {
      busy(false)
    }
  }
  return (
    <div className="field logo-field" data-testid="logo-field">
      <label>{t('Логотип')}</label>
      <div className="logo-box">
        <div className={'logo-preview' + (value ? '' : ' empty')}>
          {value ? <img src={value} alt={t('Логотип')} data-testid="logo-preview" /> : <span>{loading || working ? t('Загрузка…') : t('Нет логотипа')}</span>}
        </div>
        <div className="logo-actions">
          <button type="button" className="btn ghost" onClick={() => input.current?.click()} disabled={working || loading} data-testid="logo-pick">
            <span className="ic"><LuImagePlus size={16} /></span> {value ? t('Заменить') : t('Выбрать картинку')}
          </button>
          {value && (
            <button type="button" className="btn ghost" onClick={() => onChange('')} disabled={working} data-testid="logo-remove">
              <span className="ic"><LuX size={16} /></span> {t('Убрать')}
            </button>
          )}
        </div>
      </div>
      <div className="tag-cat">
        {t('PNG, JPG или WebP до 2 МБ. Логотип печатается на чеках и листах магазина и виден на экране покупателя. Без логотипа — всё как сейчас.')}
      </div>
      <input ref={input} type="file" accept={LOGO_TYPES.join(',')} hidden onChange={pick} data-testid="logo-input" />
    </div>
  )
}
