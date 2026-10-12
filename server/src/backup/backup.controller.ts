import { Body, Controller, Get, Post } from '@nestjs/common'
import { BackupScheduleService } from './backup-schedule.service'
import { BackupService } from './backup.service'
import { Perm } from '../auth/decorators'

// Резервные копии — только основатель: в файле вся коммерческая информация аптеки
@Controller('backup')
@Perm('settings.backup')
export class BackupController {
  constructor(private readonly backup: BackupService, private readonly schedule: BackupScheduleService) {}

  // Состояние автоматических копий: куда складываются, когда снимались, что вышло.
  // Владелец аптеки должен видеть это сам — иначе «копии же делаются» остаётся
  // верой, а не знанием.
  @Get('auto')
  auto() {
    return this.schedule.status()
  }

  @Get()
  dump() {
    return this.backup.dump()
  }

  @Post('restore')
  restore(@Body() body: { dump: any; confirm: string }) {
    return this.backup.restore(body?.dump, body?.confirm)
  }
}
