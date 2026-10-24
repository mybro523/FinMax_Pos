// ── Что прислала касса ──
//
// Операции приходят не с сайта, а с программы, которая могла неделю работать без
// интернета. Сервер не может им доверять на слово: программа стоит на чужом
// компьютере, и запрос от её имени способен прислать кто угодно, у кого есть ключ
// входа. Поэтому каждая операция здесь разбирается заново, поле за полем, и в базу
// попадает только то, что прошло проверку.
//
// Но и отказывать по мелочам нельзя: операция уже СЛУЧИЛАСЬ. Чек напечатан, товар
// отдан, деньги взяты. Отказ не отменит продажу — он лишь оставит её вне учёта.
// Поэтому отвергается только то, что нельзя записать без вранья: мусор вместо
// данных, суммы, которые не сходятся сами с собой, ссылки в никуда.
//
// Модуль не знает ни про базу, ни про Nest — только разбор. Проверяется отдельно.

import { storableDate } from '../common/time'

// Отказ по существу: повторять операцию бессмысленно, касса покажет её владельцу
export class Reject extends Error {}

const ID = /^[A-Za-z0-9_:.-]{1,64}$/
// Деньги в базе — до 9 999 999 999,99. Больше — заведомо ошибка, а не цена
const MAX_MONEY = 9_999_999_999.99
// Штуки база хранит обычным целым числом
const MAX_UNITS = 2_000_000_000
// Часы кассы сверены с сервером, но мало ли: «завтрашний» чек исказил бы отчёты
const FUTURE_SLACK_MS = 5 * 60 * 1000

export const OP_TYPES = [
  'sale',
  'return',
  'writeoff',
  'arrival',
  'shift.open',
  'shift.close',
  'debt.pay',
  'customer.create',
  'deferred.add',
  'deferred.remove',
  'expense',
  'cash.move',
  'income',
  'supplier.return',
  // ── Справочники и правки документов без связи (версия 1.4.14) ──
  'product.create',
  'product.update',
  'product.delete',
  'category.create',
  'category.update',
  'category.delete',
  'productType.create',
  'productType.update',
  'productType.delete',
  'payService.create',
  'payService.delete',
  'expenseCategory.create',
  'expenseCategory.delete',
  'incomeCategory.create',
  'incomeCategory.delete',
  'supplier.create',
  'supplier.update',
  'supplier.delete',
  'supplier.pay',
  'supplierPayment.delete',
  'supplierReturn.delete',
  'expense.update',
  'expense.delete',
  'income.update',
  'income.delete',
  'cashMove.delete',
  'arrival.update',
  'arrival.delete',
  // ── Инвентаризация без связи (версия 1.4.15) ──
  'inventory.create',
  'inventory.count',
  'inventory.apply',
  'inventory.delete',
] as const
export type OpType = (typeof OP_TYPES)[number]

// Что касса может прислать только от имени владельца — как и на сайте
export const FOUNDER_ONLY: ReadonlySet<string> = new Set(['writeoff', 'expense', 'income'])

const obj = (v: any, what: string) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Reject(`Нет данных: ${what}`)
  return v
}

export function id(v: any, what: string): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Reject(`Недопустимый номер: ${what}`)
  return v
}

const idOrNull = (v: any, what: string): string | null => (v === null || v === undefined || v === '' ? null : id(v, what))

function text(v: any, max: number, fallback = ''): string {
  if (v === null || v === undefined) return fallback
  if (typeof v !== 'string') throw new Reject('Ожидался текст')
  return v.slice(0, max)
}

function money(v: any, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_MONEY) throw new Reject(`Недопустимая сумма: ${what}`)
  return v
}

// Сумма может быть отрицательной: прибыль чека, расхождение в кассе
function signedMoney(v: any, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_MONEY) throw new Reject(`Недопустимая сумма: ${what}`)
  return v
}

// Проценты: от 0 до 100
function percent(v: any, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Reject(`Недопустимый процент: ${what}`)
  return v
}

function int(v: any, what: string, min = 0, max = 10_000_000): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Reject(`Недопустимое количество: ${what}`)
  return v
}

// Момент, когда операция случилась на кассе. В будущее не пускаем
export function when(v: any, what: string, now = Date.now()): Date {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(t)) throw new Reject(`Недопустимая дата: ${what}`)
  const at = t > now + FUTURE_SLACK_MS ? now : t
  if (!storableDate(at)) throw new Reject(`Недопустимая дата: ${what}`)
  return new Date(at)
}

// Дату, которую база не хранит (год длиннее четырёх цифр — опечатка в сроке
// годности), отвергаем здесь. Дойди она до базы, операцию нельзя было бы записать
// никогда, и касса присылала бы её снова и снова — а за ней стояла бы вся очередь
function dateOrNull(v: any, what: string): Date | null {
  if (v === null || v === undefined || v === '') return null
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(t) || !storableDate(t)) throw new Reject(`Недопустимая дата: ${what}`)
  return new Date(t)
}

function list<T>(v: any, what: string, each: (x: any, n: number) => T, max = 500): T[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) throw new Reject(`Нет позиций: ${what}`)
  return v.map((x, n) => each(obj(x, what), n))
}

// Отказ внутри выражения — чтобы не разбивать разбор на ветки
const reject = (why: string): never => {
  throw new Reject(why)
}

const oneOf = <T extends string>(v: any, values: readonly T[], what: string): T => {
  if (!values.includes(v)) throw new Reject(`Недопустимое значение: ${what}`)
  return v
}

// ── Продажа ──
export function parseSale(p: any, now?: number) {
  const s = obj(obj(p, 'продажа').sale, 'чек')
  return {
    id: id(s.id, 'чек'),
    clientId: s.clientId === null || s.clientId === undefined ? null : text(s.clientId, 100),
    date: when(s.date, 'чек', now),
    payment: oneOf(s.payment, ['cash', 'card', 'debt', 'transfer'] as const, 'оплата'),
    // Перевод без сервиса не сверить с выпиской
    payVia: s.payment === 'transfer' ? text(s.payVia, 40).trim() || reject('У перевода не указан сервис') : null,
    customerId: idOrNull(s.customerId, 'клиент'),
    shiftId: idOrNull(s.shiftId, 'смена'),
    total: money(s.total, 'итог чека'),
    cost: money(s.cost, 'себестоимость чека'),
    profit: signedMoney(s.profit, 'прибыль чека'),
    items: list(s.items, 'позиции чека', (i) => {
      const qty = int(i.qty, 'упаковки')
      const pieces = int(i.pieces ?? 0, 'штуки')
      if (qty + pieces <= 0) throw new Reject('В чеке позиция без количества')
      const unitsPerPack = int(i.unitsPerPack ?? 1, 'штук в упаковке', 1, 100_000)
      // Штуки база хранит целым числом: больше в него не помещается
      if (qty * unitsPerPack + pieces > MAX_UNITS) throw new Reject('Недопустимое количество: слишком много')
      return {
        id: id(i.id, 'позиция чека'),
        productId: id(i.productId, 'товар'),
        name: text(i.name, 300),
        qty,
        pieces,
        unitsPerPack,
        price: money(i.price, 'цена'),
        cost: money(i.cost, 'закупочная цена'),
        discount: money(i.discount ?? 0, 'скидка'),
      }
    }),
  }
}

// ── Возврат ──
export function parseReturn(p: any, now?: number) {
  const root = obj(p, 'возврат')
  const r = obj(root.ret, 'возврат')
  const w = root.writeOff === null || root.writeOff === undefined ? null : obj(root.writeOff, 'списание при возврате')
  return {
    id: id(r.id, 'возврат'),
    clientId: r.clientId === null || r.clientId === undefined ? null : text(r.clientId, 100),
    date: when(r.date, 'возврат', now),
    saleId: idOrNull(r.saleId, 'чек'),
    shiftId: idOrNull(r.shiftId, 'смена'),
    refund: oneOf(r.refund, ['cash', 'card', 'debt', 'transfer'] as const, 'способ возврата'),
    refundVia: text(r.refundVia, 40).trim() || null,
    total: money(r.total, 'сумма возврата'),
    note: text(r.note, 500),
    items: list(r.items, 'позиции возврата', (i) => ({
      id: id(i.id, 'позиция возврата'),
      productId: id(i.productId, 'товар'),
      name: text(i.name, 300),
      units: int(i.units, 'штуки', 1),
      unitsPerPack: int(i.unitsPerPack ?? 1, 'штук в упаковке', 1, 100_000),
      price: money(i.price, 'цена'),
      cost: money(i.cost ?? 0, 'закупочная цена'),
      amount: money(i.amount, 'сумма позиции'),
      restock: i.restock !== false,
      // Срок годности с упаковки — если кассир его вписал
      expiryDate: dateOrNull(i.expiryDate, 'срок годности'),
    })),
    writeOff: w
      ? {
          id: id(w.id, 'списание'),
          note: text(w.note, 500),
          items: list(w.items, 'позиции списания', (i) => ({
            id: id(i.id, 'позиция списания'),
            productId: id(i.productId, 'товар'),
            name: text(i.name, 300),
            units: int(i.units, 'штуки', 1),
            cost: money(i.cost ?? 0, 'закупочная цена'),
            expiryDate: dateOrNull(i.expiryDate, 'срок годности'),
          })),
        }
      : null,
  }
}

// ── Списание ──
export function parseWriteOff(p: any, now?: number) {
  const root = obj(p, 'списание')
  const w = obj(root.writeOff, 'списание')
  return {
    id: id(w.id, 'списание'),
    date: when(w.date, 'списание', now),
    reason: oneOf(w.reason ?? 'expired', ['expired', 'damaged', 'lost', 'other'] as const, 'причина'),
    note: text(w.note, 500),
    // Что списать. По каким партиям это разойдётся, сервер решает сам
    ask: list(root.ask, 'что списать', (i) => ({ productId: id(i.productId, 'товар'), units: int(i.units, 'штуки', 1) })),
  }
}

// ── Приход ──
export function parseArrival(p: any, now?: number) {
  const root = obj(p, 'приход')
  const a = obj(root.arrival, 'приход')
  const items = list(a.items, 'позиции прихода', (i) => {
    const row = {
      id: id(i.id, 'позиция прихода'),
      productId: id(i.productId, 'товар'),
      name: text(i.name, 300),
      qty: int(i.qty, 'упаковки', 0),
      // Штуки (у весового товара — граммы) сверх целых упаковок
      pieces: i.pieces === undefined || i.pieces === null ? 0 : int(i.pieces, 'штуки', 0),
      // Закупочная цена — уже со скидкой поставщика
      cost: money(i.cost, 'закупочная цена'),
      // Скидка поставщика на строку, % — для истории. Прежние кассы её не шлют
      discount: i.discount === undefined || i.discount === null || i.discount === '' ? 0 : percent(i.discount, 'скидка поставщика'),
      // Новая цена продажи, назначенная в приходе наценкой. Нет — цена остаётся прежней
      price: i.price === undefined || i.price === null || i.price === '' ? null : money(i.price, 'цена продажи'),
    }
    if (row.qty <= 0 && row.pieces <= 0) throw new Reject('Пустая позиция прихода')
    return row
  })
  const expiry = Array.isArray(root.expiry) ? root.expiry : []
  const total = money(a.total, 'сумма прихода')
  // Неоплаченная часть — долг поставщику. Больше самого прихода она не бывает
  const debt = money(a.debt ?? 0, 'долг поставщику')
  if (debt > total + 0.01) throw new Reject('Долг поставщику больше суммы прихода')
  // Оплаченная из ящика часть — не больше оплаченного вообще
  const paidCash = money(a.paidCash ?? 0, 'оплачено из кассы')
  if (paidCash > total - debt + 0.01) throw new Reject('Из кассы оплачено больше, чем стоит приход без долга')
  if (paidCash > 0 && !idOrNull(a.supplierId, 'поставщик')) throw new Reject('Для оплаты из кассы нужен поставщик из справочника')
  return {
    id: id(a.id, 'приход'),
    date: when(a.date, 'приход', now),
    supplier: text(a.supplier, 200) || '—',
    supplierId: idOrNull(a.supplierId, 'поставщик'),
    debt,
    total,
    payMethod: oneOf(a.payMethod ?? '', ['', 'cash', 'own', 'card', 'debt'] as const, 'способ оплаты'),
    paidCash,
    shiftId: idOrNull(a.shiftId, 'смена'),
    items: items.map((it, n) => ({ ...it, expiryDate: dateOrNull(expiry[n], 'срок годности') })),
  }
}

// ── Возврат товара поставщику ──
// Товар отдан поставщику без связи: со склада кассы он уже ушёл. Деньги — в счёт
// долга, в кассу (в ящик своей смены), наличными мимо кассы или на карту
export function parseSupplierReturn(p: any, now?: number) {
  const r = obj(obj(p, 'возврат поставщику').ret, 'возврат поставщику')
  const items = list(r.items, 'позиции возврата', (i) => {
    const row = {
      id: id(i.id, 'позиция возврата'),
      productId: id(i.productId, 'товар'),
      name: text(i.name, 300),
      qty: int(i.qty, 'упаковки', 0),
      // Штуки (у весового — граммы) сверх целых упаковок
      pieces: i.pieces === undefined || i.pieces === null ? 0 : int(i.pieces, 'штуки', 0),
      price: money(i.price, 'цена возврата'),
    }
    if (row.qty <= 0 && row.pieces <= 0) throw new Reject('Пустая позиция возврата')
    return row
  })
  return {
    id: id(r.id, 'возврат поставщику'),
    date: when(r.date, 'возврат поставщику', now),
    // Возвращают конкретному поставщику — без него возврата не бывает
    supplierId: idOrNull(r.supplierId, 'поставщик') ?? reject('Возврат без поставщика'),
    supplier: text(r.supplier, 200) || '—',
    refund: oneOf(r.refund, ['debt', 'cash', 'own', 'card'] as const, 'как вернули деньги'),
    shiftId: idOrNull(r.shiftId, 'смена'),
    note: text(r.note, 500),
    total: money(r.total, 'сумма возврата'),
    items,
  }
}

// ── Внесение и изъятие наличных ──
// Кассир положил размен или владелец забрал выручку — в смене этой кассы
export function parseCashMove(p: any, now?: number) {
  const m = obj(obj(p, 'наличные').move, 'наличные')
  const amount = money(m.amount, 'сумма')
  if (amount <= 0) throw new Reject('Сумма должна быть больше нуля')
  return {
    id: id(m.id, 'операция с наличными'),
    shiftId: id(m.shiftId, 'смена'),
    kind: oneOf(m.kind, ['in', 'out'] as const, 'вид операции'),
    amount,
    note: text(m.note, 500),
    date: when(m.date, 'операция с наличными', now),
  }
}

// ── Смена ──
export function parseShiftOpen(p: any, now?: number) {
  const s = obj(obj(p, 'смена').shift, 'смена')
  return { id: id(s.id, 'смена'), openedAt: when(s.openedAt, 'открытие смены', now), openingCash: money(s.openingCash, 'наличные на начало') }
}

export function parseShiftClose(p: any, now?: number) {
  const s = obj(obj(p, 'смена').shift, 'смена')
  return { id: id(s.id, 'смена'), closedAt: when(s.closedAt, 'закрытие смены', now), countedCash: money(s.countedCash ?? 0, 'пересчитано наличных') }
}

// ── Долг ──
export function parseDebtPay(p: any, now?: number) {
  const d = obj(obj(p, 'погашение').payment, 'погашение')
  const amount = money(d.amount, 'сумма погашения')
  if (amount <= 0) throw new Reject('Сумма погашения должна быть больше нуля')
  return {
    id: id(d.id, 'погашение'),
    customerId: id(d.customerId, 'клиент'),
    amount,
    shiftId: idOrNull(d.shiftId, 'смена'),
    createdAt: when(d.createdAt, 'погашение', now),
  }
}

export function parseCustomer(p: any, now?: number) {
  const c = obj(obj(p, 'клиент').customer, 'клиент')
  const name = text(c.name, 200)
  if (!name.trim()) throw new Reject('У клиента нет имени')
  return { id: id(c.id, 'клиент'), name, phone: text(c.phone, 60), debt: money(c.debt ?? 0, 'долг'), createdAt: when(c.createdAt, 'клиент', now) }
}

// ── Расход ──
// Владелец вносит расход в программе и без связи. Статью сервер со своим списком не
// сверяет: расход уже случился, а статью за это время могли убрать из списка — терять
// из-за этого запись о потраченных деньгах нельзя
export function parseExpense(p: any, now?: number) {
  const e = obj(obj(p, 'расход').expense, 'расход')
  const amount = money(e.amount, 'сумма расхода')
  if (amount <= 0) throw new Reject('Сумма расхода должна быть больше нуля')
  const category = text(e.category, 60).trim()
  if (!category) throw new Reject('У расхода не указана статья')
  return {
    id: id(e.id, 'расход'),
    date: when(e.date, 'расход', now),
    category,
    amount,
    note: text(e.note, 500),
    fromCash: e.fromCash === true,
    shiftId: idOrNull(e.shiftId, 'смена'),
    // Зарплата: кому выдана. Нет — расход без сотрудника
    employeeId: idOrNull(e.employeeId, 'сотрудник'),
    // И за какой месяц. Непонятный месяц операцию не роняет — деньги выданы, —
    // просто не записывается (тогда месяцем считается месяц выдачи)
    salaryMonth: typeof e.salaryMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(e.salaryMonth) ? e.salaryMonth : '',
    // И за какие дни считали бонус. Непонятные дни операцию тоже не роняют
    ...bonusDays(e.bonusFrom, e.bonusTo),
  }
}

// Дни бонуса: обе даты «ГГГГ-ММ-ДД» и «с» не позже «по», иначе — не записаны
const BONUS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
function bonusDays(from: unknown, to: unknown) {
  const ok = typeof from === 'string' && typeof to === 'string' && BONUS_DAY.test(from) && BONUS_DAY.test(to) && from <= to
  return ok ? { bonusFrom: from as string, bonusTo: to as string } : { bonusFrom: '', bonusTo: '' }
}

// ── Доход вне продаж ──
// Вносится в программе и без связи, как расход. Статью сервер со своим списком не
// сверяет: доход уже получен, а статью за это время могли убрать из списка
export function parseIncome(p: any, now?: number) {
  const e = obj(obj(p, 'доход').income, 'доход')
  const amount = money(e.amount, 'сумма дохода')
  if (amount <= 0) throw new Reject('Сумма дохода должна быть больше нуля')
  const category = text(e.category, 60).trim()
  if (!category) throw new Reject('У дохода не указана статья')
  return {
    id: id(e.id, 'доход'),
    date: when(e.date, 'доход', now),
    category,
    amount,
    note: text(e.note, 500),
  }
}

// ── Отложенные штрихкоды ──
export function parseDeferredAdd(p: any, now?: number) {
  const d = obj(obj(p, 'штрихкод').deferred, 'штрихкод')
  const barcode = text(d.barcode, 200).trim()
  if (barcode.length < 3) throw new Reject('Штрихкод слишком короткий')
  return { id: id(d.id, 'штрихкод'), barcode, createdAt: when(d.createdAt, 'штрихкод', now) }
}

export function parseDeferredRemove(p: any) {
  const d = obj(p, 'штрихкод')
  return { id: id(d.id, 'штрихкод'), barcode: text(d.barcode, 200).trim() }
}

// ════════════════════════════════════════════════════════════════════════════════
// ── Справочники и правки документов, сделанные без связи ──
//
// Касса заводит и правит без интернета товары, поставщиков, категории, типы, статьи и
// сервисы перевода, правит и удаляет расходы, доходы, приходы. Правка присылается так:
//   set  — что стало (только поля, которые поменяли);
//   base — что было в этих полях у кассы до правки;
//   at   — когда правили на кассе.
// По base и at сервер решает, чья правка новее, если то же поле правили и на сайте
// (common/stamps.ts). Остаток товара — отдельно: это пересчёт на момент at.
// ════════════════════════════════════════════════════════════════════════════════

// Поле правки: прислали — проверяем, нет — его не трогали
const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined

// Что было у кассы в поле до правки. Проверять его незачем — с ним только сравнивают;
// но и тащить в разбор что попало нельзя: текст обрезается, остальное — как есть
function baseOf(b: any, keys: string[]) {
  const out: Record<string, any> = {}
  if (!b || typeof b !== 'object') return out
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue
    const v = b[k]
    if (typeof v === 'string') out[k] = v.slice(0, 200_000)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 500).map((x) => String(x).slice(0, 64))
  }
  return out
}

const nonEmpty = (v: any, max: number, what: string) => {
  const t = text(v, max).trim()
  if (!t) throw new Reject(`Пусто: ${what}`)
  return t
}

const IMAGE = /^$|^data:image\/(jpeg|png|webp);base64,/

// ── Товар ──
// Поля карточки — как у сайта (products/dto.ts): те же пределы, те же правила
function productFields(src: any) {
  const out: Record<string, any> = {}
  if (has(src, 'name')) out.name = nonEmpty(src.name, 300, 'название товара')
  if (has(src, 'barcode')) out.barcode = nonEmpty(src.barcode, 200, 'штрихкод')
  if (has(src, 'category')) out.category = text(src.category, 60).trim()
  if (has(src, 'type')) out.type = text(src.type, 40).trim()
  if (has(src, 'cost')) out.cost = money(src.cost, 'закупочная цена')
  if (has(src, 'price')) out.price = money(src.price, 'цена')
  if (has(src, 'minStock')) out.minStock = int(src.minStock, 'минимальный остаток')
  if (has(src, 'unit')) out.unit = text(src.unit, 20).trim() || 'уп'
  if (has(src, 'unitsPerPack')) out.unitsPerPack = int(src.unitsPerPack, 'штук в упаковке', 1, 100_000)
  if (has(src, 'dosage')) out.dosage = text(src.dosage, 200)
  if (has(src, 'analogIds')) {
    if (!Array.isArray(src.analogIds)) throw new Reject('Аналоги: ожидался список')
    out.analogIds = src.analogIds.slice(0, 500).map((x: any) => id(x, 'аналог'))
  }
  if (has(src, 'image')) {
    const v = text(src.image, 200_000)
    if (!IMAGE.test(v)) throw new Reject('Фото: не тот вид')
    out.image = v
  }
  return out
}
export const PRODUCT_EDIT_FIELDS = ['name', 'barcode', 'category', 'type', 'cost', 'price', 'minStock', 'unit', 'unitsPerPack', 'dosage', 'analogIds', 'image']

export function parseProductCreate(p: any, now?: number) {
  const x = obj(obj(p, 'товар').product, 'товар')
  const f = productFields(x)
  if (!f.name) throw new Reject('Пусто: название товара')
  if (!f.barcode) throw new Reject('Пусто: штрихкод')
  const stock = int(x.stock ?? 0, 'остаток')
  const looseUnits = int(x.looseUnits ?? 0, 'штук во вскрытой')
  const upp = f.unitsPerPack ?? 1
  if (stock * upp + looseUnits > MAX_UNITS) throw new Reject('Недопустимое количество: слишком много')
  return {
    id: id(x.id, 'товар'),
    name: f.name as string,
    barcode: f.barcode as string,
    category: (f.category as string) ?? 'Прочее',
    type: (f.type as string) ?? '',
    cost: (f.cost as number) ?? 0,
    price: (f.price as number) ?? 0,
    minStock: (f.minStock as number) ?? 5,
    unit: (f.unit as string) ?? 'уп',
    unitsPerPack: upp,
    dosage: (f.dosage as string) ?? '',
    analogIds: (f.analogIds as string[]) ?? [],
    image: (f.image as string) ?? '',
    stock,
    looseUnits,
    expiryDate: dateOrNull(x.expiryDate, 'срок годности'),
    createdAt: when(x.createdAt, 'товар', now),
  }
}

export function parseProductUpdate(p: any, now?: number) {
  const root = obj(p, 'правка товара')
  const set = productFields(root.set || {})
  // Остаток, который вписали в карточку: штук всего. explicit — вписали число руками;
  // иначе оно вышло из новой упаковки (штук в упаковке стало больше, упаковок — столько же)
  const stock =
    root.stock === null || root.stock === undefined
      ? null
      : { units: int(obj(root.stock, 'остаток').units, 'остаток', 0, MAX_UNITS), explicit: root.stock.explicit !== false }
  // Срок годности из карточки: пусто — без срока; нет поля — не трогали
  const expiryTouched = Object.prototype.hasOwnProperty.call(root, 'expiryDate')
  return {
    id: id(root.id, 'товар'),
    at: when(root.at, 'правка товара', now),
    set,
    base: baseOf(root.base, PRODUCT_EDIT_FIELDS),
    stock,
    expiryTouched,
    expiryDate: expiryTouched ? dateOrNull(root.expiryDate, 'срок годности') : null,
  }
}

// Удаление чего-либо: что удаляют и когда (по времени решается, не правили ли запись позже)
export function parseRemove(p: any, what: string, now?: number) {
  const root = obj(p, what)
  return { id: id(root.id, what), at: when(root.at, what, now) }
}

// ── Категория и тип товара ──
export function parseCategoryCreate(p: any, now?: number) {
  const c = obj(obj(p, 'категория').category, 'категория')
  return { id: id(c.id, 'категория'), name: nonEmpty(c.name, 40, 'название категории'), noExpiry: c.noExpiry === true, createdAt: when(c.createdAt, 'категория', now) }
}

export function parseCategoryUpdate(p: any, now?: number) {
  const root = obj(p, 'правка категории')
  const src = root.set || {}
  const set: Record<string, any> = {}
  if (has(src, 'name')) set.name = nonEmpty(src.name, 40, 'название категории')
  if (has(src, 'noExpiry')) set.noExpiry = src.noExpiry === true
  return { id: id(root.id, 'категория'), at: when(root.at, 'правка категории', now), set, base: baseOf(root.base, ['name', 'noExpiry']) }
}

export function parseTypeCreate(p: any, now?: number) {
  const c = obj(obj(p, 'тип товара').type, 'тип товара')
  return { id: id(c.id, 'тип товара'), name: nonEmpty(c.name, 40, 'название типа'), analogs: c.analogs === true, createdAt: when(c.createdAt, 'тип товара', now) }
}

export function parseTypeUpdate(p: any, now?: number) {
  const root = obj(p, 'правка типа товара')
  const src = root.set || {}
  const set: Record<string, any> = {}
  if (has(src, 'name')) set.name = nonEmpty(src.name, 40, 'название типа')
  if (has(src, 'analogs')) set.analogs = src.analogs === true
  return { id: id(root.id, 'тип товара'), at: when(root.at, 'правка типа товара', now), set, base: baseOf(root.base, ['name', 'analogs']) }
}

// ── Сервис перевода, статьи расходов и доходов: только завести и убрать ──
// key — где лежит запись в операции, what — как назвать в отказе, max — длина названия
export function parseNamed(p: any, key: string, what: string, max: number, now?: number) {
  const c = obj(obj(p, what)[key], what)
  return { id: id(c.id, what), name: nonEmpty(c.name, max, what), createdAt: when(c.createdAt, what, now) }
}

// ── Поставщик ──
export function parseSupplierCreate(p: any, now?: number) {
  const s = obj(obj(p, 'поставщик').supplier, 'поставщик')
  return {
    id: id(s.id, 'поставщик'),
    name: nonEmpty(s.name, 120, 'название поставщика'),
    phone: text(s.phone, 60).trim(),
    note: text(s.note, 500).trim(),
    openingDebt: money(s.openingDebt ?? 0, 'долг на начало'),
    createdAt: when(s.createdAt, 'поставщик', now),
  }
}

export function parseSupplierUpdate(p: any, now?: number) {
  const root = obj(p, 'правка поставщика')
  const src = root.set || {}
  const set: Record<string, any> = {}
  if (has(src, 'name')) set.name = nonEmpty(src.name, 120, 'название поставщика')
  if (has(src, 'phone')) set.phone = text(src.phone, 60).trim()
  if (has(src, 'note')) set.note = text(src.note, 500).trim()
  return { id: id(root.id, 'поставщик'), at: when(root.at, 'правка поставщика', now), set, base: baseOf(root.base, ['name', 'phone', 'note']) }
}

// Оплата поставщику: деньги уже отданы — из ящика своей смены или мимо кассы
export function parseSupplierPay(p: any, now?: number) {
  const x = obj(obj(p, 'оплата поставщику').payment, 'оплата поставщику')
  const amount = money(x.amount, 'сумма оплаты')
  if (amount <= 0) throw new Reject('Сумма оплаты должна быть больше нуля')
  return {
    id: id(x.id, 'оплата поставщику'),
    supplierId: id(x.supplierId, 'поставщик'),
    amount,
    note: text(x.note, 500).trim(),
    fromCash: x.fromCash === true,
    shiftId: idOrNull(x.shiftId, 'смена'),
    date: when(x.date, 'оплата поставщику', now),
  }
}

// ── Расход и доход: правка ──
const SALARY_MONTH_RE = /^(\d{4}-(0[1-9]|1[0-2]))?$/
const BONUS_DAY_RE = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))?$/
export function parseExpenseUpdate(p: any, now?: number) {
  const root = obj(p, 'правка расхода')
  const src = root.set || {}
  const set: Record<string, any> = {}
  if (has(src, 'category')) set.category = nonEmpty(src.category, 60, 'статья расхода')
  if (has(src, 'amount')) {
    set.amount = money(src.amount, 'сумма расхода')
    if (set.amount <= 0) throw new Reject('Сумма расхода должна быть больше нуля')
  }
  if (has(src, 'note')) set.note = text(src.note, 500).trim()
  if (has(src, 'date')) set.date = when(src.date, 'дата расхода', now)
  if (Object.prototype.hasOwnProperty.call(src, 'employeeId')) set.employeeId = idOrNull(src.employeeId, 'сотрудник')
  if (has(src, 'salaryMonth')) set.salaryMonth = SALARY_MONTH_RE.test(String(src.salaryMonth)) ? String(src.salaryMonth) : ''
  if (has(src, 'bonusFrom')) set.bonusFrom = BONUS_DAY_RE.test(String(src.bonusFrom)) ? String(src.bonusFrom) : ''
  if (has(src, 'bonusTo')) set.bonusTo = BONUS_DAY_RE.test(String(src.bonusTo)) ? String(src.bonusTo) : ''
  return {
    id: id(root.id, 'расход'),
    at: when(root.at, 'правка расхода', now),
    set,
    base: baseOf(root.base, ['category', 'amount', 'note', 'date', 'employeeId', 'salaryMonth', 'bonusFrom', 'bonusTo']),
  }
}

export function parseIncomeUpdate(p: any, now?: number) {
  const root = obj(p, 'правка дохода')
  const src = root.set || {}
  const set: Record<string, any> = {}
  if (has(src, 'category')) set.category = nonEmpty(src.category, 60, 'статья дохода')
  if (has(src, 'amount')) {
    set.amount = money(src.amount, 'сумма дохода')
    if (set.amount <= 0) throw new Reject('Сумма дохода должна быть больше нуля')
  }
  if (has(src, 'note')) set.note = text(src.note, 500).trim()
  if (has(src, 'date')) set.date = when(src.date, 'дата дохода', now)
  return { id: id(root.id, 'доход'), at: when(root.at, 'правка дохода', now), set, base: baseOf(root.base, ['category', 'amount', 'note', 'date']) }
}

// ── Приход: правка ──
// Как на сайте (arrivals/dto.ts, UpdateArrivalDto): строки целиком, каждая со своим номером
export function parseArrivalUpdate(p: any, now?: number) {
  const root = obj(p, 'правка прихода')
  const x = obj(root.arrival, 'правка прихода')
  const items = list(x.items, 'строки прихода', (i) => {
    const exp = dateOrNull(i.expiryDate, 'срок годности')
    return {
      id: id(i.id, 'строка прихода'),
      qty: int(i.qty, 'упаковки', 0),
      pieces: i.pieces === undefined || i.pieces === null ? 0 : int(i.pieces, 'штуки', 0, 99_999),
      cost: money(i.cost, 'закупочная цена'),
      expiryDate: exp ? exp.toISOString() : undefined,
    }
  })
  return {
    id: id(x.id, 'приход'),
    at: when(root.at, 'правка прихода', now),
    supplier: x.supplier === undefined || x.supplier === null ? undefined : text(x.supplier, 200),
    // Пустая строка — убрать поставщика; не прислано — оставить как было
    supplierId: x.supplierId === undefined ? undefined : x.supplierId === '' || x.supplierId === null ? '' : id(x.supplierId, 'поставщик'),
    debt: x.debt === undefined || x.debt === null ? undefined : money(x.debt, 'долг поставщику'),
    items,
  }
}

// ════════════════════════ Инвентаризация (версия 1.4.15) ════════════════════════
// Лист на весь склад — это тысячи строк; насчитанное — целое число штук (у весового —
// граммов), пусто — «ещё не считали»
const INV_MAX_LINES = 20000
const INV_MAX_UNITS = 2_000_000_000
const invCount = (v: any, what: string): number | null => (v === null || v === undefined || v === '' ? null : int(v, what, 0, INV_MAX_UNITS))

export function parseInventoryCreate(p: any, now?: number) {
  const inv = obj(obj(p, 'лист пересчёта').inventory, 'лист пересчёта')
  return {
    id: id(inv.id, 'лист пересчёта'),
    scope: text(inv.scope, 60, 'all').trim() || 'all',
    note: text(inv.note, 500, ''),
    date: when(inv.date, 'лист пересчёта', now),
    items: list(
      inv.items,
      'лист пересчёта',
      (it) => ({
        id: id(it.id, 'строка листа'),
        productId: idOrNull(it.productId, 'товар'),
        // Название — снимок карточки. Карточку с одними пробелами сайт принимает, и лист
        // кассы из-за неё отвергаться не должен — а с ним и весь пересчёт без связи
        name: text(it.name, 300, '').trim() || '—',
        expectedUnits: int(it.expectedUnits, 'по учёту', 0, INV_MAX_UNITS),
        cost: money(it.cost ?? 0, 'закупочная цена'),
        actualUnits: invCount(it.actualUnits, 'по факту'),
      }),
      INV_MAX_LINES,
    ),
  }
}

// Пересчёт и применение: какие строки и сколько насчитали, когда (момент на кассе). У строки
// может быть свой момент: её посчитала соседняя касса по сети, а применила эта
function parseCounts(p: any, what: string, now?: number) {
  const root = obj(p, what)
  const raw = root.items === undefined || root.items === null ? [] : root.items
  if (!Array.isArray(raw) || raw.length > INV_MAX_LINES) throw new Reject(`Нет позиций: ${what}`)
  const at = when(root.at, what, now)
  return {
    id: id(root.id, 'лист пересчёта'),
    at,
    items: raw.map((it: any) => {
      const x = obj(it, what)
      const own = x.at === undefined || x.at === null ? undefined : when(x.at, what, now)
      return { id: id(x.id, 'строка листа'), actualUnits: invCount(x.actualUnits, 'по факту'), ...(own ? { at: own } : {}) }
    }),
  }
}
export const parseInventoryCount = (p: any, now?: number) => parseCounts(p, 'пересчёт', now)
export const parseInventoryApply = (p: any, now?: number) => parseCounts(p, 'применение пересчёта', now)
