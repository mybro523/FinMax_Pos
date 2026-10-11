import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { DeferredService } from './deferred.service'
import { CreateDeferredDto } from './dto'

@Controller('deferred')
export class DeferredController {
  constructor(private readonly deferred: DeferredService) {}

  @Get()
  findAll() {
    return this.deferred.findAll()
  }

  @Post()
  add(@Body() dto: CreateDeferredDto) {
    return this.deferred.add(dto.barcode)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.deferred.remove(id)
  }
}
