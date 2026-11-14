import { MODULES, cleanModulesOff } from '../lib/moduli'
import './ModuliVybor.css'

// ── Модули магазина (1.8.1): галочки в панели владельца сервиса ──
// value — список ВЫКЛЮЧЕННЫХ (modulesOff); галочка стоит — модуль у клиента есть.
// Обязательные разделы не выключаются — они перечислены под галочками, чтобы было видно,
// что они есть всегда. Тот же выбор — при заведении магазина, в «Изменить магазин» и при
// выпуске кода активации (там модули зашиваются в код).
export const REQUIRED_SECTIONS = 'Касса, Смена кассы, Товары, Приход товара, Поставщики, Сотрудники, Роли и права, Настройки'

export default function ModuliVybor({ value, onChange, t, testid = 'moduli' }) {
  const off = new Set(cleanModulesOff(value))
  const toggle = (key, on) => {
    const next = new Set(off)
    if (on) next.delete(key)
    else next.add(key)
    onChange(cleanModulesOff([...next]))
  }
  return (
    <div className="field moduli-vybor" data-testid={testid}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>{t('Модули')}</span>
        <button type="button" className="btn ghost sm" onClick={() => onChange([])} disabled={!off.size} data-testid={testid + '-all'}>
          {t('Включить все')}
        </button>
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
