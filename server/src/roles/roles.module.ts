import { Module } from '@nestjs/common'
import { RolesController } from './roles.controller'
import { RolesService } from './roles.service'

@Module({
  controllers: [RolesController],
  providers: [RolesService],
  // Сотрудникам роль назначается при заведении и правке — тем же сервисом
  exports: [RolesService],
})
export class RolesModule {}
