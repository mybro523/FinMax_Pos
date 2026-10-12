import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { InventoryService } from './inventory.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { ApplyInventoryDto, CreateInventoryDto, SaveCountDto } from './dto'

// Пересчёт остатков — только основатель
@Controller('inventory')

export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Perm('inventory.view')
  findAll() {
    return this.inventory.findAll()
  }

  // Один лист — чтобы открыть его свежим или узнать, применён ли он, не скачивая
  // всю историю пересчётов со всеми строками. С wait=1 ответ придёт после того, как
  // закончится идущее сохранение или применение этого листа
  @Get(':id')
  @Perm('inventory.view')
  findOne(@Param('id') id: string, @Query('wait') wait?: string) {
    return this.inventory.findOne(id, wait === '1')
  }

  @Post()
  @Perm('inventory.count')
  create(@Body() dto: CreateInventoryDto, @CurrentUser() u: any) {
    return this.inventory.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  @Perm('inventory.count')
  saveCount(@Param('id') id: string, @Body() dto: SaveCountDto) {
    return this.inventory.saveCount(id, dto)
  }

  @Post(':id/apply')
  @Perm('inventory.apply')
  apply(@Param('id') id: string, @Body() dto: ApplyInventoryDto, @CurrentUser() u: any) {
    return this.inventory.apply(id, u?.tenantUserId, dto?.items)
  }

  @Delete(':id')
  @Perm('inventory.count')
  remove(@Param('id') id: string) {
    return this.inventory.remove(id)
  }
}
