// ── Типы товаров ──
// Медицинский, продукты, бытовая химия… Список ведёт владелец в Настройках, рядом с
// категориями; у товара тип хранится названием. Отметка «с аналогами» решает,
// показывать ли в карточке товара поле аналогов: у лекарства замены ищут, у шампуня — нет.
import { useCollection } from '../db/store.js'

export function useProductTypes() {
  return useCollection('productTypes')
}

export const typeNames = (types) => (types || []).map((x) => x.name)

// Есть ли у типа аналоги. Неизвестный или пустой тип — нет
export function typeHasAnalogs(name, types) {
  const n = String(name || '').trim()
  if (!n) return false
  return !!(types || []).find((x) => x.name === n)?.analogs
}

// Варианты для выпадающего списка. Тип, которого уже нет в списке, показываем
// первым и помечаем — чтобы он не затёрся молча при сохранении
export function typeOptions(current, types) {
  const names = typeNames(types)
  const c = String(current || '').trim()
  return c && !names.includes(c)
    ? [{ value: c, legacy: true }, ...names.map((v) => ({ value: v }))]
    : names.map((v) => ({ value: v }))
}
