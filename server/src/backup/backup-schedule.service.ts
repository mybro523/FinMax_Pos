import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { gzipSync } from 'node:zlib'
import { AdminDbService } from '../admin/admin-db.service'
import { runInTenant } from '../prisma/tenant-context'
import { BackupService } from './backup.service'
import { backupTarget, BackupTarget } from './backup-storage'
import { dayKeyTj } from '../common/time'

// ── Копии, которые снимаются сами ──
// Пока магазин один, потеря данных — разговор с одним клиентом. Когда их тридцать,
// это конец сервиса. Владелец магазина делать копии руками не будет: он занят
// магазином, а не нами, и вспомнит о копии ровно тогда, когда она уже нужна.
//
// Поэтому раз в сутки сервер обходит все магазины сам.
//
// ── Про час запуска ──
// Ночь по Душанбе: касса закрыта, база свободна. Проверяем раз в час, а не ставим
// таймер до нужного момента: перезапуск сервиса обнулил бы такой таймер, и копия
// не снялась бы вовсе — молча.
//
// ── Про имена ──
// Файлы называются по кругу: ячейка на каждый день из последних N. Пятнадцатая
// копия ложится на место первой, и хранилище не растёт бесконечно само по себе.
// Так не нужно ни перечислять его содержимое, ни удалять из него — а значит,
// и ключ доступа хватает самый скромный, только на запись.

const HOUR_MS = 3600_000
const RUN_HOUR = Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR ?? 3))) // ночь по Душанбе
const KEEP = Math.max(2, Number(process.env.BACKUP_KEEP ?? 14))

@Injectable()
export class BackupScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('BackupAuto')
  private timer: NodeJS.Timeout | null = null
  private target: BackupTarget | null = null
  private lastRunDay = ''
  private running = false
  private last: { at: string; ok: string[]; failed: string[] } | null = null

  constructor(private admin: AdminDbService, private backup: BackupService) {}

  onModuleInit() {
    this.target = backupTarget()
    if (!this.target) {
      // Молчать здесь нельзя: владелец сервиса должен знать, что копий нет.
      // Хуже отсутствующих копий только копии, в которые верят.
      this.log.warn(
        'АВТОМАТИЧЕСКИЕ КОПИИ ВЫКЛЮЧЕНЫ: не задано, куда их складывать. ' +
          'Укажите BACKUP_S3_* (внешнее хранилище) или BACKUP_DIR (подключённый том). ' +
          'Сейчас данные магазинов защищены только копиями, которые владельцы делают руками.',
      )
      return
    }
    this.log.log(`Автоматические копии включены: ${this.target.kind}, ${this.target.where}, храним ${KEEP} последних`)
    this.tick()
    this.timer = setInterval(() => this.tick(), HOUR_MS)
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  // Раз в час смотрим, не пора ли. Ровно один раз в сутки, даже если сервер
  // за это время перезапускался несколько раз.
  private tick() {
    if (!this.target || this.running) return
    const now = new Date()
    const today = dayKeyTj(now)
    if (this.lastRunDay === today) return
    // Час по Душанбе
    const hourTj = new Date(now.getTime() + 5 * HOUR_MS).getUTCHours()
    if (hourTj !== RUN_HOUR) return

    this.lastRunDay = today
    this.runAll().catch((e) => this.log.error('снятие копий не удалось: ' + (e?.message || e)))
  }

  status() {
    return {
      enabled: !!this.target,
      target: this.target ? `${this.target.kind}: ${this.target.where}` : null,
      hour: RUN_HOUR,
      keep: KEEP,
      running: this.running,
      last: this.last,
    }
  }

  // Обойти все магазины и снять с каждой копию. По очереди: одновременные выгрузки
  // всех схем разом упрутся в предел подключений, а спешить ночью некуда.
  async runAll(): Promise<{ ok: string[]; failed: string[] }> {
    if (!this.target) throw new Error('Не задано, куда складывать копии')
    if (this.running) return { ok: [], failed: [] }
    this.running = true

    const ok: string[] = []
    const failed: string[] = []
    try {
      const list = await this.admin.pharmacy.findMany({
        select: { code: true, schemaName: true },
        orderBy: { code: 'asc' },
      })
      this.log.log(`Снимаю копии: магазинов ${list.length}`)

      for (const ph of list) {
        try {
          const dump = await runInTenant(ph.schemaName, () => this.backup.dump())
          const body = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
          const slot = String(this.slotOf() ).padStart(2, '0')
          await this.target.put(`apteka/${ph.code}/den-${slot}.json.gz`, body, 'application/gzip')
          // Отдельно кладём последнюю: чтобы забрать свежую копию, не надо знать,
          // какая ячейка сегодня
          await this.target.put(`apteka/${ph.code}/poslednyaya.json.gz`, body, 'application/gzip')
          await this.target.prune?.(`apteka/${ph.code}`, KEEP + 1)
          ok.push(ph.code)
          this.log.log(`«${ph.code}»: копия снята, ${(body.length / 1024).toFixed(0)} КБ`)
        } catch (e: any) {
          failed.push(ph.code)
          this.log.error(`«${ph.code}»: копия НЕ снята — ${e?.message || e}`)
        }
      }

      this.last = { at: new Date().toISOString(), ok, failed }
      if (failed.length) this.log.error(`Копии сняты: ${ok.length}. НЕ УДАЛОСЬ: ${failed.join(', ')}`)
      else this.log.log(`Копии сняты у всех магазинов: ${ok.length}`)
      return { ok, failed }
    } finally {
      this.running = false
    }
  }

  // Ячейка на сегодня: день от начала эпохи по кругу. Пятнадцатая копия ложится
  // на место первой — хранилище не растёт, и удалять ничего не нужно.
  private slotOf(now: Date = new Date()): number {
    return Math.floor((now.getTime() + 5 * HOUR_MS) / 86400000) % KEEP
  }
}
