import { Module } from '@nestjs/common'
import { ExpiryService } from './expiry.service'

// Своих эндпоинтов у раздела нет: он только следит, чтобы просроченный остаток
// в карточках товара оставался правдой по мере хода времени.
@Module({
  providers: [ExpiryService],
  exports: [ExpiryService],
})
export class ExpiryModule {}
