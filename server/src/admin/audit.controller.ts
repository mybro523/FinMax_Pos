import { Controller, Get, Query } from '@nestjs/common'
import { PharmaciesService } from './pharmacies.service'
import { Roles, ServiceWide } from '../auth/decorators'

// Журнал действий по всему сервису. Отдельным адресом, а не внутри магазинов: он не
// про конкретный магазин, а про то, что делал владелец сервиса — включая входы
// под чужими владельцами, которые видеть особенно важно.
@Controller('admin/audit')
@ServiceWide()
@Roles('superadmin')
export class AuditController {
  constructor(private readonly pharmacies: PharmaciesService) {}

  @Get()
  findAll(@Query('limit') limit?: string) {
    return this.pharmacies.auditAll(Number(limit) || 200)
  }
}
