import { Controller, Get } from '@nestjs/common'
import { Public } from './auth/decorators'

// Отпечаток запущенной сборки. Без него после выкладки невозможно понять, работает
// уже новый код или платформа ещё собирает старый, — а по внешним признакам сервер
// в обоих случаях отвечает одинаково.
// Номер коммита подставляет Railway; при локальном запуске его нет.
const BUILD = {
  service: 'apteka-api',
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev',
  startedAt: new Date().toISOString(),
}

@Controller()
export class AppController {
  // health-проверка: GET /api и GET /api/health — без авторизации
  @Public()
  @Get()
  root() {
    return { status: 'ok', ...BUILD }
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', ...BUILD }
  }
}
