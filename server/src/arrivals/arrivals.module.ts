import { Module } from '@nestjs/common'
import { ArrivalsService } from './arrivals.service'
import { ArrivalsController } from './arrivals.controller'

@Module({
  controllers: [ArrivalsController],
  providers: [ArrivalsService],
})
export class ArrivalsModule {}
