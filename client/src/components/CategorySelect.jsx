import { LuPlus } from 'react-icons/lu'
import { db } from '../db/store'
import { useCan } from '../db/auth'
import { translate as tr } from '../lib/i18n'

// ── Категория товара: выбор и заведение на месте ──
// Категория необязательна: магазину годится товар и без неё. «+» заводит новую
// категорию прямо из формы товара — это тот же справочник, что в настройках,
// поэтому там она появится сразу. Кнопка видна тем, кому настройки категорий
// разрешены правами.

export async function addCategoryDialog({ dialog, toast, options, onPicked }) {
  const r = await dialog.prompt({
    title: tr('Новая категория'),
    fields: [{ name: 'name', label: tr('Название'), placeholder: tr('Напр. Хлеб и выпечка') }],
    confirmText: tr('Добавить'),
  })
  const name = (r?.name || '').trim().slice(0, 40)
  if (!r || !name) return
  const same = (options || []).find((c) => c.toLowerCase() === name.toLowerCase())
  if (same) return onPicked(same)
  try {
    // Новая категория из формы товара — без слежки за сроком: так подходит
    // и хлебу, и шампуню; для товаров отметку меняют в настройках
    await db.push('categories', { name, noExpiry: true })
    onPicked(name)
    toast(tr('Категория добавлена — она появилась и в настройках'))
  } catch (e) {
    toast(tr(e.message), 'err')
  }
}

export function AddCategoryBtn({ dialog, toast, options, onPicked }) {
  const can = useCan()
  if (!can('settings.categories') || !dialog) return null
  return (
    <button
      type="button"
      className="btn icon"
      style={{ flexShrink: 0 }}
      title={tr('Новая категория')}
      onClick={() => addCategoryDialog({ dialog, toast, options, onPicked })}
    >
      <LuPlus size={16} />
    </button>
  )
}
