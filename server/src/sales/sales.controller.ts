import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { SalesService } from './sales.service'
import { CurrentUser } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CheckoutDto } from './dto'

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  // ?days=60 — свежие продажи для кассы; ?from=&to= — период для отчётов;
  // ?days=0 — всё время
  @Get()
  findAll(@Query() q: PeriodQuery) {
    return this.sales.findAll(q)
  }

  @Post()
  checkout(@Body() dto: CheckoutDto, @CurrentUser() u: any) {
    return this.sales.checkout(dto, u?.tenantUserId)
  }
}
