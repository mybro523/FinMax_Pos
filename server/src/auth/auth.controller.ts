import { Body, Controller, Get, Post, Req } from '@nestjs/common'
import { AuthService } from './auth.service'
import { Public, CurrentUser, ServiceWide } from './decorators'
import { LoginDto, ChangePasswordDto } from './dto'

// Все разделы здесь — про саму учётную запись, а не про аптеку: ими пользуются
// и сотрудники аптек, и владелец сервиса, у которого аптеки нет вовсе
@ServiceWide()
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    // Адрес нужен, чтобы ограничивать перебор. За обратным прокси Railway
    // настоящий адрес приходит заголовком — см. trust proxy в main.ts
    return this.auth.login(dto.name, dto.password, req?.ip || '')
  }

  @Get('me')
  me(@CurrentUser() u: any) {
    return this.auth.me(u.sub, u.impersonatedBy)
  }

  @Post('change-password')
  change(@CurrentUser() u: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(u.sub, dto.oldPassword, dto.newPassword)
  }
}
