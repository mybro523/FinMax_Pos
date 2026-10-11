import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { SuppliersService } from './suppliers.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateSupplierDto, PaySupplierDto, UpdateSupplierDto } from './dto'

// ── Кто что может с поставщиками ──
// Список и заведение открыты всем: приход оформляет и кассир, а привезти может новый
// поставщик. Долги, оплаты и правка — дело владельца: это деньги аптеки.
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  findAll(@CurrentUser() u: any) {
    return this.suppliers.findAll(u?.role === 'founder')
  }

  @Post()
  create(@Body() dto: CreateSupplierDto, @CurrentUser() u: any) {
    return this.suppliers.create(dto, u?.role === 'founder')
  }

  @Get(':id')
  @Roles('founder')
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(id)
  }

  @Patch(':id')
  @Roles('founder')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto)
  }

  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.suppliers.remove(id)
  }

  @Post(':id/pay')
  @Roles('founder')
  pay(@Param('id') id: string, @Body() dto: PaySupplierDto, @CurrentUser() u: any) {
    return this.suppliers.pay(id, dto, u?.tenantUserId)
  }
}

// Журнал оплат поставщикам — отдельным адресом: он нужен смене и обмену с кассами
@Controller('supplier-payments')
@Roles('founder')
export class SupplierPaymentsController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list(@Query() q: PeriodQuery) {
    return this.suppliers.listPayments(q)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.suppliers.removePayment(id)
  }
}
