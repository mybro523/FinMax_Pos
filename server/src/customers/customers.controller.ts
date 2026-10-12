import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { Perm } from '../auth/decorators'
import { CreateCustomerDto, PayDebtDto } from './dto'

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  findAll() {
    return this.customers.findAll()
  }

  @Post()
  @Perm('customers.create')
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto)
  }

  @Post(':id/pay')
  @Perm('debts.pay')
  pay(@Param('id') id: string, @Body() dto: PayDebtDto) {
    return this.customers.payDebt(id, dto.amount)
  }

  // Удаление стирает и долг клиента, и всю историю его погашений — это уже не
  // работа кассы, а решение владельца. Заводить клиента и принимать оплату долга
  // кассир по-прежнему может: без этого не продать в долг и не принять деньги.
  @Delete(':id')
  @Perm('customers.delete')
  remove(@Param('id') id: string) {
    return this.customers.remove(id)
  }
}
