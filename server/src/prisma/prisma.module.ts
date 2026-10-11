import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { TenantPool } from './tenant-pool.service'

@Global()
@Module({
  providers: [TenantPool, PrismaService],
  // TenantPool наружу нужен тем, кто работает вне запроса и выбирает схему сам:
  // заведение аптеки, обход всех аптек в фоновых задачах, миграции
  exports: [PrismaService, TenantPool],
})
export class PrismaModule {}
