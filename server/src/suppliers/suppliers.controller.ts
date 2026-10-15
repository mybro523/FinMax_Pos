import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { SuppliersService } from './suppliers.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { hasPerm } from '../auth/permissions'
import { PeriodQuery } from '../common/period'
import { CreateSupplierDto, PaySupplierDto, UpdateSupplierDto } from './dto'

// ── Кто что может с поставщиками ──
// Список и заведение открыты всем: приход оформляет и кассир, а привезти может новый
// поставщик. Долги, оплаты и правка — дело владельца: это деньги магазина.
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  findAll(@CurrentUser() u: any) {
    return this.suppliers.findAll(hasPerm(u, 'suppliers.view'))
  }

  @Post()
  @Perm('suppliers.edit')
  create(@Body() dto: CreateSupplierDto, @CurrentUser() u: any) {
    return this.suppliers.create(dto, hasPerm(u, 'suppliers.view'))
  }

  // Сводка долгов: всего, скольким поставщикам и сколько приходов в долг.
  // Стоит раньше ':id', иначе «debts» приняли бы за номер поставщика
  @Get('debts')
  @Perm('suppliers.view')
  debts() {
    return this.suppliers.debts()
  }

  @Get(':id')
  @Perm('suppliers.view')
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(id)
  }

  @Patch(':id')
  @Perm('suppliers.edit')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto)
  }

  @Delete(':id')
  @Perm('suppliers.delete')
  remove(@Param('id') id: string) {
    return this.suppliers.remove(id)
  }

  @Post(':id/pay')
  @Perm('suppliers.pay')
  pay(@Param('id') id: string, @Body() dto: PaySupplierDto, @CurrentUser() u: any) {
    return this.suppliers.pay(id, dto, u?.tenantUserId)
  }
}

// Журнал оплат поставщикам — отдельным адресом: он нужен смене и обмену с кассами
@Controller('supplier-payments')
@Perm('suppliers.view')

export class SupplierPaymentsController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list(@Query() q: PeriodQuery) {
    return this.suppliers.listPayments(q)
  }

  @Delete(':id')
  @Perm('suppliers.pay')
  remove(@Param('id') id: string) {
    return this.suppliers.removePayment(id)
  }
}
