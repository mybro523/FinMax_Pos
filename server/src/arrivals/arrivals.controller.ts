import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ArrivalsService } from './arrivals.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateArrivalDto, UpdateArrivalDto } from './dto'

// ── Кто что может с приходом ──
// Оформить приход может и кассир: привезти могут в его смену, и ждать владельца
// значит держать товар в коробке. А вот переписать или стереть уже оформленный
// приход — только владелец. Иначе недостачу легко спрятать: поправил вчерашний
// приход, и остаток на полке «сошёлся» с учётом.
@Controller('arrivals')
export class ArrivalsController {
  constructor(private readonly arrivals: ArrivalsService) {}

  @Get()
  findAll(@Query() q: PeriodQuery) {
    return this.arrivals.findAll(q)
  }

  // Один приход с подробностями для правки: сколько от каждой строки
  // уже продано и ниже чего нельзя опускать количество
  @Get(':id')
  @Roles('founder')
  findOne(@Param('id') id: string) {
    return this.arrivals.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateArrivalDto, @CurrentUser() u: any) {
    return this.arrivals.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  @Roles('founder')
  update(@Param('id') id: string, @Body() dto: UpdateArrivalDto) {
    return this.arrivals.update(id, dto)
  }

  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.arrivals.remove(id)
  }
}
