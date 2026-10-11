import { Module } from '@nestjs/common'
import { ShiftsService } from './shifts.service'
import { ShiftsController } from './shifts.controller'
import { CashController, CashMovesController } from './cash.controller'
import { CashService } from './cash.service'

@Module({
  controllers: [ShiftsController, CashController, CashMovesController],
  providers: [ShiftsService, CashService],
})
export class ShiftsModule {}
