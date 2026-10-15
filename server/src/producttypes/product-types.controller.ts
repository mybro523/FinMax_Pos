import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { Perm } from '../auth/decorators'
import { ProductTypesService } from './product-types.service'
import { CreateProductTypeDto, UpdateProductTypeDto } from './dto'

@Controller('product-types')
export class ProductTypesController {
  constructor(private readonly types: ProductTypesService) {}

  // Читают все: список нужен в карточке товара на кассе и при приёмке
  @Get()
  findAll() {
    return this.types.findAll()
  }

  // Менять список — тем же правом, что и категории: это одна и та же настройка склада
  @Post()
  @Perm('settings.categories')
  create(@Body() dto: CreateProductTypeDto) {
    return this.types.create(dto)
  }

  @Patch(':id')
  @Perm('settings.categories')
  update(@Param('id') id: string, @Body() dto: UpdateProductTypeDto) {
    return this.types.update(id, dto)
  }

  @Delete(':id')
  @Perm('settings.categories')
  remove(@Param('id') id: string) {
    return this.types.remove(id)
  }
}
