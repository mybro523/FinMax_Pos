import { Global, Module } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { TenantSchemaService } from './tenant-schema.service'
import { PharmaciesService } from './pharmacies.service'
import { AccountsService } from './accounts.service'
import { AdminController } from './admin.controller'
import { AuditController } from './audit.controller'
import { MaintenanceController } from './maintenance.controller'
import { SchemaUpdaterService } from './schema-updater.service'
import { SubscriptionWatchService } from './subscription-watch.service'
import { AccountCache } from './account-cache.service'
import { DbProbe } from './db-probe.service'
import { SummaryService } from './summary.service'
import { SeedModule } from '../seed/seed.module'
import { CategoriesModule } from '../categories/categories.module'
import { UsersModule } from '../users/users.module'
import { AuthModule } from '../auth/auth.module'

// Панель управления нужна и входу (учётные записи со всего сервиса), и разделам
// самой панели. Как и PrismaModule для данных магазина, объявляем её глобальной —
// иначе одно и то же подключение пришлось бы протаскивать импортами через
// половину модулей.
//
// Заведение магазина переиспользует стартовую настройку чистой базы: она уже
// написана и проверена, и переписывать её заново означало бы завести вторую
// правду о том, как выглядит новый магазин.
@Global()
@Module({
  imports: [SeedModule, CategoriesModule, UsersModule, AuthModule],
  controllers: [AdminController, AuditController, MaintenanceController],
  providers: [
    AdminDbService,
    TenantSchemaService,
    PharmaciesService,
    AccountsService,
    SchemaUpdaterService,
    SubscriptionWatchService,
    AccountCache,
    DbProbe,
    SummaryService,
  ],
  exports: [AdminDbService, TenantSchemaService, PharmaciesService, AccountsService, SchemaUpdaterService, AccountCache, DbProbe, SummaryService],
})
export class AdminModule {}
