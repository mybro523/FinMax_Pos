import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common'
import { SyncService } from './sync.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { CloseDeviceShiftDto, PullQuery, PushDto, RenameDeviceDto } from './dto'

// ── Обмен с кассами, которые работают без интернета ──
// Сайту эти адреса не нужны: он всегда на связи и пишет прямо в свои разделы.
// Ими пользуется программа для Windows — присылает сделанное без связи и забирает
// изменившееся. Подписка и доступ проверяются общим сторожем, как у любого раздела:
// каждый обмен — это и проверка, что аптеке ещё можно работать.
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  // Ключ кассы идёт заголовком: в адресе запроса ему не место — адреса пишутся в журналы
  @Post('push')
  push(@Body() dto: PushDto, @CurrentUser() u: any, @Headers('x-device-key') key?: string) {
    return this.sync.push(dto, u, key)
  }

  @Get('pull')
  pull(@Query() q: PullQuery, @CurrentUser() u: any, @Headers('x-device-key') key?: string) {
    return this.sync.pull(q, u, key)
  }

  // Давний чек и возвраты по нему — чтобы касса оформила возврат у себя
  @Get('sale/:id')
  sale(@Param('id') id: string) {
    return this.sync.saleForReturn(id)
  }

  // Кассы аптеки: какие есть и когда выходили на связь
  @Get('devices')
  @Roles('founder')
  devices() {
    return this.sync.devices()
  }

  @Patch('devices/:id')
  @Roles('founder')
  rename(@Param('id') id: string, @Body() dto: RenameDeviceDto) {
    return this.sync.renameDevice(id, dto.name)
  }

  // Смену кассы, которая сама её уже не закроет (компьютер сломался), закрывает владелец
  @Post('devices/:id/close-shift')
  @Roles('founder')
  closeShift(@Param('id') id: string, @Body() dto: CloseDeviceShiftDto) {
    return this.sync.closeDeviceShift(id, dto.countedCash)
  }

  // Журнал движений товара: что приходило и уходило и сколько по журналу на полке
  @Get('moves/:productId')
  @Roles('founder')
  moves(@Param('productId') productId: string) {
    return this.sync.moves(productId)
  }
}

// ── Расхождения ──
// Список для владельца: где присланное кассой не сошлось с тем, что знает сервер, —
// продано больше, чем было; цена в чеке не та, что была в базе; вернули больше,
// чем продали.
@Controller('discrepancies')
@Roles('founder')
export class DiscrepancyController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  list() {
    return this.sync.discrepancies()
  }

  // Владелец разобрался (пересчитал полку, поговорил с кассиром) — запись уходит из списка
  @Post(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.sync.resolveDiscrepancy(id)
  }
}
