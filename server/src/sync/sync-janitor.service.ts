import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AdminDbService } from '../admin/admin-db.service'
import { runInTenant } from '../prisma/tenant-context'
import { SyncService } from './sync.service'

// ── Уборка журналов обмена ──
// Журнал изменений и журнал движений товара пишет сама база — у каждой аптеки, есть
// у неё кассы с программой для Windows или нет. Подчищает их обмен с кассой. Но
// аптека, которая работает только через сайт, не обменивается никогда: её журнал
// рос бы вечно, по сотне мегабайт в год, и никто бы этого не заметил, пока не
// кончилось место.
//
// Поэтому раз в час обходим все аптеки сами. Уборка у каждой случается не чаще раза
// в сутки (за этим следит pruneIfDue), так что обход почти всегда ничего не делает.

const EVERY_MS = 60 * 60 * 1000
// Не сразу после запуска: в первые минуты сервер обновляет схемы аптек
const FIRST_MS = 10 * 60 * 1000

@Injectable()
export class SyncJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SyncJanitor')
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running = false

  constructor(private admin: AdminDbService, private sync: SyncService) {}

  onModuleInit() {
    const run = () => this.sweep().catch((e) => this.log.error('уборка журналов не удалась: ' + (e?.message || e)))
    this.first = setTimeout(run, FIRST_MS)
    this.timer = setInterval(run, EVERY_MS)
    // Уборка не должна удерживать процесс при остановке сервера
    this.first.unref?.()
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
  }

  // По очереди: спешить некуда, а подключений к базе не так много. Сорвавшаяся
  // аптека не останавливает остальные (pruneIfDue свои ошибки не выпускает наружу)
  async sweep(): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      const list = await this.admin.pharmacy.findMany({ select: { code: true, schemaName: true } })
      for (const ph of list) {
        try {
          await runInTenant(ph.schemaName, () => this.sync.pruneIfDue())
        } catch (e: any) {
          this.log.error(`«${ph.code}»: уборка журналов не удалась — ${e?.message || e}`)
        }
      }
      return list.length
    } finally {
      this.running = false
    }
  }
}
