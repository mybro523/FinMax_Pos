import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { CurrentUser, Perm } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { SkladService } from './sklad.service'
import { SkladEditDto, SkladToShopDto } from './dto'

// ── Склад (1.8.0) ──
@Controller('sklad')
export class SkladController {
  constructor(private readonly sklad: SkladService) {}

  // Остатки склада видят: сам раздел, панель управления (карточка «Остаток на складе»)
  // и приход («Свой склад» показывает, сколько есть)
  @Get()
  @Perm('sklad.view', 'sklad.move', 'dashboard.view', 'arrivals.view', 'arrivals.create')
  findAll() {
    return this.sklad.findAll()
  }

  @Get('moves')
  @Perm('sklad.view', 'sklad.move')
  moves(@Query() q: PeriodQuery) {
    return this.sklad.moves(q)
  }

  @Post('to-shop')
  @Perm('sklad.move')
  toShop(@Body() dto: SkladToShopDto, @CurrentUser() u: any) {
    return this.sklad.toShop(dto, u?.tenantUserId)
  }

  @Post('edit')
  @Perm('sklad.move')
  edit(@Body() dto: SkladEditDto, @CurrentUser() u: any) {
    return this.sklad.edit(dto, u?.tenantUserId)
  }
}
