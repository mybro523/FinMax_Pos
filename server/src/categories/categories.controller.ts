import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { CategoriesService } from './categories.service'
import { Perm } from '../auth/decorators'
import { CreateCategoryDto, UpdateCategoryDto } from './dto'

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  // Читают все: список нужен кассиру в карточке товара и при приёмке
  @Get()
  findAll() {
    return this.categories.findAll()
  }

  // Менять список — дело владельца: категория задаёт структуру всего склада
  @Post()
  @Perm('settings.categories')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto)
  }

  @Patch(':id')
  @Perm('settings.categories')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto)
  }

  @Delete(':id')
  @Perm('settings.categories')
  remove(@Param('id') id: string) {
    return this.categories.remove(id)
  }
}
