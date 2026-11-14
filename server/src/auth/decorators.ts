import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common'

// Эндпоинт без авторизации (login, health)
export const PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(PUBLIC_KEY, true)

// ── Раздел относится к сервису, а не к конкретному магазину ──
// Обычный раздел работает с данными магазина, поэтому учётная запись обязана быть
// к магазину привязана: у владельца сервиса схемы нет, и запрос ушёл бы мимо всех
// магазинов сразу. Но есть разделы про саму учётную запись — «кто я» и смена пароля, —
// и они нужны всем без исключения. Плюс сама панель управления.
export const SERVICE_WIDE_KEY = 'serviceWide'
export const ServiceWide = () => SetMetadata(SERVICE_WIDE_KEY, true)

// Ограничение по ролям (напр. только founder)
export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

// Право из списка src/auth/permissions.ts. Несколько ключей — достаточно любого.
// Владелец магазина проходит всегда
export const PERM_KEY = 'perms'
export const Perm = (...keys: string[]) => SetMetadata(PERM_KEY, keys)

// ── Раздел модуля (1.8.1) ──
// Владелец сервиса выключает модули магазина (common/moduli.ts). Права выключенного модуля и
// так пропадают у всех, но часть разделов пускает и по правам обязательных разделов
// (остаток склада читает и приход) — поэтому раздел модуля помечается и прямо: выключен
// модуль у магазина — отказ всем, даже владельцу. Несколько ключей — раздел закрыт, только
// когда выключены все
export const MODULE_KEY = 'modul'
export const Modul = (...keys: string[]) => SetMetadata(MODULE_KEY, keys)
export const MODULE_OFF = 'Этот раздел у вашего магазина выключен'

// Текущий пользователь из токена: @CurrentUser() u -> { sub, name, role }
export const CurrentUser = createParamDecorator((_data, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user)
