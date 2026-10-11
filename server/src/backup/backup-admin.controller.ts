import { Controller, Get, Post } from '@nestjs/common'
import { BackupScheduleService } from './backup-schedule.service'
import { Roles, ServiceWide } from '../auth/decorators'

// Автоматические копии глазами владельца сервиса: они его забота, а не аптек.
// Кнопка «снять сейчас» нужна не для порядка: после настройки хранилища хочется
// убедиться, что копии в него действительно доезжают, а не ждать до ночи.
@Controller('admin/backups')
@ServiceWide()
@Roles('superadmin')
export class BackupAdminController {
  constructor(private readonly schedule: BackupScheduleService) {}

  @Get()
  status() {
    return this.schedule.status()
  }

  @Post('run')
  run() {
    return this.schedule.runAll()
  }
}
