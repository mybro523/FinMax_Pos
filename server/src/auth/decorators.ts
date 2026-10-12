import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common'

// Эндпоинт без авторизации (login, health)
export const PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(PUBLIC_KEY, true)

// ── Раздел относится к сервису, а не к конкретной аптеке ──
// Обычный раздел работает с данными аптеки, поэтому учётная запись обязана быть
// к аптеке привязана: у владельца сервиса схемы нет, и запрос ушёл бы мимо всех
// аптек сразу. Но есть разделы про саму учётную запись — «кто я» и смена пароля, —
// и они нужны всем без исключения. Плюс сама панель управления.
export const SERVICE_WIDE_KEY = 'serviceWide'
export const ServiceWide = () => SetMetadata(SERVICE_WIDE_KEY, true)

// Ограничение по ролям (напр. только founder)
export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

// Право из списка src/auth/permissions.ts. Несколько ключей — достаточно любого.
// Владелец аптеки проходит всегда
export const PERM_KEY = 'perms'
export const Perm = (...keys: string[]) => SetMetadata(PERM_KEY, keys)

// Текущий пользователь из токена: @CurrentUser() u -> { sub, name, role }
export const CurrentUser = createParamDecorator((_data, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user)
