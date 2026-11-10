// ── Авто-заявка: поставщик каждого товара и отбор строк (1.7.2) ──
//
// Своего поставщика у карточки товара нет — он виден только по приходам. Поставщик товара
// в заявке — тот, от кого товар пришёл в последний раз (приход, где поставщик указан).
// Сервер считает это по приходам за всё время (GET /products/suppliers); журнал приходов
// на этом устройстве — за полгода, зато в нём и приходы, которые сервер ещё не получил
// (оформлены без связи). Поэтому берутся оба источника, и по каждому товару побеждает
// более поздний приход. Правила без окна: их проверяет test/zayavka.test.js.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { tovarPodhodit } from './poisk.js'

// Отбор «Без поставщика» — товар ни разу не приходил с указанным поставщиком
export const BEZ_POSTAVSHIKA = '__none'

const ts = (d) => {
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : 0
}

// Ключ поставщика для отбора: id из справочника, а у прихода без справочника (прежние
// приходы, удалённый поставщик) — имя, каким его записали
export const postavshikKey = (supplierId, name) => (supplierId ? 'id:' + supplierId : 'name:' + String(name || '').trim().toLowerCase())

// Указан ли в приходе поставщик: «—» записывался, когда поставщика не выбирали
const ukazan = (name) => {
  const s = String(name || '').trim()
  return !!s && s !== '—'
}

// Поставщик каждого товара: productId → { key, name, date }.
// arrivals — журнал приходов устройства, server — ответ сервера (или null, если его нет),
// suppliers — справочник: имя поставщика — нынешнее (его могли переименовать)
export function postavshikiTovarov({ arrivals = [], server = null, suppliers = [] } = {}) {
  const names = new Map((suppliers || []).filter((s) => s && s.id).map((s) => [s.id, s.name]))
  // Имя поставщика в справочнике единственное: приход прежней версии (без ссылки) с тем же
  // именем — тот же поставщик, иначе в выборе он встал бы дважды и заявка ему вышла бы неполной
  const byName = new Map((suppliers || []).filter((s) => s && s.id).map((s) => [String(s.name || '').trim().toLowerCase(), s.id]))
  const out = new Map()
  const put = (productId, supplierIdRaw, snap, date) => {
    if (!productId) return
    const supplierId = supplierIdRaw && names.has(supplierIdRaw) ? supplierIdRaw : byName.get(String(snap || '').trim().toLowerCase()) || supplierIdRaw
    const known = supplierId && names.has(supplierId)
    const name = known ? names.get(supplierId) : snap
    if (!known && !ukazan(name)) return
    const was = out.get(productId)
    if (was && ts(was.date) >= ts(date)) return
    // Поставщика удалили из справочника — отбор по имени, как у прежних приходов. Справочник
    // ещё не загрузился — по id: имя тогда снимком, а ключ уже тот, что будет после загрузки
    const id = known || (supplierId && names.size === 0) ? supplierId : null
    out.set(productId, { key: postavshikKey(id, name), name: String(name).trim(), date })
  }
  for (const r of Array.isArray(server) ? server : []) put(r?.productId, r?.supplierId, r?.supplier, r?.date)
  for (const a of arrivals || []) {
    if (!a || !Array.isArray(a.items)) continue
    for (const i of a.items) put(i?.productId, a.supplierId, a.supplier, a.date)
  }
  return out
}

// Строки заявки с поставщиком: каждой — supplierKey и supplier (пусто — без поставщика)
export function sPostavshikom(rows, map) {
  return (rows || []).map((p) => {
    const s = map?.get(p.id)
    return { ...p, supplierKey: s ? s.key : BEZ_POSTAVSHIKA, supplier: s ? s.name : '' }
  })
}

// Отбор строк: поиск (название или штрихкод), поставщик, категория. Пустое — подходит всё
export function otborZayavki(rows, { z = null, sup = '', cat = '' } = {}) {
  return (rows || []).filter(
    (p) => tovarPodhodit(z, p.name, p.barcode) && (!sup || p.supplierKey === sup) && (!cat || (p.category || '') === cat),
  )
}

// Поставщики для выбора: те, у кого есть товары в заявке, по имени; сколько позиций у каждого.
// «Без поставщика» — последним, если такие товары есть
export function spisokPostavshikov(rows, cmp = (a, b) => a.localeCompare(b, 'ru')) {
  const by = new Map()
  let none = 0
  for (const p of rows || []) {
    if (p.supplierKey === BEZ_POSTAVSHIKA) {
      none++
      continue
    }
    const was = by.get(p.supplierKey)
    if (was) was.count++
    else by.set(p.supplierKey, { key: p.supplierKey, name: p.supplier, count: 1 })
  }
  const list = [...by.values()].sort((a, b) => cmp(a.name, b.name))
  return { list, none }
}

// Категории для выбора: те, что есть в заявке, по имени; пустая категория не предлагается
export function spisokKategoriy(rows, cmp = (a, b) => a.localeCompare(b, 'ru')) {
  const by = new Map()
  for (const p of rows || []) {
    const c = p.category || ''
    if (!c) continue
    by.set(c, (by.get(c) || 0) + 1)
  }
  return [...by.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => cmp(a.name, b.name))
}
