import { Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common'
import { SalesService } from './sales.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { hasPerm } from '../auth/permissions'
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
  @Perm('pos.sell')
  checkout(@Body() dto: CheckoutDto, @CurrentUser() u: any) {
    // Скидка и продажа в долг — отдельные права: ими кассир распоряжается деньгами магазина
    if (dto.payment === 'debt' && !hasPerm(u, 'pos.debt')) throw new ForbiddenException('Нет права продавать в долг')
    if ((dto.items || []).some((i) => (i.discount || 0) > 0) && !hasPerm(u, 'pos.discount')) {
      throw new ForbiddenException('Нет права давать скидку')
    }
    return this.sales.checkout(dto, u?.tenantUserId)
  }
}
