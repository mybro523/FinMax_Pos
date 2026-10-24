import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { expiryFrom, lockProducts, setUnits, syncProduct, totalUnits, uppOf } from '../common/stock'
import { lockInventories } from '../common/counted'
import { costFromBatches } from '../common/cost'
import { TX } from '../common/tx'
import { CreateProductDto, UpdateProductDto } from './dto'
import { markCounted } from '../common/counted'
import { PeriodQuery } from '../common/period'
import { changedFields, forgetStamps, stamp } from '../common/stamps'
import { productHistory } from './history'

type Tx = Prisma.TransactionClient

// Поля карточки, у которых сервер помнит время последней правки (common/stamps.ts):
// по ним решается, чья правка новее, когда карточку поправили и на кассе без связи, и
// на сайте. Остаток и срок годности сюда не входят — они живут партиями
export const PRODUCT_CARD_FIELDS = ['name', 'barcode', 'category', 'type', 'cost', 'price', 'minStock', 'unit', 'unitsPerPack', 'dosage', 'analogIds', 'image'] as const

export const BARCODE_TAKEN = 'Товар с таким штрихкодом уже существует'

// Приводим срок годности к Date|null (пустое/битое -> null), нормализуем аналоги
export function productData(dto: Record<string, any>) {
  const data: any = { ...dto }
  if ('expiryDate' in data) {
    const d = data.expiryDate ? expiryFrom(data.expiryDate) : null
    data.expiryDate = d && !isNaN(d.getTime()) ? d : null
  }
  if ('analogIds' in data && !Array.isArray(data.analogIds)) data.analogIds = []
  return data
}

// ── Завести товар ──
// Общая часть для сайта и для товара, заведённого на кассе без связи (sync)
export async function createProductIn(tx: Tx, data: Prisma.ProductUncheckedCreateInput) {
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
}

// ── Срок годности из карточки ──
// Срок хранит партия. Если партия одна — её срок и правят; партий нет, а остаток есть —
// заводится партия с этим сроком. Партий несколько (разные сроки) — их сроки задаёт
// приход, а не карточка
export async function setCardExpiry(tx: Tx, productId: string, expiryDate: Date | null) {
  const product = await tx.product.findUnique({ where: { id: productId } })
  if (!product) return
  const batches = await tx.batch.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } })
  const target = totalUnits(product)
  if (batches.length === 0) {
    if (target > 0) {
      await tx.batch.create({ data: { productId, units: target, cost: product.cost, expiryDate, note: 'Остаток из карточки' } })
    }
  } else if (batches.length === 1) {
    await tx.batch.update({ where: { id: batches[0].id }, data: { expiryDate } })
  }
  await syncProduct(tx, productId)
}

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.product.findMany({ orderBy: { name: 'asc' } })
  }

  findByBarcode(barcode: string) {
    return this.prisma.product.findUnique({ where: { barcode } })
  }

  async create(dto: CreateProductDto) {
    const data = productData(dto)
    try {
      return await this.prisma.$transaction((tx) => createProductIn(tx, data), TX)
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
    const data = productData(dto)
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Карточка под замком ещё до чтения: продажа, идущая в ту же секунду, иначе
        // изменила бы остаток между «было» и «стало» — и правка одной цены выглядела бы
        // как правка остатка
        await lockProducts(tx, [id])
        const was = await tx.product.findUnique({ where: { id } })
        const product = await tx.product.update({ where: { id }, data })
        // Когда правили поля карточки: касса без связи сверит по этому свою правку
        if (was) await stamp(tx, 'Product', id, changedFields(was, data, PRODUCT_CARD_FIELDS))

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
      return new ConflictException(BARCODE_TAKEN)
    }
    return e
  }

  async remove(id: string) {
    await this.ensure(id)
    await this.prisma.$transaction(async (tx) => {
      await tx.product.delete({ where: { id } })
      await forgetStamps(tx, 'Product', id)
    }, TX)
    return { ok: true }
  }

  // ── Объединить две карточки одного товара ──
  // Бывает, что один товар заведён дважды: касса без связи завела его со штрихкодом,
  // который за это время заняли на сайте, и сервер дал ей внутренний код (sync). Владелец
  // видит дубль в «Расхождениях» и объединяет карточки: партии, чеки, приходы, возвраты,
  // списания и пересчёты лишней переходят к основной, а лишняя удаляется. Остаток —
  // сумма обеих, закупочная цена — по партиям, цена продажи и название — основной.
  // Чеки и документы хранят название и цены снимком, поэтому история не меняется
  async merge(fromId: string, intoId: string) {
    if (!fromId || !intoId || fromId === intoId) throw new BadRequestException('Выберите две разные карточки')
    const merged = await this.prisma.$transaction(async (tx) => {
      // Замки — одним заходом и по порядку номеров (lockProducts): обе карточки и те, у кого
      // лишняя записана в аналогах (их списки ниже правятся)
      const analogRefs = await tx.product.findMany({ where: { analogIds: { has: fromId } }, select: { id: true } })
      // Листы пересчёта с этими товарами — раньше товаров, как у применения листа
      // (inventory.service): применение, которое уже идёт, доделается со строками как были,
      // а не обойдёт строку лишней карточки, и встречные замки друг друга не запрут
      const sheets = await tx.inventoryItem.findMany({ where: { productId: { in: [fromId, intoId] } }, select: { inventoryId: true }, distinct: ['inventoryId'] })
      await lockInventories(tx, sheets.map((s) => s.inventoryId))
      await lockProducts(tx, [fromId, intoId, ...analogRefs.map((r) => r.id)])
      const [from, into] = await Promise.all([tx.product.findUnique({ where: { id: fromId } }), tx.product.findUnique({ where: { id: intoId } })])
      if (!from || !into) throw new NotFoundException('Товар не найден')
      // Партия хранит штуки. Если упаковки разные, штуки лишней карточки весили бы иначе
      if (uppOf(from) !== uppOf(into)) {
        throw new BadRequestException(`Штук в упаковке у карточек разное (${uppOf(from)} и ${uppOf(into)}) — сначала поправьте карточку`)
      }
      // Применённый пересчёт, где есть обе карточки: строки сливаются в одну — иначе поздняя
      // операция кассы поправляла бы недостачу по строке одной карточки, а списание у него уже
      // на обе. Ожидаемое и насчитанное складываются; не считали ни одну — строка остаётся
      // несчитанной. В незаконченном листе строки только переходят к основной карточке: кассы
      // без связи ещё присылают насчитанное по своим номерам строк, и удалённая строка его
      // потеряла бы. Сольются они при применении (inventory.service, joinDuplicateLines)
      const lines = await tx.inventoryItem.findMany({ where: { productId: { in: [fromId, intoId] }, inventory: { status: 'applied' } } })
      for (const a of lines.filter((d) => d.productId === intoId)) {
        const b = lines.find((d) => d.productId === fromId && d.inventoryId === a.inventoryId)
        if (!b) continue
        const actual = a.actualUnits === null && b.actualUnits === null ? null : (a.actualUnits ?? 0) + (b.actualUnits ?? 0)
        await tx.inventoryItem.update({ where: { id: a.id }, data: { expectedUnits: a.expectedUnits + b.expectedUnits, actualUnits: actual } })
        await tx.inventoryItem.delete({ where: { id: b.id } })
      }
      const move = { where: { productId: fromId }, data: { productId: intoId } }
      await tx.batch.updateMany(move)
      await tx.saleItem.updateMany(move)
      await tx.arrivalItem.updateMany(move)
      await tx.saleReturnItem.updateMany(move)
      await tx.writeOffItem.updateMany(move)
      await tx.supplierReturnItem.updateMany(move)
      await tx.inventoryItem.updateMany(move)
      await tx.stockEdit.updateMany(move)
      // Журнал движений партий — тоже: партии перешли к основной, их прошлые движения с ними
      await tx.stockMove.updateMany(move)
      // Отметки пересчёта лишней карточки не переносим намеренно: её пересчёт не учитывал
      // поздних чеков основной карточки с других касс, и с её отметкой они не вычлись бы
      const batches = await tx.batch.findMany({ where: { productId: intoId } })
      await tx.product.update({ where: { id: intoId }, data: { cost: costFromBatches(batches, uppOf(into), into.cost) } })
      await syncProduct(tx, intoId)
      // Аналоги: кто ссылался на лишнюю карточку, ссылается на основную; аналоги лишней
      // переходят к основной. Ссылки на себя и повторы убираются
      const refs = await tx.product.findMany({ where: { analogIds: { has: fromId } }, select: { id: true, analogIds: true } })
      for (const r of refs) {
        if (r.id === intoId) continue
        const next = [...new Set(r.analogIds.map((x) => (x === fromId ? intoId : x)))].filter((x) => x !== r.id)
        await tx.product.update({ where: { id: r.id }, data: { analogIds: next } })
        await stamp(tx, 'Product', r.id, ['analogIds'])
      }
      const ownAnalogs = [...new Set([...into.analogIds, ...from.analogIds])].filter((x) => x !== intoId && x !== fromId)
      if (ownAnalogs.length !== into.analogIds.length || ownAnalogs.some((x, i) => x !== into.analogIds[i])) {
        await tx.product.update({ where: { id: intoId }, data: { analogIds: ownAnalogs } })
        await stamp(tx, 'Product', intoId, ['analogIds'])
      }
      await tx.product.delete({ where: { id: fromId } })
      await forgetStamps(tx, 'Product', fromId)
      // Основная карточка изменилась (на ней теперь партии обеих): удаление с кассы, сделанное
      // без связи раньше объединения, её не тронет (sync/edits.ts, «правили позже удаления»)
      await stamp(tx, 'Product', intoId, ['merge'])
      // Операции касс, которые ещё ссылаются на лишнюю карточку (пробиты без связи до
      // объединения), лягут на основную — см. псевдонимы в sync
      await tx.syncMeta.upsert({
        where: { key: 'alias:product:' + fromId },
        update: { value: intoId },
        create: { key: 'alias:product:' + fromId, value: intoId },
      })
      // Расхождения про этот дубль разобраны; остальные расхождения лишней карточки — теперь
      // про основную (названия в них записаны снимком и не меняются)
      await tx.discrepancy.updateMany({ where: { kind: 'barcode', productId: { in: [fromId, intoId] }, resolvedAt: null }, data: { resolvedAt: new Date() } })
      await tx.discrepancy.updateMany({ where: { productId: fromId }, data: { productId: intoId } })
      return tx.product.findUnique({ where: { id: intoId } })
    }, TX)
    return merged
  }

  private async ensure(id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } })
    if (!p) throw new NotFoundException('Товар не найден')
  }
}
