import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { expiryFrom, lockProducts, setUnits, syncProduct, totalUnits } from '../common/stock'
import { TX } from '../common/tx'
import { CreateProductDto, UpdateProductDto } from './dto'
import { markCounted } from '../common/counted'
import { PeriodQuery } from '../common/period'
import { productHistory } from './history'

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.product.findMany({ orderBy: { name: 'asc' } })
  }

  findByBarcode(barcode: string) {
    return this.prisma.product.findUnique({ where: { barcode } })
  }

  // Приводим срок годности к Date|null (пустое/битое -> null), нормализуем аналоги
  private buildData(dto: CreateProductDto | UpdateProductDto) {
    const data: any = { ...dto }
    if ('expiryDate' in data) {
      const d = data.expiryDate ? expiryFrom(data.expiryDate) : null
      data.expiryDate = d && !isNaN(d.getTime()) ? d : null
    }
    if ('analogIds' in data && !Array.isArray(data.analogIds)) data.analogIds = []
    return data
  }

  async create(dto: CreateProductDto) {
    const data = this.buildData(dto)
    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({ data })
        // Товар заведён — убираем его штрихкод из «отложенных», если он там был
        await tx.deferredBarcode.deleteMany({ where: { barcode: product.barcode } })
        // Начальный остаток из карточки сразу кладём в партию, иначе продажа
        // не увидит товар: она списывает именно из партий
        const units = totalUnits(product)
        if (units > 0) {
          await tx.batch.create({
            data: { productId: product.id, units, cost: product.cost, expiryDate: product.expiryDate, note: 'Начальный остаток' },
          })
          // ── Приводим карточку к партии ──
          // Владелец мог вписать «0 упаковок и 13 штук» при десяти в упаковке.
          // Штук столько и есть, но показывались бы они так до первой же продажи,
          // а после неё сами превратились бы в «1 уп + 2 шт»: остаток изменился бы
          // без всякой операции над упаковками. Со стороны это выглядит как ошибка
          // счёта, и доверия к остаткам после такого не остаётся.
          //
          // Правка карточки так уже делает (syncProduct ниже), а заведение — нет.
          // Из-за этого одно и то же число показывалось по-разному.
          await syncProduct(tx, product.id)
          return tx.product.findUnique({ where: { id: product.id } })
        }
        return product
      }, TX)
    } catch (e) {
      throw this.mapError(e)
    }
  }

  async history(id: string, q: PeriodQuery) {
    const product = await this.prisma.product.findUnique({ where: { id } })
    if (!product) throw new NotFoundException('Товар не найден')
    return productHistory(this.prisma, product, q)
  }

  async update(id: string, dto: UpdateProductDto, userId?: string) {
    await this.ensure(id)
    const data = this.buildData(dto)
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Карточка под замком ещё до чтения: продажа, идущая в ту же секунду, иначе
        // изменила бы остаток между «было» и «стало» — и правка одной цены выглядела бы
        // как правка остатка
        await lockProducts(tx, [id])
        const was = await tx.product.findUnique({ where: { id }, select: { stock: true, looseUnits: true, unitsPerPack: true } })
        const product = await tx.product.update({ where: { id }, data })

        // Остаток и срок, исправленные вручную в карточке, обязательно доводим
        // до партий — иначе касса продолжит видеть старое количество.
        const touchesStock = ['stock', 'looseUnits', 'unitsPerPack', 'expiryDate'].some((k) => k in data)
        if (touchesStock) {
          // Число на полке поправили руками — это тот же пересчёт, только одного товара:
          // всё, что случилось раньше, этим числом уже учтено (см. common/counted.ts)
          const asked = ['stock', 'looseUnits', 'unitsPerPack'].some((k) => k in data)
          if (asked && was && totalUnits(was) !== totalUnits(product)) {
            await markCounted(tx, [{ productId: id }])
            // И след в истории товара: иначе остаток менялся бы «сам», без движения
            await tx.stockEdit.create({ data: { productId: id, fromUnits: totalUnits(was), toUnits: totalUnits(product), userId: userId ?? null } })
          }
          const batches = await tx.batch.findMany({ where: { productId: id }, orderBy: { createdAt: 'asc' } })
          const target = totalUnits(product)

          if (batches.length === 0) {
            if (target > 0) {
              await tx.batch.create({
                data: { productId: id, units: target, cost: product.cost, expiryDate: product.expiryDate, note: 'Остаток из карточки' },
              })
            }
          } else if (batches.length === 1) {
            // Одна партия — просто приводим её к тому, что указано в карточке
            await tx.batch.update({
              where: { id: batches[0].id },
              data: { units: target, expiryDate: product.expiryDate },
            })
          } else {
            // Партий несколько (разные сроки) — выравниваем общее количество,
            // сроки при этом остаются за партиями, их задаёт приход
            const have = batches.reduce((s, b) => s + b.units, 0)
            if (have !== target) await setUnits(tx, id, target, product.name)
          }
          await syncProduct(tx, id)
        }

        return tx.product.findUnique({ where: { id } })
      }, TX)
    } catch (e) {
      throw this.mapError(e)
    }
  }

  // Дубликат штрихкода (@unique) -> понятная 409 вместо 500
  private mapError(e: any) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException('Товар с таким штрихкодом уже существует')
    }
    return e
  }

  async remove(id: string) {
    await this.ensure(id)
    await this.prisma.product.delete({ where: { id } })
    return { ok: true }
  }

  private async ensure(id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } })
    if (!p) throw new NotFoundException('Товар не найден')
  }
}
