import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { Roles } from '../auth/decorators'
import { CreateCustomerDto, PayDebtDto } from './dto'

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  findAll() {
    return this.customers.findAll()
  }

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto)
  }

  @Post(':id/pay')
  pay(@Param('id') id: string, @Body() dto: PayDebtDto) {
    return this.customers.payDebt(id, dto.amount)
  }

  // Удаление стирает и долг клиента, и всю историю его погашений — это уже не
  // работа кассы, а решение владельца. Заводить клиента и принимать оплату долга
  // кассир по-прежнему может: без этого не продать в долг и не принять деньги.
  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.customers.remove(id)
  }
}
