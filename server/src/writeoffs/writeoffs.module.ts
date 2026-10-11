import { Module } from '@nestjs/common'
import { WriteOffsController } from './writeoffs.controller'
import { WriteOffsService } from './writeoffs.service'

@Module({ controllers: [WriteOffsController], providers: [WriteOffsService] })
export class WriteOffsModule {}
