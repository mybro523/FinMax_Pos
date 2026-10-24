import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ProductsService } from './products.service'
import { CurrentUser, Perm } from '../auth/decorators'
import { hasPerm } from '../auth/permissions'
import { PeriodQuery } from '../common/period'
import { CreateProductDto, MergeProductDto, UpdateProductDto } from './dto'

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
  @Perm('products.create')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto)
  }

  // История движения товара: приход, продажа, возврат, списание, пересчёт, правка
  // остатка — одним списком. Только владельцу: там и списания, и закупочные цены
  @Get(':id/history')
  @Perm('products.history')
  history(@Param('id') id: string, @Query() q: PeriodQuery) {
    return this.products.history(id, q)
  }

  @Patch(':id')
  @Perm('products.edit')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() u: any) {
    return this.products.update(id, dto, u?.tenantUserId)
  }

  @Delete(':id')
  @Perm('products.delete')
  remove(@Param('id') id: string) {
    return this.products.remove(id)
  }

  // Объединить дубль с основной карточкой: лишняя удаляется, её партии и документы
  // переходят к основной. Это и правка, и удаление — нужны оба права
  @Post(':id/merge')
  @Perm('products.edit')
  merge(@Param('id') id: string, @Body() dto: MergeProductDto, @CurrentUser() u: any) {
    if (!hasPerm(u, 'products.delete')) throw new ForbiddenException('Недостаточно прав')
    return this.products.merge(id, dto.into)
  }
}
