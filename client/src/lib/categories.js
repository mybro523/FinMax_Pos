// ── Категории товаров ──
// Раньше список был зашит здесь и менялся только через разработчика. Теперь им
// управляет владелец в Настройках: категории лежат в базе и прилетают на все
// устройства мгновенно. Этот файл — только доступ к ним, без своего списка,
// чтобы нигде не осталось второй, расходящейся копии.
import { useCollection } from '../db/store.js'

// Список категорий для форм и фильтров (уже отсортирован сервером по алфавиту)
export function useCategories() {
  return useCollection('categories')
}

export const categoryNames = (categories) => (categories || []).map((c) => c.name)

export const isKnownCategory = (name, categories) =>
  (categories || []).some((c) => c.name === String(name || '').trim())

// Срок годности при приёмке. У бинтов, ваты и приборов его нет — это отмечено
// галочкой у категории. Неизвестная категория считается товаром: лучше лишний
// раз спросить срок, чем пропустить просрочку на полку.
export function needsExpiry(category, categories) {
  const c = (categories || []).find((x) => x.name === String(category || '').trim())
  return !(c && c.noExpiry)
}

// Варианты для выпадающего списка. Если у товара стоит категория, которой больше
// нет в справочнике, показываем её первой и помечаем — чтобы значение не затёрлось
// молча при сохранении, но было видно, что его надо заменить.
export function categoryOptions(current, categories) {
  const names = categoryNames(categories)
  const c = String(current || '').trim()
  return c && !names.includes(c)
    ? [{ value: c, legacy: true }, ...names.map((v) => ({ value: v }))]
    : names.map((v) => ({ value: v }))
}
