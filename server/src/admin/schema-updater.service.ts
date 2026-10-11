import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { TenantSchemaService } from './tenant-schema.service'

// ── Обновление схем всех аптек ──
// Правка схемы базы — это новый файл миграции. Новая аптека получает его при
// заведении, а вот уже работающие — нет: их схемы созданы раньше. Пока это не
// делается само, каждая правка означала бы обход всех клиентов руками, и первая же
// забытая аптека начала бы отвечать «в базе нет нужного поля» посреди продажи.
//
// ── Почему не при старте сервера ──
// Схем могут быть сотни, каждая по паре секунд. Это десять минут недоступности при
// каждом перезапуске — а перезапуск случается и сам по себе, от переезда сервиса
// на другую машину. Поэтому сервер поднимается сразу и начинает обслуживать
// аптеки, а обновление идёт следом, в фоне.
//
// ── Почему по очереди ──
// Каждая миграция открывает своё подключение к базе. Полсотни разом упрутся в её
// предел, и тогда встанут не только миграции, но и работающие кассы. Спешить здесь
// некуда: аптека на старой схеме работает, просто без самых новых полей.

const START_DELAY_MS = 15_000

@Injectable()
export class SchemaUpdaterService implements OnModuleInit {
  private readonly log = new Logger('SchemaUpdate')
  private running = false
  private last: { at: string; updated: number; failed: string[] } | null = null

  constructor(private admin: AdminDbService, private schemas: TenantSchemaService) {}

  onModuleInit() {
    // Небольшая задержка: пусть сервер сначала спокойно поднимется и ответит
    // на проверку живости, а уже потом займётся фоновой работой
    const timer = setTimeout(() => {
      this.updateAll().catch((e) => this.log.error('обновление схем не удалось: ' + (e?.message || e)))
    }, START_DELAY_MS)
    timer.unref?.()
  }

  // Что сейчас со схемами: какая версия нужна и кто до неё не дотянул
  async status() {
    const target = this.schemas.latestMigration()
    const list = await this.admin.pharmacy.findMany({
      select: { code: true, name: true, schemaName: true, schemaVersion: true },
      orderBy: { code: 'asc' },
    })
    return {
      target,
      running: this.running,
      last: this.last,
      pharmacies: list.map((p) => ({ ...p, upToDate: p.schemaVersion === target })),
      outdated: list.filter((p) => p.schemaVersion !== target).length,
    }
  }

  // Обновить отставшие. Повторный вызов, пока идёт предыдущий, ничего не делает:
  // две миграции одной схемы одновременно — верный способ её сломать.
  async updateAll(force = false): Promise<{ updated: number; failed: string[]; skipped: number }> {
    if (this.running) {
      this.log.log('обновление уже идёт — пропускаю')
      return { updated: 0, failed: [], skipped: 0 }
    }
    const target = this.schemas.latestMigration()
    if (!target) return { updated: 0, failed: [], skipped: 0 }

    this.running = true
    const updated: string[] = []
    const failed: string[] = []
    let skipped = 0

    try {
      const list = await this.admin.pharmacy.findMany({
        select: { id: true, code: true, schemaName: true, schemaVersion: true },
        orderBy: { createdAt: 'asc' },
      })
      const behind = force ? list : list.filter((p) => p.schemaVersion !== target)
      skipped = list.length - behind.length

      if (!behind.length) {
        this.log.log(`Схемы всех аптек в актуальном состоянии (${target})`)
        return { updated: 0, failed: [], skipped }
      }
      this.log.log(`Обновляю схемы аптек до ${target}: ${behind.length} из ${list.length}`)

      for (const ph of behind) {
        try {
          await this.schemas.migrate(ph.schemaName)
          await this.admin.pharmacy.update({ where: { id: ph.id }, data: { schemaVersion: target } })
          updated.push(ph.code)
        } catch (e: any) {
          // Одна упавшая аптека не останавливает остальные: у неё могли просто
          // не сойтись данные под новую миграцию, и разбираться с этим надо
          // отдельно, а не оставлять весь сервис на старой схеме
          failed.push(ph.code)
          this.log.error(`«${ph.code}»: схему обновить не удалось — ${e?.message || e}`)
        }
      }

      this.last = { at: new Date().toISOString(), updated: updated.length, failed }
      if (failed.length) {
        this.log.error(`Схемы обновлены: ${updated.length}. НЕ УДАЛОСЬ: ${failed.join(', ')}`)
      } else {
        this.log.log(`Схемы обновлены у всех отставших аптек: ${updated.length}`)
      }
      return { updated: updated.length, failed, skipped }
    } finally {
      this.running = false
    }
  }
}
