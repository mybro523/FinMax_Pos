import { useState } from 'react'
import { LuScale } from 'react-icons/lu'
import { useToast } from './ui'
import { useT } from '../lib/i18n'
import { getVesy, saveVesy } from '../lib/vesy'

// ── Весы с печатью этикеток ──
// Весы наклеивают на пакет этикетку со штрихкодом, в котором зашиты код товара и
// вес. Здесь владелец говорит кассе, как эти коды выглядят: с каких двух цифр
// начинаются и сколько цифр занимает код товара. Настройка этого устройства,
// как и принтер: весы общие, а касс может быть несколько.
export default function VesyPanel() {
  const t = useT()
  const toast = useToast()
  const [v, setV] = useState(() => getVesy())
  const set = (patch) => setV({ ...v, ...patch })

  function save() {
    setV(saveVesy(v))
    toast(t('Сохранено'))
  }

  // Живой пример: как касса разберёт такой код при нынешних настройках
  const primer = `${v.prefix}${'01234'.slice(0, v.codeLen).padStart(v.codeLen, '0')}${'00350'}К`

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-tour="set.vesy">
      <h2><span className="h2-title"><span className="ic"><LuScale size={17} /></span>{t('Весы с этикетками')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Весы печатают этикетку со штрихкодом, в котором зашиты код товара и вес. Касса узнаёт такие коды и кладёт в чек точный вес сама.')}
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginBottom: 12 }}>
        <input type="checkbox" checked={v.on} onChange={(e) => set({ on: e.target.checked })} style={{ width: 16, height: 16 }} data-testid="vesy-on" />
        {t('Принимать штрихкоды с весов')}
      </label>
      {v.on && (
        <>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t('Первые две цифры кода')}</label>
              <input
                value={v.prefix}
                onChange={(e) => set({ prefix: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                placeholder="22"
                data-testid="vesy-prefix"
              />
              <div className="tag-cat">{t('Их печатают сами весы; обычно 22, иногда 20–29.')}</div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('Цифр в коде товара')}</label>
              <select value={v.codeLen} onChange={(e) => set({ codeLen: Number(e.target.value) })} data-testid="vesy-codelen">
                <option value={4}>4</option>
                <option value={5}>5</option>
                <option value={6}>6</option>
              </select>
            </div>
          </div>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {t('Пример')}: {primer} — {v.prefix} + {t('код товара')} + {t('вес в граммах')} + {t('контрольная цифра')}.{' '}
            {t('Код товара вбивается в весы и он же — в поле «Штрихкод» весового товара.')}
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={save}>{t('Сохранить')}</button>
      </div>
    </div>
  )
}
