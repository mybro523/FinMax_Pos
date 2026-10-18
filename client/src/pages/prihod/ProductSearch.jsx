import { useEffect, useMemo, useState } from 'react'
import { stockText } from '../../db/store'
import { findByBarcode } from '../../db/ops'
import { useT } from '../../lib/i18n'
import { normalizeScan } from '../../lib/scan'
import { beepError } from '../../lib/sound'

// ── Поле «Товар — штрихкод или название» ──
// Одно и то же в новом поступлении и в возврате поставщику. Сканер стреляет сюда:
// штрихкод (и DataMatrix маркировки) находит товар сразу. Набрали название — ниже
// подсказки, стрелки выбирают, Enter берёт выбранную. Незнакомый штрихкод — onUnknown.
//
// chosenName — название уже выбранного товара: пока в поле оно, подсказки не нужны,
// а Enter значит «дальше, к количеству» (onEnterChosen)
export default function ProductSearch({ id, products, q, setQ, chosenName, onPick, onUnknown, onEnterChosen, inputRef, readOnly = false, autoFocus = true }) {
  const t = useT()
  const [active, setActive] = useState(0)
  const suggest = useMemo(() => {
    const needle = String(q || '').trim().toLowerCase()
    if (!needle || readOnly || (chosenName && q === chosenName)) return []
    return products.filter((p) => p.name.toLowerCase().includes(needle) || String(p.barcode || '').includes(needle)).slice(0, 8)
  }, [q, products, chosenName, readOnly])
  useEffect(() => setActive(0), [q])

  function resolve(raw) {
    const val = String(raw || '').trim()
    if (!val) return
    const p = findByBarcode(val)
    if (p) return onPick(p)
    // Набрали название, а не код — берём выбранную подсказку
    if (suggest.length && val.replace(/\D/g, '').length < 6) return onPick(suggest[Math.min(active, suggest.length - 1)])
    beepError()
    onUnknown?.(normalizeScan(val))
  }

  return (
    <div className="prh-search">
      <input
        id={id}
        ref={inputRef}
        className="scan-input"
        value={q}
        autoFocus={autoFocus}
        autoComplete="off"
        readOnly={readOnly}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && suggest.length) {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, suggest.length - 1))
          } else if (e.key === 'ArrowUp' && suggest.length) {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (chosenName && q === chosenName) onEnterChosen?.()
            else resolve(q)
          }
        }}
        placeholder={t('Наведите сканер на товар…')}
      />
      {suggest.length > 0 && (
        <ul className="prh-suggest" role="listbox">
          {suggest.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); onPick(p) }}>
              <span className="prh-suggest-name">{p.name}</span>
              <span className="tag-cat">{p.barcode} · {t('остаток')} {stockText(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
