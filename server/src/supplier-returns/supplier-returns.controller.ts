import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { SupplierReturnsService } from './supplier-returns.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateSupplierReturnDto } from './dto'

// ── Возврат товара поставщику ──
// Журнал видит тот, кому открыт приход товара; оформить — отдельное право «возврат
// поставщику»; удалить — как и приход: «изменить и удалить» (по умолчанию владелец)
@Controller('supplier-returns')
export class SupplierReturnsController {
  constructor(private readonly returns: SupplierReturnsService) {}

  @Get()
  @Perm('arrivals.view')
  findAll(@Query() q: PeriodQuery) {
    return this.returns.findAll(q)
  }

  @Post()
  @Perm('arrivals.return')
  create(@Body() dto: CreateSupplierReturnDto, @CurrentUser() u: any) {
    return this.returns.create(dto, u?.tenantUserId)
  }

  @Delete(':id')
  @Perm('arrivals.edit')
  remove(@Param('id') id: string) {
    return this.returns.remove(id)
  }
}
