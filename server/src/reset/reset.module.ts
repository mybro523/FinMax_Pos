import { Module } from '@nestjs/common'
import { ResetController } from './reset.controller'
import { ResetService } from './reset.service'
import { CategoriesModule } from '../categories/categories.module'
import { SeedModule } from '../seed/seed.module'

// EventsGateway глобальный (EventsModule @Global), PrismaService — из PrismaModule (тоже
// доступен везде). Категории и стартовую проверку смены берём из их модулей.
@Module({
  imports: [CategoriesModule, SeedModule],
  controllers: [ResetController],
  providers: [ResetService],
})
export class ResetModule {}
