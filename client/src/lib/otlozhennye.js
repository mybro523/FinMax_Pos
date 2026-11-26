// ── Отложенные товары кассы (1.8.15) ──
//
// Покупатель раздумал брать позицию прямо сейчас, но отдавать её не хочет — кассир
// откладывает ТОВАР (а не весь чек, как «Отложить чек»): строка уходит из корзины в
// отдельный список и не продаётся и не списывается, пока её не вернут.
//
// Хранится на устройстве, как открытые чеки (lib/cheki.js): тот же прилавок и та же
// смена увидят список, а другой кассе он не нужен. Ключ свой у каждого магазина, чтобы
// отложенные одной не показались другой в том же браузере.
//
// Пункт списка — снимок строки корзины (чтобы вернуть ровно то, что набрали) плюс id и
// время. При возврате строка сверяется с базой (osvezhit в lib/cheki.js): пока товар
// лежал, цена и остаток могли измениться.
import { uppOf, edinica } from './units.js'

export const MAX_OTLOZH = 100

const num = (v) => Number(v) || 0
export const klyuchOtlozh = (code) => 'apteka_otlozh_tovary_' + (code || 'net')

let seq = 0
const newOtlId = () => 'o' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5)

// Снимок строки корзины → чистый пункт списка. Храним ровно те поля, что нужны строке
// чека (их же сверяет osvezhit), плюс id и время
const snimok = (line) => ({
  productId: line.productId,
  name: String(line.name || ''),
  price: num(line.price),
  piecePrice: line.piecePrice == null ? null : num(line.piecePrice),
  cost: num(line.cost),
  unitsPerPack: uppOf(line),
  unit: edinica(line),
  stock: num(line.stock),
  looseUnits: num(line.looseUnits),
  qty: Math.max(0, Math.trunc(num(line.qty))),
  pieces: Math.max(0, Math.trunc(num(line.pieces))),
  discount: Math.max(0, num(line.discount)),
})

export const otlozhitItem = (line) => ({ id: newOtlId(), at: Date.now(), ...snimok(line) })

// Разбор сохранённого: что не похоже на строку товара — отбрасываем, чтобы сломанная
// запись не роняла кассу
export function razobratOtlozh(raw) {
  let data = null
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    data = null
  }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
  const list = []
  for (const i of arr) {
    if (!i || typeof i.productId !== 'string' || !i.productId) continue
    if (list.length >= MAX_OTLOZH) break
    const id = typeof i.id === 'string' && i.id && !list.some((x) => x.id === i.id) ? i.id : newOtlId()
    list.push({ id, at: num(i.at) || Date.now(), ...snimok(i) })
  }
  return list
}

export function chitatOtlozh(code) {
  try {
    return razobratOtlozh(localStorage.getItem(klyuchOtlozh(code)))
  } catch {
    return [] // приватный режим: список проживёт до закрытия страницы
  }
}

export function pisatOtlozh(code, list) {
  try {
    localStorage.setItem(klyuchOtlozh(code), JSON.stringify(Array.isArray(list) ? list : []))
  } catch {
    /* приватный режим или хранилище переполнено — список остаётся в памяти страницы */
  }
}
