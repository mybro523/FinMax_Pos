import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { Perm } from '../auth/decorators'

// ── Сервисы перевода ──
// Через что покупатели переводят деньги: Alif, DC, Эсхата… На кассе кассир выбирает
// сервис, в отчётах переводы видны по каждому отдельно — так их сверяют с выпиской.
// Готовый список заводит миграция, свои владелец добавляет здесь. Чек хранит сервис
// названием: убрали сервис — прежние чеки остаются как были.

export class CreatePayServiceDto {
  @IsString() @MinLength(1) @MaxLength(40) name: string
}

@Injectable()
export class PayServicesService {
  constructor(private prisma: PrismaService) {}

  list() {
    return this.prisma.payService.findMany({ orderBy: [{ ord: 'asc' }, { name: 'asc' }] })
  }

  async create(dto: CreatePayServiceDto) {
    const name = dto.name.trim()
    if (!name) throw new BadRequestException('Укажите название сервиса')
    const last = await this.prisma.payService.aggregate({ _max: { ord: true } })
    try {
      return await this.prisma.payService.create({ data: { name, ord: (last._max.ord ?? 0) + 1 } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException('Такой сервис уже есть')
      throw e
    }
  }

  async remove(id: string) {
    const s = await this.prisma.payService.findUnique({ where: { id } })
    if (!s) throw new NotFoundException('Сервис не найден')
    await this.prisma.payService.delete({ where: { id } })
    return { ok: true }
  }
}

// Список нужен кассе — всем; менять его может владелец
@Controller('pay-services')
export class PayServicesController {
  constructor(private readonly services: PayServicesService) {}

  @Get()
  list() {
    return this.services.list()
  }

  @Post()
  @Perm('settings.payServices')

  create(@Body() dto: CreatePayServiceDto) {
    return this.services.create(dto)
  }

  @Delete(':id')
  @Perm('settings.payServices')

  remove(@Param('id') id: string) {
    return this.services.remove(id)
  }
}

@Module({ controllers: [PayServicesController], providers: [PayServicesService] })
export class PayServicesModule {}
