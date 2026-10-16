import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { IncomesService } from './incomes.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateIncomeCategoryDto, CreateIncomeDto, UpdateIncomeDto } from './dto'

// Доходы — деньги магазина и его чистый доход: раздел по правам, как расходы
@Controller('incomes')
export class IncomesController {
  constructor(private readonly incomes: IncomesService) {}

  // Журнал читают и отчёты: чистый доход считается вместе с доходами вне продаж
  @Get()
  @Perm('incomes.view', 'reports.view')
  findAll(@Query() q: PeriodQuery) {
    return this.incomes.findAll(q)
  }

  @Post()
  @Perm('incomes.create')
  create(@Body() dto: CreateIncomeDto, @CurrentUser() u: any) {
    return this.incomes.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  @Perm('incomes.edit')
  update(@Param('id') id: string, @Body() dto: UpdateIncomeDto) {
    return this.incomes.update(id, dto)
  }

  @Delete(':id')
  @Perm('incomes.edit')
  remove(@Param('id') id: string) {
    return this.incomes.remove(id)
  }
}

// Статьи доходов — свой адрес: список нужен и разделу доходов, и настройкам
@Controller('income-categories')
export class IncomeCategoriesController {
  constructor(private readonly incomes: IncomesService) {}

  @Get()
  @Perm('incomes.view', 'incomes.create', 'settings.incomeCategories')
  findAll() {
    return this.incomes.categories()
  }

  @Post()
  @Perm('settings.incomeCategories')
  create(@Body() dto: CreateIncomeCategoryDto) {
    return this.incomes.addCategory(dto)
  }

  @Delete(':id')
  @Perm('settings.incomeCategories')
  remove(@Param('id') id: string) {
    return this.incomes.removeCategory(id)
  }
}
