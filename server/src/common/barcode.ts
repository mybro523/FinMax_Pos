import { Prisma } from '@prisma/client'
import { randomInt } from 'node:crypto'

// ── Внутренний штрихкод магазина ──
// Тот же вид, что даёт окно, когда у товара нет заводского кода (client/src/lib/barcode.js):
// EAN-13 с префиксом «2» — он отведён под внутренние коды магазинов и с заводским
// штрихкодом не столкнётся никогда.
//
// Сервер даёт такой код товару, заведённому на кассе без связи, если его штрихкод за это
// время успели занять на сайте или другой кассе: товар и все его чеки принимаются, а
// владелец видит дубль в «Расхождениях» и объединяет карточки.

type Tx = Prisma.TransactionClient

export const INTERNAL_PREFIX = '2'

export function ean13CheckDigit(first12: string): string {
  const d = String(first12).replace(/\D/g, '').slice(0, 12)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d[i] || 0) * (i % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}

export function randomInternalBarcode(): string {
  let body = INTERNAL_PREFIX
  for (let i = 0; i < 11; i++) body += String(randomInt(10))
  return body + ean13CheckDigit(body)
}

// Свободный внутренний код: случайный, пока не найдётся незанятый
export async function freeInternalBarcode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomInternalBarcode()
    if (!(await tx.product.findUnique({ where: { barcode: code }, select: { id: true } }))) return code
  }
  throw new Error('Не удалось подобрать свободный внутренний штрихкод')
}
