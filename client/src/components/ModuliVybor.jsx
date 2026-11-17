import { useState } from 'react'
import { MODULES, cleanModulesOff } from '../lib/moduli'
import './ModuliVybor.css'

// ── Модули магазина (1.8.1): галочки в панели владельца сервиса ──
// value — список ВЫКЛЮЧЕННЫХ (modulesOff); галочка стоит — модуль у клиента есть.
// Обязательные разделы не выключаются — они перечислены под галочками, чтобы было видно,
// что они есть всегда. Тот же выбор — при заведении магазина, в «Изменить магазин» и при
// выпуске кода активации (там модули зашиваются в код).
export const REQUIRED_SECTIONS = 'Касса, Смена кассы, Товары, Приход товара, Поставщики, Сотрудники, Роли и права, Настройки'

// compact — телефон: четырнадцать галочек в столбик занимали три четверти экрана, и форма
// («Новый магазин», коды активации) растягивалась на три экрана, хотя модули меняют редко.
// Там выбор свёрнут в строку «все включены · Изменить» и раскрывается по нажатию
export default function ModuliVybor({ value, onChange, t, testid = 'moduli', compact = false }) {
  const [open, setOpen] = useState(false)
  const off = new Set(cleanModulesOff(value))
  const toggle = (key, on) => {
    const next = new Set(off)
    if (on) next.delete(key)
    else next.add(key)
    onChange(cleanModulesOff([...next]))
  }
  if (compact && !open) {
    return (
      <div className="field moduli-vybor" data-testid={testid}>
        <label>{t('Модули')}</label>
        <button type="button" className="moduli-svod" onClick={() => setOpen(true)} aria-expanded="false" data-testid={testid + '-open'}>
          <span className="moduli-svod-text">{moduliText(value, t)}</span>
          <span className="moduli-svod-act">{t('Изменить')}</span>
        </button>
      </div>
    )
  }
  return (
    <div className="field moduli-vybor" data-testid={testid}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>{t('Модули')}</span>
        <button type="button" className="btn ghost sm" onClick={() => onChange([])} disabled={!off.size} data-testid={testid + '-all'}>
          {t('Включить все')}
        </button>
        {compact && (
          <button type="button" className="btn ghost sm" onClick={() => setOpen(false)} aria-expanded="true" data-testid={testid + '-close'}>
            {t('Свернуть')}
          </button>
        )}
      </label>
      <div className="moduli-grid">
        {MODULES.map((m) => (
          <label key={m.key} className="moduli-item" data-off={off.has(m.key) ? '1' : undefined}>
            <input type="checkbox" checked={!off.has(m.key)} onChange={(e) => toggle(m.key, e.target.checked)} data-modul={m.key} />
            <span>{t(m.label)}</span>
          </label>
        ))}
      </div>
      <div className="tag-cat" style={{ marginTop: 6 }}>
        {t('Есть всегда')}: {t(REQUIRED_SECTIONS)}
      </div>
    </div>
  )
}

// Коротко для карточки и списка кодов: «все» или «без: Срок годности, Склад»
export function moduliText(list, t) {
  const off = cleanModulesOff(list)
  if (!off.length) return t('все включены')
  return `${t('выключены')}: ${off.map((k) => t(MODULES.find((m) => m.key === k).label)).join(', ')}`
}
