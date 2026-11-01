// ── Упаковки и штуки: одна формула на всю программу ──
// Товар может продаваться целыми упаковками и поштучно из вскрытой. Из-за этого
// почти в каждом экране считалось «сколько всего штук» и «на какую сумму», и формула
// была переписана заново в семи файлах. Разошлись они предсказуемо: в истории скидок
// сумма позиции считалась как цена × упаковки, а штуки не учитывались вовсе — пять
// штук со скидкой давали «итог −20 сомони».
//
// Поэтому формулы живут здесь, и правится каждая в одном месте.
//
// Позиция чека (i): { qty, pieces, unitsPerPack, price, piecePrice, cost, discount }
// Карточка товара (p): { stock, looseUnits, unitsPerPack, price, piecePrice, cost }

const num = (v) => Number(v) || 0

// Штук в упаковке. Ноль, пусто и мусор означают «упаковка неделимая».
export const uppOf = (x) => Math.max(1, num(x?.unitsPerPack))

// Делится ли товар на штуки: упаковку вскрывают и продают отдельно — штуки из пачки или
// килограммы из мешка (1.5.12). У дробного товара без мешка «штука» — грамм: он не делится,
// он и так продаётся на вес
export const isDivisible = (x) => opensPack(x)

// Цена и себестоимость ОДНОЙ ШТУКИ из цены упаковки (в карточке они хранятся за упаковку)
export const unitPrice = (x) => num(x?.price) / uppOf(x)
export const unitCost = (x) => num(x?.cost) / uppOf(x)

// ── Своя цена за 1 шт (версия 1.5.11) и за 1 кг (версия 1.5.12) ──
// Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
// продаются по цене упаковки, отдельные штуки — по своей цене: «1 уп + 5 шт» при упаковке
// 150 и своей цене 2 — это 150 + 10. Своей цены нет — штука стоит цена упаковки / штук.
// У весового товара в мешке своя цена — за 1 кг: «1 уп + 2 кг» при мешке 190 и цене 4 за кг —
// это 190 + 8. Своя цена бывает только у товара, упаковку которого вскрывают (opensPack).
// Та же формула у сервера (server/src/common/piece.ts) и у программы без связи
// (desktop/src/local/piece.mjs). У позиции чека piecePrice — снимок: по какой цене штуки
// (килограмма) её продали
export const ownPiecePrice = (x) => {
  if (!opensPack(x)) return null
  if (x?.piecePrice === null || x?.piecePrice === undefined || x?.piecePrice === '') return null
  const v = Number(x.piecePrice)
  return Number.isFinite(v) && v > 0 ? v : null
}
// Цена одной штуки (у весового — одного килограмма): своя или цена упаковки / штук в упаковке
export const pricePerPiece = (x) => ownPiecePrice(x) ?? unitPrice(x) * pieceUnits(x)

// ── Позиция чека ──
// Всего штук: целые упаковки × штук в упаковке + отдельные штуки
export const lineUnits = (i) => num(i?.qty) * uppOf(i) + num(i?.pieces)
// Сумма позиции до скидки: упаковки — по цене упаковки, отдельные штуки — по цене штуки.
// Своей цены штуки нет — то же, что (цена / штук) × все штуки, как было всегда
// У весового своя цена — за килограмм, а в строке граммы: делим на 1000 (pieceUnits)
export const lineGross = (i) => {
  const own = ownPiecePrice(i)
  return own === null ? unitPrice(i) * lineUnits(i) : num(i?.qty) * num(i?.price) + (num(i?.pieces) * own) / pieceUnits(i)
}
// Скидка не может быть отрицательной и больше суммы позиции
export const lineDiscount = (i) => Math.min(Math.max(0, num(i?.discount)), lineGross(i))
// Сумма позиции к оплате
export const lineNet = (i) => lineGross(i) - lineDiscount(i)
// Себестоимость позиции
export const lineCost = (i) => unitCost(i) * lineUnits(i)

// ── Возврат: сколько денег за units штук позиции чека ──
// Своей цены штуки нет — как всегда: заплачено за позицию / продано штук × возвращено.
// Есть (1.5.11) — возвращаемые штуки считаются сначала отдельными (по своей цене штуки),
// сверх них — штуками из целых упаковок (цена упаковки / штук), а скидка позиции делится
// пропорционально. Иначе за 5 штук, купленных по 2, вернули бы 8,42 вместо 10.
// already — сколько штук этой позиции уже вернули раньше. Та же формула у сервера и программы
export function vozvratSumma(i, units, already = 0) {
  const sold = lineUnits(i)
  const u = num(units)
  if (!(sold > 0) || !(u > 0)) return 0
  const gross = lineGross(i)
  const paid = gross - num(i?.discount)
  const own = ownPiecePrice(i)
  if (own === null) return (paid / sold) * u
  const piecesLeft = Math.max(0, num(i?.pieces) - Math.max(0, num(already)))
  const asPieces = Math.min(u, piecesLeft)
  const grossRet = (asPieces * own) / pieceUnits(i) + (u - asPieces) * unitPrice(i)
  return gross > 0 ? (grossRet * paid) / gross : 0
}

// ── Остаток товара ──
// Всего штук на складе: целые упаковки + остаток во вскрытой
export const stockUnits = (p) => num(p?.stock) * uppOf(p) + num(p?.looseUnits)
// Стоимость остатка по цене продажи и по закупочной. Целые упаковки — по цене упаковки,
// вскрытая — по цене штуки (своей, если задана)
export const stockValue = (p) => {
  const own = ownPiecePrice(p)
  return own === null ? unitPrice(p) * stockUnits(p) : num(p?.stock) * num(p?.price) + (num(p?.looseUnits) * own) / pieceUnits(p)
}
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

// ── Дробные единицы: килограммы, литры, метры, квадратные метры ──
// Яблоки — килограммами, масло на разлив — литрами, кабель — метрами, линолеум —
// квадратными метрами. Внутри система считает такой товар той же механикой, что
// упаковки и штуки, только «упаковка» — это целая единица, а «штука» — её тысячная
// (грамм, миллилитр, миллиметр): unitsPerPack = 1000. Деньги и остатки остаются
// целыми числами, и ни одна формула выше не меняется. Людям же везде показывается
// дробное число с единицей: «0,350 кг», «1,5 л», «2,3 м».
//
// Название isVesovoy осталось от времён, когда дробным был только килограмм:
// теперь оно значит «продаётся дробно».
export const KG = 1000
export const DROBNYE = ['кг', 'л', 'м', 'м²']
const unitKey = (x) => String(x?.unit || '').trim().toLowerCase()
export const isVesovoy = (x) => DROBNYE.includes(unitKey(x))
export const isDrobnyy = isVesovoy
// Весы печатают этикетки только в килограммах — штрихкод весов ищем среди них
export const isKg = (x) => unitKey(x) === 'кг'

// ── Весовой товар в упаковке (версия 1.5.12) ──
// Мешок муки 50 кг, канистра 20 л, бухта кабеля 100 м: у дробного товара бывает настоящая
// упаковка. Внутри — та же механика упаковок и штук: unitsPerPack — тысячных (граммов) в
// упаковке, мешок 50 кг — 50 000. Без мешка — 1000: «упаковка» — одна единица, как всегда.
// Цены продажи и закупки — за упаковку (за мешок), своя цена — за 1 кг, отдельные
// килограммы продаются по ней или по цене мешка / 50.
//
// Сколько внутренних единиц в одной «штуке» своей цены: у штучного одна, у дробного 1000
export const pieceUnits = (x) => (isVesovoy(x) ? KG : 1)
// Упаковку вскрывают и продают отдельно: штуки из пачки, килограммы из мешка
export const opensPack = (x) => uppOf(x) > pieceUnits(x)
// Весовой товар в мешке (а не просто на вес)
export const vesUpak = (x) => isVesovoy(x) && opensPack(x)
// Сколько в упаковке — в штуках или килограммах: 20, 50, 2,5
export const packPieces = (x) => uppOf(x) / pieceUnits(x)
// Подписи: упаковка — «уп» (у весового — тоже «уп»: «кг» — это уже его штука), отдельные —
// «шт» или единица весового («кг», «л», «м»)
export const packLabel = (x) => (isVesovoy(x) ? 'уп' : edinica(x))
export const pieceLabel = (x) => (isVesovoy(x) ? edinica(x) : 'шт')
// Число отдельных: штук — целым, у весового — килограммами с дробью («2,5»)
export const pieceAmount = (n, x) => (isVesovoy(x) ? kgText(n) : String(Math.max(0, Math.trunc(num(n)))))

// ── Количество словами ──
// «2 уп + 5 шт», «2 уп + 10,5 кг», «3 уп», «10,5 кг» (весовой без мешка), «7 шт». Целых
// упаковок нет — показывается и ноль: «0 уп + 10 кг», как остаток в «Товарах».
// t — перевод подписей
export function unitsText(units, x, t = (s) => s) {
  const u = Math.max(0, Math.trunc(num(units)))
  if (isVesovoy(x) && !opensPack(x)) return `${kgText(u)} ${t(edinica(x))}`
  const upp = uppOf(x)
  const packs = Math.floor(u / upp)
  if (!opensPack(x)) return `${packs} ${t(packLabel(x))}`
  const loose = u % upp
  return loose > 0 ? `${packs} ${t(packLabel(x))} + ${pieceAmount(loose, x)} ${t(pieceLabel(x))}` : `${packs} ${t(packLabel(x))}`
}

// Подпись единицы рядом с числом: «кг», «л», «уп», «рулон». Пусто — «уп»,
// как у товаров, заведённых до появления выбора единицы
export const edinica = (x) => String(x?.unit || '').trim() || 'уп'

// ── Единицы для выбора в карточке товара ──
// drob — продаётся дробно (тысячными долями). Остальные — целыми, и у них может
// быть «штук внутри» (упаковка из 20) для продажи поштучно.
// Пачку, коробку, блок, бутылку, банку, флакон, тюбик, пару, комплект, лист, мешок
// и ящик из выбора убрали по просьбе владельца. Товары, заведённые с ними раньше,
// работают как прежде: карточка показывает их единицу отдельной строкой
export const EDINICY = [
  { v: 'шт', name: 'штука' },
  { v: 'уп', name: 'упаковка' },
  { v: 'кг', name: 'килограмм', drob: true },
  { v: 'л', name: 'литр', drob: true },
  { v: 'м', name: 'метр', drob: true },
  { v: 'м²', name: 'квадратный метр', drob: true },
  { v: 'рулон', name: 'рулон' },
]

// 12350 г → «12,35», 350 г → «0,35», 1000 г → «1»
// Делим на 1000 и меняем точку на запятую: дробных знаков не больше трёх,
// а toLocaleString вставлял бы неразрывный пробел в тысячи килограммов
export const kgText = (units) => String(num(units) / KG).replace('.', ',')

// Единица строки документа (чека, возврата). В строках, пришедших с сервера, её нет —
// только «штук в упаковке», поэтому она берётся из карточки товара. Угадывается она только
// у удалённого товара: 1000 в упаковке — килограммы (у живой карточки без единицы это
// обычные упаковки по 1000 штук). Без неё весовой товар печатался бы «1500 шт × 0,01»
// вместо «1,5 кг × 10»
export function edinicaStroki(i, product) {
  const own = String(i?.unit || '').trim()
  if (own) return own
  if (product) return String(product.unit || '').trim() || 'уп'
  return uppOf(i) === KG ? 'кг' : 'уп'
}
// Строки документа с единицей у каждой. products — список товаров или Map(id → товар)
export function sEdinicami(items, products) {
  const byId = products instanceof Map ? products : new Map((products || []).map((p) => [p.id, p]))
  return (items || []).map((i) => (String(i?.unit || '').trim() ? i : { ...i, unit: edinicaStroki(i, byId.get(i?.productId)) }))
}

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
// продать из неё три штуки. Штук на складе хватает, места не хватает только
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
