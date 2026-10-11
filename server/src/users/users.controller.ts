import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { UsersService } from './users.service'
import { Roles, CurrentUser } from '../auth/decorators'
import { CreateUserDto, UpdateUserDto } from './dto'

@Roles('founder') // управление сотрудниками — только владелец
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll(@CurrentUser() u: any) {
    return this.users.findAll(u.pharmacyId)
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() u: any) {
    return this.users.create(dto, u.pharmacyId)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: any) {
    return this.users.update(id, dto, u.sub, u.pharmacyId)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() u: any) {
    return this.users.remove(id, u.sub, u.pharmacyId)
  }
}
