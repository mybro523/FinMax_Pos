import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class DeferredService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.deferredBarcode.findMany({ orderBy: { createdAt: 'desc' } })
  }

  // Добавить штрихкод в отложенные (повтор того же штрихкода игнорируем)
  add(barcode: string) {
    const code = barcode.trim()
    return this.prisma.deferredBarcode.upsert({
      where: { barcode: code },
      update: {},
      create: { barcode: code },
    })
  }

  async remove(id: string) {
    await this.prisma.deferredBarcode.deleteMany({ where: { id } })
    return { ok: true }
  }
}
