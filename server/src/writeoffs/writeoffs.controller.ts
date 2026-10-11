import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { WriteOffsService } from './writeoffs.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateWriteOffDto } from './dto'

// Списание — это убыток, поэтому доступно только основателю
@Controller('writeoffs')
export class WriteOffsController {
  constructor(private readonly writeOffs: WriteOffsService) {}

  @Get()
  @Roles('founder')
  findAll(@Query() q: PeriodQuery) {
    return this.writeOffs.findAll(q)
  }

  @Post()
  @Roles('founder')
  create(@Body() dto: CreateWriteOffDto, @CurrentUser() u: any) {
    return this.writeOffs.create(dto, u?.tenantUserId)
  }
}
