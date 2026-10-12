import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { WriteOffsService } from './writeoffs.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateWriteOffDto } from './dto'

// Списание — это убыток, поэтому доступно только основателю
@Controller('writeoffs')
export class WriteOffsController {
  constructor(private readonly writeOffs: WriteOffsService) {}

  // Журнал читают и отчёты с панелью: без списаний прибыль в них была бы завышена
  @Get()
  @Perm('writeoffs.view', 'reports.view', 'dashboard.view')
  findAll(@Query() q: PeriodQuery) {
    return this.writeOffs.findAll(q)
  }

  @Post()
  @Perm('writeoffs.create')
  create(@Body() dto: CreateWriteOffDto, @CurrentUser() u: any) {
    return this.writeOffs.create(dto, u?.tenantUserId)
  }
}
