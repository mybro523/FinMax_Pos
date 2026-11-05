import { Module } from '@nestjs/common'
import { ShopController } from './shop.controller'

// Панель управления (AdminModule) объявлена глобальной — PharmaciesService берётся оттуда
@Module({
  controllers: [ShopController],
})
export class ShopModule {}
