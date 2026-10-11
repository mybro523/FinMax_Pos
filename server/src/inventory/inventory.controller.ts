import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { InventoryService } from './inventory.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { ApplyInventoryDto, CreateInventoryDto, SaveCountDto } from './dto'

// Пересчёт остатков — только основатель
@Controller('inventory')
@Roles('founder')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  findAll() {
    return this.inventory.findAll()
  }

  // Один лист — чтобы открыть его свежим или узнать, применён ли он, не скачивая
  // всю историю пересчётов со всеми строками. С wait=1 ответ придёт после того, как
  // закончится идущее сохранение или применение этого листа
  @Get(':id')
  findOne(@Param('id') id: string, @Query('wait') wait?: string) {
    return this.inventory.findOne(id, wait === '1')
  }

  @Post()
  create(@Body() dto: CreateInventoryDto, @CurrentUser() u: any) {
    return this.inventory.create(dto, u?.tenantUserId)
  }

  @Patch(':id')
  saveCount(@Param('id') id: string, @Body() dto: SaveCountDto) {
    return this.inventory.saveCount(id, dto)
  }

  @Post(':id/apply')
  apply(@Param('id') id: string, @Body() dto: ApplyInventoryDto, @CurrentUser() u: any) {
    return this.inventory.apply(id, u?.tenantUserId, dto?.items)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.inventory.remove(id)
  }
}
