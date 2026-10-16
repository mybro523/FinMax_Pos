import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { TX_LONG } from '../common/tx'
import { forgetCountedAfter } from '../common/counted'

// ── Резервная копия базы ──
// Владелец скачивает один файл со всеми данными магазина и хранит его у себя
// (компьютер, флешка, почта). Если с сервером что-то случится — из этого файла
// можно восстановить товары, продажи, долги и историю.
//
// Главное про копию: поднимать её будут на ДРУГОМ сервере, с пустой базой. Именно
// тогда она и нужна. Поэтому в файле должно лежать всё, на что ссылаются документы,
// а восстановление обязано пережить любые несостыковки — иначе копия есть, а толку
// от неё нет ровно в тот момент, ради которого её делали.
//
// Доступ к программе в копию не попадает вовсе: логины и пароли живут не в магазине,
// а в панели управления сервиса. Файл лежит на флешке, и раздавать с него входы
// нельзя. Поэтому сотрудники восстанавливаются заблокированными — история сохраняет
// имя кассира у каждого чека, а доступ владелец заводит заново в «Сотрудниках».

// 3 — категории и восстановление сотрудников; 4 — расходы и их статьи;
// 5 — поставщики и оплаты им, внесение/изъятие наличных, сервисы перевода, правки остатка
// 6 — типы товаров, ФИО/оклад/бонус сотрудников, кому выдана зарплата
// 7 — доходы вне продаж и их статьи
const FORMAT = 7

@Injectable()
export class BackupService {
  private readonly log = new Logger('Backup')
  constructor(private prisma: PrismaService) {}

  async dump() {
    const [
      products, customers, sales, arrivals, shifts, payments, users, deferred, returns, writeOffs, batches, inventories, categories, expenses, expenseCategories,
      suppliers, supplierPayments, cashMoves, payServices, stockEdits, productTypes, incomes, incomeCategories,
    ] = await Promise.all([
        this.prisma.product.findMany(),
        this.prisma.customer.findMany(),
        this.prisma.sale.findMany({ include: { items: true } }),
        this.prisma.arrival.findMany({ include: { items: true } }),
        this.prisma.shift.findMany(),
        this.prisma.debtPayment.findMany(),
        this.prisma.user.findMany({
          select: { id: true, name: true, role: true, active: true, createdAt: true, fullName: true, salary: true, bonusPercent: true },
        }),
        this.prisma.deferredBarcode.findMany(),
        this.prisma.saleReturn.findMany({ include: { items: true } }),
        this.prisma.writeOff.findMany({ include: { items: true } }),
        this.prisma.batch.findMany(),
        this.prisma.inventory.findMany({ include: { items: true } }),
        // Категорию товар хранит названием, но справочник нужен: без него после
        // восстановления пропали бы отметки «срок годности не требуется»
        this.prisma.category.findMany(),
        // Расходы — часть денег магазина: без них чистая прибыль после восстановления
        // оказалась бы завышенной на всё, что магазин потратил
        this.prisma.expense.findMany(),
        this.prisma.expenseCategory.findMany(),
        // Долги поставщикам и движения наличных — тоже деньги магазина
        this.prisma.supplier.findMany(),
        this.prisma.supplierPayment.findMany(),
        this.prisma.cashMove.findMany(),
        this.prisma.payService.findMany(),
        this.prisma.stockEdit.findMany(),
        this.prisma.productType.findMany(),
        // Доходы вне продаж — тоже деньги магазина: без них чистый доход после
        // восстановления оказался бы занижен
        this.prisma.income.findMany(),
        this.prisma.incomeCategory.findMany(),
      ])

    return {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      counts: {
        categories: categories.length,
        products: products.length,
        sales: sales.length,
        customers: customers.length,
        arrivals: arrivals.length,
        returns: returns.length,
        writeOffs: writeOffs.length,
        expenses: expenses.length,
        incomes: incomes.length,
        suppliers: suppliers.length,
      },
      data: {
        categories, products, customers, sales, arrivals, shifts, payments, users, deferred, returns, writeOffs, batches, inventories, expenses, expenseCategories,
        suppliers, supplierPayments, cashMoves, payServices, stockEdits, productTypes, incomes, incomeCategories,
      },
    }
  }

  // Восстановление: полностью заменяет текущие данные содержимым копии.
  // Операция необратимая, поэтому вызывается только основателем и с явным подтверждением.
  async restore(dump: any, confirm: string) {
    if (confirm !== 'ВОССТАНОВИТЬ') {
      throw new BadRequestException('Восстановление не подтверждено')
    }
    if (!dump?.data?.products) throw new BadRequestException('Файл копии повреждён или не от этой системы')
    const d = dump.data

    await this.prisma.$transaction(async (tx) => {
      // Чистим в порядке зависимостей (сначала то, что ссылается на другое)
      await tx.inventoryItem.deleteMany({})
      await tx.inventory.deleteMany({})
      await tx.writeOffItem.deleteMany({})
      await tx.writeOff.deleteMany({})
      await tx.saleReturnItem.deleteMany({})
      await tx.saleReturn.deleteMany({})
      await tx.saleItem.deleteMany({})
      await tx.sale.deleteMany({})
      await tx.arrivalItem.deleteMany({})
      await tx.arrival.deleteMany({})
      await tx.debtPayment.deleteMany({})
      // Расходы заменяются вместе со всем остальным — и когда в копии их нет (она
      // снята до появления раздела): внесённое после копии отменяется, как и чеки
      await tx.expense.deleteMany({})
      // Доходы — так же: копия, снятая до их появления, отменяет внесённые после неё
      await tx.income.deleteMany({})
      await tx.supplierPayment.deleteMany({})
      await tx.cashMove.deleteMany({})
      await tx.stockEdit.deleteMany({})
      await tx.batch.deleteMany({})
      await tx.deferredBarcode.deleteMany({})
      await tx.shift.deleteMany({})
      await tx.customer.deleteMany({})
      await tx.product.deleteMany({})
      await tx.supplier.deleteMany({})

      // Пересчёты остатков, сделанные после этой копии, отменяются вместе со всем
      // остальным — их отметки больше ничего не значат (см. common/counted.ts)
      const copiedAt = new Date(dump.createdAt)
      if (Number.isFinite(copiedAt.getTime())) await forgetCountedAfter(tx, copiedAt)

      const strip = (rows: any[], drop: string[] = []) =>
        (rows || []).map((r) => {
          const c = { ...r }
          drop.forEach((k) => delete c[k])
          return c
        })

      // ── Справочник категорий ──
      // Товары хранят категорию названием, поэтому сами по себе они не пропадут.
      // Но без справочника теряется отметка «срок годности не требуется», и при
      // первой же приёмке бинтов система начнёт требовать срок.
      if (d.categories?.length) {
        await tx.category.deleteMany({})
        await tx.category.createMany({ data: strip(d.categories), skipDuplicates: true })
      }
      // Типы товаров — как категории: список заменяем, только если он есть в копии
      if (d.productTypes?.length) {
        await tx.productType.deleteMany({})
        await tx.productType.createMany({ data: strip(d.productTypes), skipDuplicates: true })
      }

      // ── Сотрудники ──
      // Восстанавливаем только имена: доступ к программе живёт не здесь, а в панели
      // управления, и копия его не переносит вовсе. Это и правильно — иначе файл
      // с флешки раздавал бы логины, а поднятый из копии магазин пускал бы к себе
      // сотрудников, которых владелец сервиса не заводил.
      //
      // Заводим их заблокированными: чеки и смены сохранят имя того, кто их оформил,
      // а войти под этими именами нельзя, пока владелец не выдаст доступ заново.
      // Без этого восстановление на чистом сервере просто падало: документы
      // ссылались на сотрудников, которых там нет.
      const known = await tx.user.findMany({ select: { id: true, name: true } })
      const userIds = new Set(known.map((u) => u.id))
      const usedNames = new Set(known.map((u) => u.name))
      let restoredUsers = 0
      for (const u of d.users || []) {
        if (!u?.id || userIds.has(u.id)) continue
        // Имя сотрудника уникально: если такое уже занято, помечаем происхождение
        let name = String(u.name || 'Сотрудник')
        if (usedNames.has(name)) {
          let n = 2
          while (usedNames.has(`${name} (из копии ${n})`)) n++
          name = `${name} (из копии ${n})`
        }
        usedNames.add(name)
        await tx.user.create({
          data: {
            id: u.id,
            name,
            role: u.role === 'founder' ? 'founder' : 'cashier',
            active: false,
            createdAt: u.createdAt ? new Date(u.createdAt) : undefined,
            fullName: typeof u.fullName === 'string' ? u.fullName.slice(0, 120) : '',
            salary: Math.max(0, Number(u.salary) || 0),
            bonusPercent: Math.min(100, Math.max(0, Number(u.bonusPercent) || 0)),
          },
        })
        userIds.add(u.id)
        restoredUsers++
      }
      if (restoredUsers) {
        this.log.warn(
          `Восстановлено сотрудников: ${restoredUsers}. Все заблокированы и без доступа — ` +
            'заведите их заново в разделе «Сотрудники».',
        )
      }

      // Ссылка на того, кого в копии не оказалось, обрушила бы всё восстановление.
      // Лучше потерять имя кассира у одного документа, чем не поднять базу целиком.
      const ref = (id: any) => (id && userIds.has(id) ? id : null)

      if (d.products?.length) await tx.product.createMany({ data: strip(d.products) })
      if (d.customers?.length) await tx.customer.createMany({ data: strip(d.customers) })
      // Поставщики — до приходов: приход ссылается на поставщика
      if (d.suppliers?.length) await tx.supplier.createMany({ data: strip(d.suppliers) })
      if (d.shifts?.length) {
        await tx.shift.createMany({ data: strip(d.shifts).map((sh: any) => ({ ...sh, userId: ref(sh.userId) })) })
      }
      if (d.batches?.length) await tx.batch.createMany({ data: strip(d.batches) })
      if (d.deferred?.length) await tx.deferredBarcode.createMany({ data: strip(d.deferred) })

      for (const s of d.sales || []) {
        const { items, customer, user, ...sale } = s
        await tx.sale.create({
          data: { ...sale, userId: ref(sale.userId), items: { create: strip(items, ['saleId']) } },
        })
      }
      for (const a of d.arrivals || []) {
        const { items, user, supplierRef, ...arr } = a
        await tx.arrival.create({ data: { ...arr, userId: ref(arr.userId), items: { create: strip(items, ['arrivalId']) } } })
      }
      for (const r of d.returns || []) {
        const { items, user, ...ret } = r
        await tx.saleReturn.create({
          data: { ...ret, userId: ref(ret.userId), items: { create: strip(items, ['returnId']) } },
        })
      }
      for (const w of d.writeOffs || []) {
        const { items, user, ...wo } = w
        await tx.writeOff.create({
          data: { ...wo, userId: ref(wo.userId), items: { create: strip(items, ['writeOffId']) } },
        })
      }
      for (const inv of d.inventories || []) {
        const { items, user, ...iv } = inv
        await tx.inventory.create({
          data: { ...iv, userId: ref(iv.userId), items: { create: strip(items, ['inventoryId']) } },
        })
      }
      if (d.payments?.length) await tx.debtPayment.createMany({ data: strip(d.payments) })

      // ── Расходы и их статьи ──
      // Список статей заменяем, только если он есть в копии: копия, снятая до появления
      // раздела, о статьях не знает, и стирать из-за неё нынешний список незачем
      if (d.expenseCategories?.length) {
        await tx.expenseCategory.deleteMany({})
        await tx.expenseCategory.createMany({ data: strip(d.expenseCategories), skipDuplicates: true })
      }
      if (d.expenses?.length) {
        await tx.expense.createMany({ data: strip(d.expenses, ['user']).map((e: any) => ({ ...e, userId: ref(e.userId) })) })
      }
      // ── Доходы и их статьи ── по тем же правилам, что расходы
      if (d.incomeCategories?.length) {
        await tx.incomeCategory.deleteMany({})
        await tx.incomeCategory.createMany({ data: strip(d.incomeCategories), skipDuplicates: true })
      }
      if (d.incomes?.length) {
        await tx.income.createMany({ data: strip(d.incomes, ['user']).map((e: any) => ({ ...e, userId: ref(e.userId) })) })
      }
      // Сервисы перевода — как статьи расходов: список заменяем, только если он есть в копии
      if (d.payServices?.length) {
        await tx.payService.deleteMany({})
        await tx.payService.createMany({ data: strip(d.payServices), skipDuplicates: true })
      }
      if (d.supplierPayments?.length) {
        await tx.supplierPayment.createMany({ data: strip(d.supplierPayments, ['user', 'supplier']).map((p: any) => ({ ...p, userId: ref(p.userId) })) })
      }
      if (d.cashMoves?.length) {
        await tx.cashMove.createMany({ data: strip(d.cashMoves, ['user']).map((m: any) => ({ ...m, userId: ref(m.userId) })) })
      }
      if (d.stockEdits?.length) {
        await tx.stockEdit.createMany({ data: strip(d.stockEdits, ['user']).map((e: any) => ({ ...e, userId: ref(e.userId) })) })
      }
    }, TX_LONG)

    this.log.warn('База восстановлена из резервной копии от ' + dump.createdAt)
    return { ok: true, restoredAt: new Date().toISOString() }
  }
}
