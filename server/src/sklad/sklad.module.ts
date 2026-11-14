import { Module } from '@nestjs/common'
import { SkladController } from './sklad.controller'
import { SkladService } from './sklad.service'

@Module({ controllers: [SkladController], providers: [SkladService] })
export class SkladModule {}
