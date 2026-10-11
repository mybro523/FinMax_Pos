import { Module } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { CustomersController } from './customers.controller'
import { PaymentsController } from './payments.controller'

@Module({
  controllers: [CustomersController, PaymentsController],
  providers: [CustomersService],
})
export class CustomersModule {}
