import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { ReturnsService } from './returns.service'
import { CurrentUser } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateReturnDto } from './dto'

// Возврат оформляет кассир (клиент стоит у кассы), но каждый записан на его имя
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  findAll(@Query() q: PeriodQuery) {
    return this.returns.findAll(q)
  }

  @Post()
  create(@Body() dto: CreateReturnDto, @CurrentUser() u: any) {
    return this.returns.create(dto, u?.tenantUserId)
  }
}
