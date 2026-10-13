// ── Упаковки и штуки: одна формула на всю программу ──
// Товар может продаваться целыми упаковками и поштучно из вскрытой. Из-за этого
// почти в каждом экране считалось «сколько всего штук» и «на какую сумму», и формула
// была переписана заново в семи файлах. Разошлись они предсказуемо: в истории скидок
// сумма позиции считалась как цена × упаковки, а штуки не учитывались вовсе — пять
// таблеток со скидкой давали «итог −20 сомони».
//
// Поэтому формулы живут здесь, и правится каждая в одном месте.
//
// Позиция чека (i): { qty, pieces, unitsPerPack, price, cost, discount }
// Карточка товара (p): { stock, looseUnits, unitsPerPack, price, cost }

const num = (v) => Number(v) || 0

// Штук в упаковке. Ноль, пусто и мусор означают «упаковка неделимая».
export const uppOf = (x) => Math.max(1, num(x?.unitsPerPack))

// Делится ли товар на штуки
export const isDivisible = (x) => uppOf(x) > 1

// Цена и себестоимость ОДНОЙ ШТУКИ (в карточке они хранятся за упаковку)
export const unitPrice = (x) => num(x?.price) / uppOf(x)
export const unitCost = (x) => num(x?.cost) / uppOf(x)

// ── Позиция чека ──
// Всего штук: целые упаковки × штук в упаковке + отдельные штуки
export const lineUnits = (i) => num(i?.qty) * uppOf(i) + num(i?.pieces)
// Сумма позиции до скидки
export const lineGross = (i) => unitPrice(i) * lineUnits(i)
// Скидка не может быть отрицательной и больше суммы позиции
export const lineDiscount = (i) => Math.min(Math.max(0, num(i?.discount)), lineGross(i))
// Сумма позиции к оплате
export const lineNet = (i) => lineGross(i) - lineDiscount(i)
// Себестоимость позиции
export const lineCost = (i) => unitCost(i) * lineUnits(i)

// ── Остаток товара ──
// Всего штук на складе: целые упаковки + остаток во вскрытой
export const stockUnits = (p) => num(p?.stock) * uppOf(p) + num(p?.looseUnits)
// Стоимость остатка по цене продажи и по закупочной
export const stockValue = (p) => unitPrice(p) * stockUnits(p)
export const stockCost = (p) => unitCost(p) * stockUnits(p)

// ── Просрочка ──
// Сколько штук просрочено. Число приходит с сервера: только он видит партии и их
// сроки. Подрезаем остатком на случай, если данные на устройстве чуть устарели —
// «просрочено больше, чем лежит» не бывает.
export const expiredUnits = (p) => Math.min(stockUnits(p), Math.max(0, num(p?.expiredUnits)))

// Сколько штук реально можно продать. Просроченное на складе ещё лежит и ждёт
// списания, но покупателю не уходит — касса считает доступным только годное.
export const sellableUnits = (p) => Math.max(0, stockUnits(p) - expiredUnits(p))

export const hasExpired = (p) => expiredUnits(p) > 0

// ── Весовой товар ──
// Продаётся килограммами: яблоки, крупы, орехи. Внутри система считает его той же
// механикой, что упаковки и штуки, только «упаковка» — это килограмм, а «штука» —
// грамм (unitsPerPack = 1000). Деньги и остатки остаются целыми числами, и ни одна
// формула выше не меняется. Людям же везде показываются килограммы: «0,350 кг».
export const KG = 1000
export const isVesovoy = (x) => String(x?.unit || '').trim().toLowerCase() === 'кг'

// 12350 г → «12,35», 350 г → «0,35», 1000 г → «1»
// Делим на 1000 и меняем точку на запятую: дробных знаков не больше трёх,
// а toLocaleString вставлял бы неразрывный пробел в тысячи килограммов
export const kgText = (units) => String(num(units) / KG).replace('.', ',')

// «1,25» или «1.25» кг → 1250 г. Мусор и минус превращаются в ноль
export const gramsOfKg = (kg) => Math.max(0, Math.round((Number(String(kg ?? '').replace(',', '.')) || 0) * KG))

// Разложить общее число штук обратно на упаковки и вскрытую — так остаток
// хранится в карточке товара
export function splitUnits(units, x) {
  const upp = uppOf(x)
  const total = Math.max(0, Math.trunc(num(units)))
  return { stock: Math.floor(total / upp), looseUnits: total % upp }
}

// ── Сколько из набранного помещается в остаток ──
//
// В строке корзины два числа: упаковки и штуки. Вместе они не должны превышать
// годный остаток. Когда превышают — урезаем, но не отбрасываем набранное целиком:
// иначе число из нескольких цифр откатывалось бы на предыдущее прямо под пальцами.
//
// Отдельно отвечаем на вопрос, ПОЧЕМУ не поместилось. Случай, из-за которого всё
// и затевалось: остаток — ровно одна пачка, она уже в корзине, и кассир хочет
// продать из неё три таблетки. Штук на складе хватает, места не хватает только
// потому, что его занимает упаковка. Тогда отказ — не тупик, а подсказка:
// уберите упаковку, и штуки поместятся.
export function fitLine({ qty, pieces, upp, avail }) {
  const p = Math.max(1, Math.trunc(upp) || 1)
  const room = Math.max(0, Math.trunc(avail) || 0)
  let q = Math.max(0, Math.trunc(qty) || 0)
  let s = Math.max(0, Math.trunc(pieces) || 0)

  if (q * p + s <= room) return { qty: q, pieces: s, capped: false, blockedByPacks: false }

  // Штуки поместились бы, не будь упаковок
  const blockedByPacks = q > 0 && s > 0 && s <= room
  q = Math.min(q, Math.floor(room / p))
  s = Math.min(s, Math.max(0, room - q * p))
  return { qty: q, pieces: s, capped: true, blockedByPacks }
}
