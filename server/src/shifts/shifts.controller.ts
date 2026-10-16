import { Body, Controller, Get, Post } from '@nestjs/common'
import { ShiftsService } from './shifts.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { OpenShiftDto, CloseShiftDto } from './dto'

@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  findAll() {
    return this.shifts.findAll()
  }

  @Post('open')
  @Perm('shift.open')
  open(@Body() dto: OpenShiftDto, @CurrentUser() u: any) {
    return this.shifts.open(dto.openingCash, u?.tenantUserId)
  }

  // Закрыть можно свою смену; чужую — с правом «закрыть смену другого сотрудника»
  @Post('close')
  @Perm('shift.open')
  close(@Body() dto: CloseShiftDto, @CurrentUser() u: any) {
    return this.shifts.close(dto.countedCash, { role: u?.role, permissions: u?.permissions, tenantUserId: u?.tenantUserId ?? null })
  }
}
