import { Module } from '@nestjs/common'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'
import { RolesModule } from '../roles/roles.module'


@Module({
  imports: [RolesModule],
  controllers: [UsersController],
  providers: [UsersService],
  // Заведение аптеки создаёт её владельца тем же кодом: запись в две базы
  // с бронью логина написана один раз и проверена
  exports: [UsersService],
})
export class UsersModule {}
