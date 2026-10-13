import { useState } from 'react'
import NumberInput from './NumberInput'
import { gramsOfKg } from '../lib/units'

// ── Ввод веса в килограммах ──
// Снаружи — граммы целым числом (так вес хранится и считается), внутри поля —
// привычные человеку килограммы: «12.35». Пока поле в фокусе, живёт черновик
// набора (иначе «0.» невозможно было бы напечатать), убрали курсор — показывается
// ровно то, что записано в строке.
export default function VesInput({ grams, onGrams, ...rest }) {
  const [draft, setDraft] = useState(null)
  const shown = draft !== null ? draft : grams ? String(grams / 1000) : ''
  return (
    <NumberInput
      {...rest}
      value={shown}
      onFocus={() => setDraft(grams ? String(grams / 1000) : '')}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value)
        onGrams(gramsOfKg(e.target.value))
      }}
    />
  )
}
