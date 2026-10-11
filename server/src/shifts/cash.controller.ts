import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { CashService } from './cash.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CashMoveDto } from './dto'

// Внести и изъять наличные может и кассир: размен кладёт он, выручку отдаёт тоже он.
// Каждая операция записана с именем и видна владельцу в Z-отчёте
@Controller('shifts')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Post('cash')
  create(@Body() dto: CashMoveDto, @CurrentUser() u: any) {
    return this.cash.create(dto, u)
  }

  @Get('cash-sources')
  sources(@CurrentUser() u: any) {
    return this.cash.sources(u?.role === 'founder')
  }
}

@Controller('cash-moves')
export class CashMovesController {
  constructor(private readonly cash: CashService) {}

  @Get()
  list(@Query() q: PeriodQuery) {
    return this.cash.list(q)
  }

  // Отменить ошибочную запись — только владелец и только пока смена открыта
  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.cash.remove(id)
  }
}
