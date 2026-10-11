import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ProductsService } from './products.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { PeriodQuery } from '../common/period'
import { CreateProductDto, UpdateProductDto } from './dto'

// ── Кто что может с карточкой товара ──
// Списание одной упаковки было закрыто на владельца, а удалить товар целиком мог
// любой кассир — вместе с карточкой, партиями и следами недостачи. Правка цены была
// открыта так же: цену можно было тихо снизить, продать и вернуть обратно.
// Поэтому изменение и удаление теперь за владельцем.
//
// Создание намеренно остаётся общим: приёмку товара оформляет и кассир, а привезти
// могут то, чего в базе ещё нет. Отнять создание — значит остановить приёмку на
// первом же новом наименовании. На кассе карточку кассир всё равно не заводит:
// незнакомый штрихкод уходит в «Отложенные», и товар оформляет владелец.
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  findAll() {
    return this.products.findAll()
  }

  @Get('barcode/:code')
  findByBarcode(@Param('code') code: string) {
    return this.products.findByBarcode(code)
  }

  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto)
  }

  // История движения товара: приход, продажа, возврат, списание, пересчёт, правка
  // остатка — одним списком. Только владельцу: там и списания, и закупочные цены
  @Get(':id/history')
  @Roles('founder')
  history(@Param('id') id: string, @Query() q: PeriodQuery) {
    return this.products.history(id, q)
  }

  @Patch(':id')
  @Roles('founder')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() u: any) {
    return this.products.update(id, dto, u?.tenantUserId)
  }

  @Delete(':id')
  @Roles('founder')
  remove(@Param('id') id: string) {
    return this.products.remove(id)
  }
}
