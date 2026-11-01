import { Controller, Get } from '@nestjs/common'
import { Public } from '../auth/decorators'
import { LicencesService } from '../admin/licences.service'

// ── Открытый ключ кодов — без входа: его берёт сборка программы ──
// Секрета в нём нет: по нему коды только проверяют
@Controller('licence')
@Public()
export class LicenceKeyController {
  constructor(private readonly licences: LicencesService) {}

  @Get('key')
  key() {
    return this.licences.publicKey()
  }
}
