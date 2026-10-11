import { Controller, Get, Query } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { PeriodQuery } from '../common/period'

// Отдельный ресурс истории погашений: GET /api/payments
@Controller('payments')
export class PaymentsController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  findAll(@Query() q: PeriodQuery) {
    return this.customers.listPayments(q)
  }
}
