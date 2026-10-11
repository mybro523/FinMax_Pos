import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { AdminModule } from './admin/admin.module'
import { ProductsModule } from './products/products.module'
import { SalesModule } from './sales/sales.module'
import { ArrivalsModule } from './arrivals/arrivals.module'
import { CustomersModule } from './customers/customers.module'
import { DeferredModule } from './deferred/deferred.module'
import { ShiftsModule } from './shifts/shifts.module'
import { SeedModule } from './seed/seed.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { ReturnsModule } from './returns/returns.module'
import { WriteOffsModule } from './writeoffs/writeoffs.module'
import { InventoryModule } from './inventory/inventory.module'
import { BackupModule } from './backup/backup.module'
import { CategoriesModule } from './categories/categories.module'
import { EventsModule } from './events/events.module'
import { ExpiryModule } from './expiry/expiry.module'
import { SyncModule } from './sync/sync.module'
import { ExpensesModule } from './expenses/expenses.module'
import { SuppliersModule } from './suppliers/suppliers.module'
import { PayServicesModule } from './payservices/pay-services.module'
import { ChangeEventsInterceptor } from './events/change-events.interceptor'
import { FreshnessInterceptor } from './events/freshness.interceptor'
import { AuthGuard } from './auth/auth.guard'
import { TenantContextMiddleware } from './auth/tenant-context.middleware'
import { AppController } from './app.controller'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    // База панели управления: аптеки-клиенты, учётные записи, оплаты.
    // Данные самой аптеки лежат отдельно, в своей схеме — см. prisma/admin/schema.prisma
    AdminModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    SalesModule,
    ArrivalsModule,
    CustomersModule,
    DeferredModule,
    ShiftsModule,
    ReturnsModule,
    WriteOffsModule,
    InventoryModule,
    BackupModule,
    CategoriesModule,
    EventsModule,
    ExpiryModule,
    ExpensesModule,
    SuppliersModule,
    PayServicesModule,
    // Обмен с кассами, которые работают без интернета (программа для Windows)
    SyncModule,
    SeedModule,
  ],
  controllers: [AppController],
  providers: [
    // Глобальная авторизация: все эндпоинты защищены, кроме @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
    // После каждой успешной записи оповещаем устройства, что раздел устарел
    // Порядок важен: свежесть проверяется первой, чтобы при совпадении отметки
    // дело не доходило ни до базы, ни до остальных перехватчиков
    { provide: APP_INTERCEPTOR, useClass: FreshnessInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ChangeEventsInterceptor },
  ],
})
export class AppModule implements NestModule {
  // Схема аптеки объявляется до всего остального: guard, перехватчики и сам
  // обработчик должны работать уже внутри неё. Промежуточный слой — единственное
  // место, которое оборачивает собой всю дальнейшую обработку целиком.
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*')
  }
}
