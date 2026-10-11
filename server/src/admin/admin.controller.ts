import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { PharmaciesService } from './pharmacies.service'
import { SummaryService } from './summary.service'
import { CurrentUser, Roles, ServiceWide } from '../auth/decorators'
import { CreatePharmacyDto, ExtendPharmacyDto, UpdatePharmacyDto } from './dto'

// ── Панель управления ──
// Разделы владельца сервиса: список аптек-клиентов и заведение новых. Продление,
// приостановка, оплаты и журнал появятся здесь же — пока ровно столько, сколько
// нужно, чтобы аптеку можно было завести и в неё вошли.
//
// Роль superadmin — единственная, которая сюда допускается. Она же единственная,
// которой разрешено работать без привязки к аптеке (см. AuthGuard): владелец
// сервиса обслуживает все и не принадлежит ни одной.
@Controller('admin/pharmacies')
@ServiceWide()
@Roles('superadmin')
export class AdminController {
  constructor(
    private readonly pharmacies: PharmaciesService,
    private readonly summaries: SummaryService,
  ) {}

  @Get()
  findAll() {
    return this.pharmacies.findAll()
  }

  @Post()
  create(@Body() dto: CreatePharmacyDto) {
    return this.pharmacies.create(dto)
  }

  // Карточка клиента: контакты, подписка, оплаты, сотрудники и живая ли аптека
  // Счётчики живут отдельно от карточки: за ними надо идти в схему самой аптеки,
  // и на остывшем подключении это полторы секунды. Держать из-за них весь экран
  // нельзя — по ним лишь смотрят, живой ли клиент.
  // ── Сводка ──
  // Объявлена ДО @Get(':id'), иначе адрес «summary» разобрался бы как код аптеки
  // и панель получала бы «аптека не найдена» вместо чисел.
  // Все платежи сервиса за период — расшифровка к «Доходу» в сводке
  @Get('payments')
  allPayments(@Query('days') days?: string) {
    return this.pharmacies.allPayments(Number(days) || 31)
  }

  @Get('summary')
  summary() {
    return this.summaries.build()
  }

  @Get(':id/usage')
  usage(@Param('id') id: string) {
    return this.pharmacies.usage(id)
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.pharmacies.detail(id)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePharmacyDto, @CurrentUser() u: any) {
    return this.pharmacies.update(id, dto, u?.sub)
  }

  // Посмотреть аптеку глазами её владельца — для поддержки. Пишется в журнал,
  // помечается в самом токене и живёт недолго.
  @Post(':id/enter')
  enter(@Param('id') id: string, @CurrentUser() u: any) {
    return this.pharmacies.enter(id, u?.sub)
  }

  @Get(':id/payments')
  payments(@Param('id') id: string) {
    return this.pharmacies.payments(id)
  }

  // Продление подписки. Деньги принимаются вживую, здесь остаётся запись о том,
  // за что и на сколько продлили.
  @Post(':id/extend')
  extend(@Param('id') id: string, @Body() dto: ExtendPharmacyDto, @CurrentUser() u: any) {
    return this.pharmacies.extend(id, dto, u?.sub)
  }

  // Приостановка ничего не стирает — данные ждут возвращения клиента
  // Отметка о звонке: когда звонили и что обещали
  @Post(':id/called')
  called(@Param('id') id: string, @Body() dto: { note?: string }) {
    return this.pharmacies.markCalled(id, dto?.note || '')
  }

  @Post(':id/block')
  block(@Param('id') id: string, @CurrentUser() u: any) {
    return this.pharmacies.setBlocked(id, true, u?.sub)
  }

  @Post(':id/unblock')
  unblock(@Param('id') id: string, @CurrentUser() u: any) {
    return this.pharmacies.setBlocked(id, false, u?.sub)
  }

  // Удаление стирает схему аптеки целиком. Подтверждение — код самой аптеки:
  // перепутать строку в списке легко, набрать чужой код руками — уже нет.
  @Delete(':id')
  remove(@Param('id') id: string, @Query('confirm') confirm: string, @CurrentUser() u: any) {
    return this.pharmacies.remove(id, confirm, u?.sub)
  }
}
