import { Module } from '@nestjs/common'
import { IncomeCategoriesController, IncomesController } from './incomes.controller'
import { IncomesService } from './incomes.service'

@Module({ controllers: [IncomesController, IncomeCategoriesController], providers: [IncomesService] })
export class IncomesModule {}
