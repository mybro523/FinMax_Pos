import { forwardRef } from 'react'
import { sanitizeNumber } from '../lib/number'

// ── Ввод числа ──
// Поле, в которое физически не попадает ничего, кроме цифр (и одной точки, если
// число может быть дробным). Проверять на сохранении мало: человек уже заполнил
// форму и не понимает, что не так — а «−12» в остатке ломает учёт молча.

const NumberInput = forwardRef(function NumberInput({ value, onChange, integer = false, ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      // Именно text, а не number: у числового поля браузер отдаёт пустую строку
      // на «−», и отличить набранный минус от очищенного поля невозможно.
      // inputMode всё равно поднимает на телефоне цифровую клавиатуру.
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={value ?? ''}
      onChange={(e) => {
        const clean = sanitizeNumber(e.target.value, integer)
        // Возвращаем поле к допустимому виду сразу: если состояние не изменится,
        // React не перерисует поле и на экране остался бы набранный мусор
        if (e.target.value !== clean) e.target.value = clean
        onChange?.({ target: { value: clean } })
      }}
    />
  )
})

export default NumberInput
