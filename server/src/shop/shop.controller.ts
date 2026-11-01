import { Controller, Get, Query } from '@nestjs/common'
import { CurrentUser } from '../auth/decorators'
import { PharmaciesService } from '../admin/pharmacies.service'

// ── Свой магазин: то, что заводит владелец сервиса, а нужно кассам ──
// Пока здесь только логотип: касса печатает его на чеках и листах и показывает на экране
// покупателя. Картинку ставит владелец сервиса в панели; магазин берётся из входа
// (pharmacyId, который AuthGuard кладёт в req.user по учётной записи) — свой логотип видит
// любой сотрудник, чужой так не получить.
@Controller('shop')
export class ShopController {
  constructor(private readonly pharmacies: PharmaciesService) {}

  // { logo: data URL или '', at: когда поставили или null }. ?at=<отметка> — у кассы уже есть
  // картинка с этой отметкой: если она та же, ответ без картинки ({ at, same: true })
  @Get('logo')
  logo(@CurrentUser() u: any, @Query('at') at?: string) {
    return this.pharmacies.shopLogo(u?.pharmacyId, typeof at === 'string' && at ? at.slice(0, 40) : undefined)
  }
}
