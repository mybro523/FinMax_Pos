import { Body, Controller, Get, Post } from '@nestjs/common'
import { ShiftsService } from './shifts.service'
import { CurrentUser } from '../auth/decorators'
import { OpenShiftDto, CloseShiftDto } from './dto'

@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  findAll() {
    return this.shifts.findAll()
  }

  @Post('open')
  open(@Body() dto: OpenShiftDto, @CurrentUser() u: any) {
    return this.shifts.open(dto.openingCash, u?.tenantUserId)
  }

  @Post('close')
  close(@Body() dto: CloseShiftDto) {
    return this.shifts.close(dto.countedCash)
  }
}
