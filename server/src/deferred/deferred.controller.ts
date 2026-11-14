import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { DeferredService } from './deferred.service'
import { CreateDeferredDto } from './dto'
import { Modul, Perm } from '../auth/decorators'


// Модуль «Отложенные штрихкоды» выключен (1.8.1) — раздела нет, и касса не откладывает
@Modul('deferred')
@Controller('deferred')
export class DeferredController {
  constructor(private readonly deferred: DeferredService) {}

  @Get()
  findAll() {
    return this.deferred.findAll()
  }

  @Post()
  @Perm('pos.defer', 'deferred.manage')
  add(@Body() dto: CreateDeferredDto) {
    return this.deferred.add(dto.barcode)
  }

  @Delete(':id')
  @Perm('deferred.manage')
  remove(@Param('id') id: string) {
    return this.deferred.remove(id)
  }
}
