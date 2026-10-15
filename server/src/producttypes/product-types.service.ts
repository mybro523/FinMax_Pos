import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { TX } from '../common/tx'
import { CreateProductTypeDto, UpdateProductTypeDto } from './dto'

// ── Типы товаров ──
// Медицинский, продукты, бытовая химия… Список ведёт владелец, как категории; у
// товара тип хранится названием. Отметка «с аналогами» решает, показывать ли в
// карточке поле аналогов: у лекарства замены ищут, у шампуня — нет.
const EXISTS = 'Такой тип товара уже есть'

@Injectable()
export class ProductTypesService {
  private readonly log = new Logger('ProductTypes')
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.productType.findMany({ orderBy: { name: 'asc' } })
  }

  async create(dto: CreateProductTypeDto) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название типа товара')
    try {
      return await this.prisma.productType.create({ data: { name, analogs: !!dto.analogs } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException(EXISTS)
      throw e
    }
  }

  async update(id: string, dto: UpdateProductTypeDto) {
    const type = await this.prisma.productType.findUnique({ where: { id } })
    if (!type) throw new NotFoundException('Тип товара не найден')
    const name = dto.name === undefined ? type.name : (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название типа товара')
    try {
      // Переименование и перенос товаров — одной операцией, как у категорий: при
      // сбое посередине часть товаров осталась бы с типом, которого нет
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productType.update({
          where: { id },
          data: { name, analogs: dto.analogs === undefined ? type.analogs : !!dto.analogs },
        })
        if (name !== type.name) {
          const moved = await tx.product.updateMany({ where: { type: type.name }, data: { type: name } })
          if (moved.count) this.log.log(`Тип «${type.name}» → «${name}»: перенесено товаров ${moved.count}`)
        }
        return updated
      }, TX)
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException(EXISTS)
      throw e
    }
  }

  async remove(id: string) {
    const type = await this.prisma.productType.findUnique({ where: { id } })
    if (!type) throw new NotFoundException('Тип товара не найден')
    // Товар не должен остаться с типом, которого нет в списке
    const used = await this.prisma.product.count({ where: { type: type.name } })
    if (used > 0) {
      throw new BadRequestException(`Тип «${type.name}» стоит у ${used} товар(ов) — сначала смените им тип`)
    }
    await this.prisma.productType.delete({ where: { id } })
    return { ok: true }
  }
}
