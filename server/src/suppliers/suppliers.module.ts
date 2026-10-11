import { Module } from '@nestjs/common'
import { SupplierPaymentsController, SuppliersController } from './suppliers.controller'
import { SuppliersService } from './suppliers.service'

@Module({ controllers: [SuppliersController, SupplierPaymentsController], providers: [SuppliersService] })
export class SuppliersModule {}
