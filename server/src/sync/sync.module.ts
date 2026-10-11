import { Module } from '@nestjs/common'
import { DiscrepancyController, SyncController } from './sync.controller'
import { SyncService } from './sync.service'
import { SyncJanitorService } from './sync-janitor.service'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [AuthModule],
  controllers: [SyncController, DiscrepancyController],
  providers: [SyncService, SyncJanitorService],
})
export class SyncModule {}
