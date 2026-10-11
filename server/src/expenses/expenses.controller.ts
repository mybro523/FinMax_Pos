import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ExpensesService } from './expenses.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateExpenseCategoryDto, CreateExpenseDto, UpdateExpenseDto } from './dto'

// Расходы — это деньги аптеки и её чистая прибыль: раздел только для основателя,
// как отчёты и списания
@Controller('expenses')
@Roles('founder')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  findAll(@Query() q: PeriodQuery) {
    return this.expenses.findAll(q)
  }

  // Объявлена до адресов с :id, иначе «cash-sources» разобралось бы как номер расхода
  @Get('cash-sources')
  cashSources() {
    return this.expenses.cashSources()
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() u: any) {
    return this.expenses.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expenses.update(id, dto)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.expenses.remove(id)
  }
}

// Статьи расходов — свой адрес: список нужен и разделу расходов, и настройкам
@Controller('expense-categories')
@Roles('founder')
export class ExpenseCategoriesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  findAll() {
    return this.expenses.categories()
  }

  @Post()
  create(@Body() dto: CreateExpenseCategoryDto) {
    return this.expenses.addCategory(dto)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.expenses.removeCategory(id)
  }
}
