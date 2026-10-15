import { Body, Controller, Delete, Get, Param, Patch, Post, Query, ForbiddenException } from '@nestjs/common'
import { ArrivalsService } from './arrivals.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { hasPerm } from '../auth/permissions'
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

  // Журнал приходов — закупочные цены магазина: только тем, кому открыт раздел
  @Get()
  @Perm('arrivals.view')
  findAll(@Query() q: PeriodQuery) {
    return this.arrivals.findAll(q)
  }

  // Один приход с подробностями для правки: сколько от каждой строки
  // уже продано и ниже чего нельзя опускать количество
  @Get(':id')
  @Perm('arrivals.view')
  findOne(@Param('id') id: string) {
    return this.arrivals.findOne(id)
  }

  @Post()
  @Perm('arrivals.create')
  create(@Body() dto: CreateArrivalDto, @CurrentUser() u: any) {
    // Приход в долг поставщику — отдельное право: это обязательство магазина
    if ((dto.debt || 0) > 0 && !hasPerm(u, 'arrivals.debt')) throw new ForbiddenException('Нет права оформлять приход в долг')

    return this.arrivals.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  @Perm('arrivals.edit')
  update(@Param('id') id: string, @Body() dto: UpdateArrivalDto) {
    return this.arrivals.update(id, dto)
  }

  @Delete(':id')
  @Perm('arrivals.edit')
  remove(@Param('id') id: string) {
    return this.arrivals.remove(id)
  }
}
