// ── Мешок у дробного товара в карточке (версия 1.5.12) ──
// Поле «В упаковке, кг» и вопрос «за что были прежние цены», когда мешок меняют. Вынесено из
// карточки (components/ProductForm.jsx), чтобы проверять без окна
import { KG, isVesovoy, kgText } from './units.js'

// Больше штук (граммов) в упаковке сервер не примет: бочка 200 л — это 200 000
export const MAX_UPP = 1_000_000

// ── Сменили мешок у товара, у которого уже есть цены или остаток (1.5.12) ──
// Цены в карточке — за упаковку. Что значили прежние числа, знает только человек: у одного
// «185» — цена килограмма (тогда при мешке 50 кг закупочная станет 9250), у другого — уже цена
// мешка (её когда-то записали «за кг»). Поэтому при смене спрашиваем — и цены карточки, и
// цены партий на складе переводятся (scale) или остаются (keep). Остаток не меняется: он в
// граммах. value.upp0, cost0, price0, stock0 — какими они были при открытии карточки
export function repackAsk(value) {
  if (!isVesovoy(value) || !(Number(value?.upp0) > 0)) return null
  const was = Number(value.upp0)
  const now = vesUpp(value.vesUp)
  if (was === now) return null
  const has = Number(value.cost0) > 0 || Number(value.price0) > 0 || Number(value.stock0) > 0
  return has ? { was, now, ratio: now / was } : null
}
// Сменили мешок, а за что были прежние цены, не сказали — сохранять нельзя
export const repackNeeded = (value) => !!repackAsk(value) && value.repack !== 'scale' && value.repack !== 'keep'
export const r2 = (v) => Math.round(Number(v) * 100) / 100

// «50» или «2,5» кг в упаковке → граммов в упаковке; пусто, мусор и не больше 1 — без мешка
export function vesUpp(v) {
  const kg = Number(String(v ?? '').trim().replace(',', '.'))
  return Number.isFinite(kg) && kg > 1 ? Math.min(MAX_UPP, Math.round(kg * KG)) : KG
}
// Граммов в упаковке → «50», «2,5» для поля; без мешка — пусто
export const vesUpText = (upp) => (Number(upp) > KG ? kgText(Number(upp)) : '')
