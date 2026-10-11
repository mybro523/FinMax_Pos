import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { CategoriesService } from './categories.service'
import { Roles } from '../auth/decorators'
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
  @Roles('founder')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto)
  }

  @Patch(':id')
  @Roles('founder')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto)
  }

  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.categories.remove(id)
  }
}
