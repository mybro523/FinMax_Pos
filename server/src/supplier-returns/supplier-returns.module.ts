import { Module } from '@nestjs/common'
import { SupplierReturnsController } from './supplier-returns.controller'
import { SupplierReturnsService } from './supplier-returns.service'

@Module({ controllers: [SupplierReturnsController], providers: [SupplierReturnsService] })
export class SupplierReturnsModule {}
