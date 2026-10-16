import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { WEB_SHIFT, withDeviceNames } from './shifts.service'

type Tx = Prisma.TransactionClient

// ── Открытая смена, из ящика которой берут или в который кладут деньги ──
// Расход из кассы, оплата поставщику из кассы, внесение и изъятие наличных — всё это
// живёт в открытой смене. Правила общие:
//   • смена берётся под замок и только потом читается: закрытие, идущее в ту же
//     секунду, либо дождётся операции и посчитает её, либо закроет смену первым —
//     и операция получит отказ. «Деньги записаны в уже закрытую смену» не бывает;
//   • касса не указана — это смена сайта. Владелец с сайта может назвать и смену
//     кассы с программой: деньги взяты из её ящика.

export const NO_OPEN_SHIFT = 'Нет открытой смены — расход из кассы привязать не к чему. Откройте смену или снимите отметку «из кассы».'
// Продажа без открытой смены не проводится: чек обязан попасть в отчёт смены. Текст
// слово в слово повторяет касса в программе (desktop/src/local/ops/sale.mjs) и сайт
export const NO_SHIFT_SALE = 'Сначала откройте смену: без открытой смены продажа невозможна.'
export const NO_OPEN_SHIFT_CASH = 'Нет открытой смены — внести или изъять наличные не из чего. Откройте смену.'
export const SHIFT_CLOSED = 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.'
export const SHIFT_CLOSED_CASH = 'Смена этой операции уже закрыта: она вошла в её отчёт и больше не меняется.'

export async function lockShift(tx: Tx, shiftId: string) {
  const rows = await tx.$queryRaw<{ id: string; closedAt: Date | null; deviceId: string | null }[]>`
    SELECT "id", "closedAt", "deviceId" FROM "Shift" WHERE "id" = ${shiftId} FOR UPDATE`
  return rows[0] || null
}

export async function openShiftFor(tx: Tx, shiftId: string | undefined, noShift = NO_OPEN_SHIFT) {
  const id = shiftId || (await tx.shift.findFirst({ where: WEB_SHIFT, select: { id: true } }))?.id
  if (!id) throw new BadRequestException(noShift)
  const shift = await lockShift(tx, id)
  if (!shift) throw new BadRequestException('Смена не найдена')
  if (shift.closedAt) throw new BadRequestException(noShift)
  return shift.id
}

// Открытые смены — из каких ящиков можно взять деньги. Владельцу — все (сайт и кассы
// с программой), кассиру — только смена сайта: кассы с программой не его
export async function cashSources(db: Prisma.TransactionClient | { shift: any; device: any }, founder: boolean) {
  const open = await (db as any).shift.findMany({
    where: founder ? { closedAt: null } : { ...WEB_SHIFT },
    orderBy: { openedAt: 'asc' },
  })
  return (await withDeviceNames(db as any, open)).map((s: any) => ({
    shiftId: s.id,
    deviceId: s.deviceId,
    deviceName: s.deviceName || '',
    openedAt: s.openedAt,
  }))
}
