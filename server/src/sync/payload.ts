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
] as const
export type OpType = (typeof OP_TYPES)[number]

// Что касса может прислать только от имени владельца — как и на сайте
export const FOUNDER_ONLY: ReadonlySet<string> = new Set(['writeoff', 'expense'])

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
  const items = list(a.items, 'позиции прихода', (i) => ({
    id: id(i.id, 'позиция прихода'),
    productId: id(i.productId, 'товар'),
    name: text(i.name, 300),
    qty: int(i.qty, 'упаковки', 1),
    cost: money(i.cost, 'закупочная цена'),
  }))
  const expiry = Array.isArray(root.expiry) ? root.expiry : []
  const total = money(a.total, 'сумма прихода')
  // Неоплаченная часть — долг поставщику. Больше самого прихода она не бывает
  const debt = money(a.debt ?? 0, 'долг поставщику')
  if (debt > total + 0.01) throw new Reject('Долг поставщику больше суммы прихода')
  return {
    id: id(a.id, 'приход'),
    date: when(a.date, 'приход', now),
    supplier: text(a.supplier, 200) || '—',
    supplierId: idOrNull(a.supplierId, 'поставщик'),
    debt,
    total,
    items: items.map((it, n) => ({ ...it, expiryDate: dateOrNull(expiry[n], 'срок годности') })),
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
