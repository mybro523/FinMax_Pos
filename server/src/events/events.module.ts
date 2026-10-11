import { Global, Module } from '@nestjs/common'
import { EventsGateway } from './events.gateway'
import { ChangeStamp } from './change-stamp.service'
import { AuthModule } from '../auth/auth.module'

// Глобальный: оповещать об изменениях нужно почти из каждого раздела,
// и подключать этот модуль в каждый по отдельности было бы лишним шумом.
@Global()
@Module({
  imports: [AuthModule],
  providers: [EventsGateway, ChangeStamp],
  exports: [EventsGateway, ChangeStamp],
})
export class EventsModule {}
