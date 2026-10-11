import { Module } from '@nestjs/common'
import { DeferredService } from './deferred.service'
import { DeferredController } from './deferred.controller'

@Module({
  controllers: [DeferredController],
  providers: [DeferredService],
})
export class DeferredModule {}
