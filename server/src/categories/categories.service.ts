import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { TX } from '../common/tx'
import { CreateCategoryDto, UpdateCategoryDto } from './dto'

// ── Категории товаров ──
// Списком управляет владелец. У товара категория хранится названием, поэтому
// переименование обязано пройтись по товарам — иначе они «выпадут» из фильтров
// и из охвата пересчёта остатков.

// С этого списка начинает новый магазин: он переносится в базу при первом запуске.
// Список нарочно общий — магазин, супермаркет и хозтовары заводят свои категории в настройках
const STARTING = [
  { name: 'Продукты' },
  { name: 'Напитки' },
  { name: 'Бытовая химия' },
  { name: 'Косметика' },
  { name: 'Хозтовары', noExpiry: true },
  { name: 'Канцтовары', noExpiry: true },
  { name: 'Прочее', noExpiry: true },
]

@Injectable()
export class CategoriesService {
  private readonly log = new Logger('Categories')
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } })
  }

  async create(dto: CreateCategoryDto) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название категории')
    try {
      return await this.prisma.category.create({ data: { name, noExpiry: !!dto.noExpiry } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Такая категория уже есть')
      }
      throw e
    }
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const cat = await this.prisma.category.findUnique({ where: { id } })
    if (!cat) throw new NotFoundException('Категория не найдена')

    const name = dto.name === undefined ? cat.name : (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название категории')

    try {
      // Переименование и перенос товаров — одной операцией: иначе при сбое
      // посередине часть товаров осталась бы в несуществующей категории.
      // Товаров в категории могут быть сотни, поэтому время берём с запасом.
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.category.update({
          where: { id },
          data: { name, noExpiry: dto.noExpiry === undefined ? cat.noExpiry : !!dto.noExpiry },
        })
        if (name !== cat.name) {
          const moved = await tx.product.updateMany({ where: { category: cat.name }, data: { category: name } })
          if (moved.count) this.log.log(`Категория «${cat.name}» → «${name}»: перенесено товаров ${moved.count}`)
        }
        return updated
      }, TX)
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Категория с таким названием уже есть')
      }
      throw e
    }
  }

  async remove(id: string) {
    const cat = await this.prisma.category.findUnique({ where: { id } })
    if (!cat) throw new NotFoundException('Категория не найдена')

    // Товар не должен остаться в категории, которой нет: иначе он пропадёт
    // из фильтров и из пересчёта остатков
    const used = await this.prisma.product.count({ where: { category: cat.name } })
    if (used > 0) {
      throw new BadRequestException(
        `В категории «${cat.name}» ${used} товар(ов) — сначала перенесите их в другую категорию`,
      )
    }
    await this.prisma.category.delete({ where: { id } })
    return { ok: true }
  }

  // Первый запуск: заводим стартовый список и всё, что уже стоит у товаров,
  // чтобы ни одна существующая категория не потерялась
  async ensureSeeded() {
    try {
      const have = await this.prisma.category.count()
      const used = await this.prisma.product.findMany({ select: { category: true }, distinct: ['category'] })
      const fromProducts = used.map((p) => (p.category || '').trim()).filter(Boolean)

      const wanted = new Map<string, boolean>()
      if (have === 0) STARTING.forEach((c) => wanted.set(c.name, !!c.noExpiry))
      fromProducts.forEach((n) => {
        if (!wanted.has(n)) wanted.set(n, false)
      })
      if (!wanted.size) return

      const existing = await this.prisma.category.findMany({ select: { name: true } })
      const known = new Set(existing.map((c) => c.name))
      const rows = [...wanted].filter(([name]) => !known.has(name)).map(([name, noExpiry]) => ({ name, noExpiry }))
      if (!rows.length) return

      await this.prisma.category.createMany({ data: rows, skipDuplicates: true })
      this.log.log(`Категории заведены: ${rows.map((r) => r.name).join(', ')}`)
    } catch (e: any) {
      this.log.error('ensureSeeded failed: ' + (e?.message || e))
    }
  }
}
