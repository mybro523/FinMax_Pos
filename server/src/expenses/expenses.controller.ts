import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ExpensesService } from './expenses.service'
import { CurrentUser, Modul, Perm } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateExpenseCategoryDto, CreateExpenseDto, UpdateExpenseDto } from './dto'

// Расходы — это деньги магазина и его чистая прибыль: раздел только для основателя,
// как отчёты и списания
@Controller('expenses')

export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  // Журнал читают и отчёты: чистая прибыль считается за вычетом расходов
  @Get()
  // Модули (1.8.1): журнал читают и отчёты — закрыт, только когда выключены все
  @Modul('expenses', 'salesReport', 'opu')
  @Perm('expenses.view', 'reports.view')
  findAll(@Query() q: PeriodQuery) {
    return this.expenses.findAll(q)
  }

  // Объявлена до адресов с :id, иначе «cash-sources» разобралось бы как номер расхода
  @Get('cash-sources')
  @Modul('expenses')
  @Perm('expenses.create')
  cashSources() {
    return this.expenses.cashSources()
  }

  // Сотрудники с окладом и бонусом — для расхода «Зарплата». Оклады видят только те,
  // кто вносит или правит расходы
  @Get('staff')
  @Modul('expenses')
  @Perm('expenses.create', 'expenses.edit')
  staff() {
    return this.expenses.staff()
  }

  @Post()
  @Modul('expenses')
  @Perm('expenses.create')
  create(@Body() dto: CreateExpenseDto, @CurrentUser() u: any) {
    return this.expenses.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  @Modul('expenses')
  @Perm('expenses.edit')
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expenses.update(id, dto)
  }

  @Delete(':id')
  @Modul('expenses')
  @Perm('expenses.edit')
  remove(@Param('id') id: string) {
    return this.expenses.remove(id)
  }
}

// Статьи расходов — свой адрес: список нужен и разделу расходов, и настройкам
@Modul('expenses')
@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly expenses: ExpensesService) {}

  // Статьи нужны тем, кто вносит или смотрит расходы, и тем, кто их настраивает
  @Get()
  @Perm('expenses.view', 'expenses.create', 'settings.expenseCategories')
  findAll() {
    return this.expenses.categories()
  }

  @Post()
  @Perm('settings.expenseCategories')
  create(@Body() dto: CreateExpenseCategoryDto) {
    return this.expenses.addCategory(dto)
  }

  @Delete(':id')
  @Perm('settings.expenseCategories')
  remove(@Param('id') id: string) {
    return this.expenses.removeCategory(id)
  }
}
