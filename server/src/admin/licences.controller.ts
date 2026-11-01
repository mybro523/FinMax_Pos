import { Body, Controller, Get, Post } from '@nestjs/common'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { CurrentUser, Roles, ServiceWide } from '../auth/decorators'
import { LicencesService, MAX_REGISTERS } from './licences.service'

export class IssueLicenceDto {
  @IsString()
  @MaxLength(40)
  computer!: string

  @IsOptional()
  @IsIn(['activate', 'reset'])
  kind?: string

  @IsOptional()
  @IsString()
  @MaxLength(10)
  until?: string

  @IsOptional()
  @IsBoolean()
  forever?: boolean

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_REGISTERS)
  registers?: number

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string
}

// ── Коды активации: выпуск и список — только владельцу сервиса ──
@Controller('admin/licences')
@ServiceWide()
@Roles('superadmin')
export class LicencesController {
  constructor(private readonly licences: LicencesService) {}

  @Get()
  list() {
    return this.licences.list()
  }

  @Post()
  issue(@Body() dto: IssueLicenceDto, @CurrentUser() u: any) {
    return this.licences.issue(dto, u?.sub)
  }
}
