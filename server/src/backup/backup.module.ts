import { Module } from '@nestjs/common'
import { BackupController } from './backup.controller'
import { BackupAdminController } from './backup-admin.controller'
import { BackupService } from './backup.service'
import { BackupScheduleService } from './backup-schedule.service'

// Копии здесь двух видов, и это не дублирование.
//
// Владелец магазина скачивает свою копию руками и хранит у себя — это его страховка
// от нас: если сервис исчезнет вместе с нами, у него на руках останутся его данные.
//
// Сервис снимает копии всех магазинов сам, по ночам, во внешнее хранилище — это наша
// страховка за него: рассчитывать, что тридцать занятых людей будут регулярно
// нажимать кнопку, нельзя.
@Module({
  controllers: [BackupController, BackupAdminController],
  providers: [BackupService, BackupScheduleService],
  exports: [BackupScheduleService],
})
export class BackupModule {}
