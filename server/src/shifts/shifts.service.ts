import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { shiftTotals } from './totals'
import { mayCloseShift, NOT_YOUR_SHIFT, ShiftCloser } from './closer'

// ── Смена на сайте и смена на кассе ──
// У программы для Windows смена своя на каждой кассе (поле deviceId): без интернета
// касса не может знать, открыта ли смена на соседней. Всё, что делается через сайт,
// по-прежнему работает с одной общей сменой — той, у которой deviceId пуст.
// Поэтому каждое обращение ниже ищет именно её: иначе сайт принял бы смену кассы
// за свою, стал бы привязывать к ней чеки и закрыл бы её вместо кассира.
export const WEB_SHIFT = { closedAt: null, deviceId: null } as const

// У смены кассы — имя кассы («Касса 2»): владелец отличает их не по номерам из
// тридцати шести знаков. У смен сайта поля нет вовсе.
export async function withDeviceNames<T extends { deviceId: string | null }>(
  db: { device: { findMany: (args: any) => Promise<{ id: string; name: string }[]> } },
  shifts: T[],
): Promise<(T & { deviceName?: string })[]> {
  const ids = [...new Set(shifts.map((s) => s.deviceId).filter((x): x is string => !!x))]
  if (!ids.length) return shifts
  const names = new Map((await db.device.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
  return shifts.map((s) => (s.deviceId ? { ...s, deviceName: names.get(s.deviceId) || '' } : s))
}

@Injectable()
export class ShiftsService {
  constructor(private prisma: PrismaService) {}

  // Все смены (открытая + история), новые сверху, с именем кассира.
  // Открытые смены касс сюда не входят: сайт считает открытой ту смену, что видит
  // в списке, а смена кассы — не его. В историю она попадёт, когда закроется.
  async findAll() {
    const shifts = await this.prisma.shift.findMany({
      where: { OR: [{ closedAt: { not: null } }, { deviceId: null }] },
      orderBy: { openedAt: 'desc' },
      include: { user: { select: { id: true, name: true } } },
    })
    return withDeviceNames(this.prisma, shifts)
  }

  current() {
    return this.prisma.shift.findFirst({ where: WEB_SHIFT })
  }

  async open(openingCash: number, userId?: string) {
    const existing = await this.current()
    if (existing) throw new BadRequestException('Смена уже открыта')
    try {
      return await this.prisma.shift.create({ data: { openingCash: D(openingCash), userId: userId ?? null } })
    } catch (e) {
      // Проверка выше не спасает от гонки: два кассира могут нажать «Открыть смену»
      // одновременно. Последнее слово за базой — частичный уникальный индекс
      // (см. SeedService.ensureOneOpenShift) не даст записать вторую открытую смену.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Смена уже открыта')
      }
      throw e
    }
  }

  // Закрытие смены читает ВСЕ чеки смены с позициями, все погашения долгов и все
  // возвраты с позициями. К вечеру загруженного дня это сотни записей, и стандартных
  // пяти секунд Prisma не хватает: кассир не может закрыть смену и уйти домой,
  // а видит невнятный отказ базы. Даём столько же времени, сколько продаже.
  async close(countedCash: number, actor?: ShiftCloser) {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findFirst({ where: WEB_SHIFT })
      if (!shift) throw new BadRequestException('Нет открытой смены')
      // Чужую смену закрывает только тот, кому это разрешено (см. closer.ts)
      if (actor && !mayCloseShift(shift, actor)) throw new BadRequestException(NOT_YOUR_SHIFT)
      // Смена — под замок: расход из кассы, который вносят в эту же секунду, берёт тот
      // же замок. Либо он успеет раньше и войдёт в итоги, либо увидит смену закрытой и
      // получит отказ — «расход записан, а в отчёте смены его нет» не бывает
      await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id" = ${shift.id} FOR UPDATE`

      const totals = await shiftTotals(tx, shift, countedCash)

      // Условное закрытие: если смену уже закрыл параллельный запрос — count=0
      const r = await tx.shift.updateMany({
        where: { id: shift.id, closedAt: null },
        data: { closedAt: new Date(), ...totals },
      })
      if (r.count !== 1) throw new BadRequestException('Смена уже закрыта')

      return tx.shift.findUnique({ where: { id: shift.id }, include: { user: { select: { id: true, name: true } } } })
    }, TX)
  }
}
