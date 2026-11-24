import { Body, Controller, Post } from '@nestjs/common'
import { ResetService } from './reset.service'
import { ResetDataDto } from './dto'
import { Roles } from '../auth/decorators'

// ── Начать с чистого листа (1.8.11) ──
// Только владелец магазина (роль founder). Стирает рабочие данные и справочники,
// оставляя сотрудников и кассы — см. ResetService.
@Controller('reset')
export class ResetController {
  constructor(private readonly reset: ResetService) {}

  @Post('data')
  @Roles('founder')
  wipe(@Body() dto: ResetDataDto) {
    return this.reset.wipeKeepStaff(dto.confirm)
  }
}
