import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { RolesService } from './roles.service'
import { CurrentUser, Roles } from '../auth/decorators'
import { CreateRoleDto, UpdateRoleDto } from './dto'

// Роли и права видит и меняет только владелец аптеки: никто другой не должен
// иметь возможности выдать себе лишнее
@Roles('founder')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.roles.list(u.pharmacyId)
  }

  @Post()
  create(@Body() dto: CreateRoleDto, @CurrentUser() u: any) {
    return this.roles.create(u.pharmacyId, dto)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() u: any) {
    return this.roles.update(u.pharmacyId, id, dto)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() u: any) {
    return this.roles.remove(u.pharmacyId, id)
  }
}
