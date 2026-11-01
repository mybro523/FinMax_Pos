import { BadRequestException, Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import { AdminDbService } from './admin-db.service'
import { FOREVER, dateOfDay, dayOf, formatComputerCode, issueCode, makeKeys, parseComputerCode, publicOf, todayDay } from '../common/licence-code'
import { LICENCE_PUBLIC_KEY } from '../common/licence-pin'

// ── Коды активации программы без интернета (версия 1.6.0) ──
// Магазин без интернета работает на компьютере владельца, сервер его не видит. Владелец
// сервиса выпускает здесь код под «код компьютера» магазина: до какого дня и сколько касс
// можно подключить. Второй вид кода — сброс пароля владельца магазина: без сервера забытый
// пароль иначе не вернуть. Расчёт кода — src/common/licence-code.ts.

const KEY_ID = 'main'
// Сброс пароля действует три дня: сегодня и ещё два (успеть доехать или дозвониться)
const RESET_DAYS = 2
// Больше касс в одном магазине без интернета не бывает; и в коде под число — один байт
export const MAX_REGISTERS = 50

export type LicenceView = {
  id: string
  kind: string
  computer: string
  until: string | null
  registers: number
  serial: number
  note: string
  code: string
  byName: string
  createdAt: string
}

@Injectable()
export class LicencesService {
  private readonly log = new Logger('Licences')

  // Открытый ключ, закреплённый в исходниках (licence-pin.ts); проверки подставляют свой
  pin = LICENCE_PUBLIC_KEY
  private cached: { privateKey: string; publicKey: string } | null = null

  constructor(private admin: AdminDbService) {}

  // ── Ключ сервиса ──
  // Пока ключ не закреплён в исходниках, он заводится сам при первом обращении. Две одновременные
  // первые заявки не заведут два ключа: у записи один номер, вторая вставка не пройдёт, и обе
  // прочтут первую. Закреплён — новый не заводится никогда: потерянную запись возвращают из
  // копии базы, иначе выданные коды и установленные программы перестали бы сходиться с сервером
  private async key() {
    if (this.cached) return this.cached
    const have = await this.admin.licenceKey.findUnique({ where: { id: KEY_ID } })
    if (have) return (this.cached = this.checked(have))
    if (this.pin) {
      this.log.error(`Ключ кодов активации потерян: в базе сервиса нет записи LicenceKey, а программы ждут ключ ${this.pin.slice(0, 16)}… Новый ключ не заводится — верните запись из копии базы`)
      throw new ServiceUnavailableException('Ключ кодов активации потерян: в базе сервиса нет таблицы LicenceKey. Верните её из копии базы — новый ключ не заводится, иначе выданные коды и установленные программы перестанут подходить.')
    }
    const k = makeKeys()
    try {
      const made = await this.admin.licenceKey.create({ data: { id: KEY_ID, privateKey: k.privateKey, publicKey: k.publicKey } })
      this.log.error(`Заведён НОВЫЙ ключ кодов активации ${made.publicKey} — закрепите его: server/src/common/licence-pin.ts и desktop/scripts/licence-pin.mjs`)
      return (this.cached = this.checked(made))
    } catch (e: any) {
      const again = await this.admin.licenceKey.findUnique({ where: { id: KEY_ID } })
      if (again) return (this.cached = this.checked(again))
      // Только код ошибки: в тексте ошибки базы повторяются данные вставки — с секретным ключом
      this.log.error(`Ключ кодов активации не заведён: ${e?.code || 'ошибка базы'}`)
      throw new InternalServerErrorException('Ключ кодов активации не заведён')
    }
  }

  // Ключ в базе — тот, что закреплён, и его половины сходятся
  private checked(row: { privateKey: string; publicKey: string }) {
    if (this.pin && row.publicKey !== this.pin) {
      this.log.error(`Ключ кодов активации в базе (${row.publicKey.slice(0, 16)}…) не тот, что закреплён (${this.pin.slice(0, 16)}…)`)
      throw new ServiceUnavailableException('Ключ кодов активации в базе сервиса не тот, что в программах. Коды не выпускаются: верните прежнюю запись LicenceKey из копии базы.')
    }
    let same = false
    try {
      same = publicOf(row.privateKey) === row.publicKey
    } catch {
      same = false
    }
    if (!same) {
      this.log.error('Ключ кодов активации в базе испорчен: половины не сходятся')
      throw new ServiceUnavailableException('Ключ кодов активации в базе сервиса испорчен. Верните запись LicenceKey из копии базы.')
    }
    return { privateKey: row.privateKey, publicKey: row.publicKey }
  }

  // Открытая половина — для сборки программы: по ней программа проверяет коды
  async publicKey() {
    return { key: (await this.key()).publicKey }
  }

  async issue(
    dto: { computer?: string; kind?: string; until?: string; forever?: boolean; registers?: number; note?: string },
    byAccountId?: string,
  ): Promise<LicenceView> {
    const raw = parseComputerCode(String(dto.computer ?? ''))
    if (!raw) throw new BadRequestException('Код компьютера введён с ошибкой — сверьте каждый знак (10 знаков, например XJ980-C0A4R)')
    const computer = formatComputerCode(raw)
    const kind = dto.kind === 'reset' ? 'reset' : 'activate'
    const today = todayDay(Date.now())
    let until: number
    let registers = 0
    if (kind === 'activate') {
      if (dto.forever && dto.until) throw new BadRequestException('Выберите одно: до какого дня или «навсегда»')
      if (dto.forever) until = FOREVER
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.until ?? ''))) throw new BadRequestException('Укажите, до какого дня действует код')
        try {
          until = dayOf(String(dto.until))
        } catch {
          throw new BadRequestException('Такого дня нет — проверьте дату')
        }
        if (until < today) throw new BadRequestException('Срок кода уже прошёл — укажите будущий день')
        if (until >= FOREVER) throw new BadRequestException('Слишком далёкий срок — выберите «навсегда»')
      }
      registers = Math.trunc(Number(dto.registers))
      if (!Number.isInteger(registers) || registers < 1 || registers > MAX_REGISTERS) {
        throw new BadRequestException(`Сколько касс можно подключить — от 1 до ${MAX_REGISTERS}`)
      }
    } else until = today + RESET_DAYS

    // Номер кода: у активации — по порядку выпуска (виден в программе и в записи), у сброса —
    // случайный: программа помнит использованные и второй раз тот же код не примет
    const serial = kind === 'activate' ? ((await this.admin.licenceCode.count({ where: { kind: 'activate' } })) + 1) & 0xffff : randomInt(1, 0xffff)
    const k = await this.key()
    const code = issueCode(k.privateKey, raw, { kind, until, registers, serial })
    const who = byAccountId ? await this.admin.account.findUnique({ where: { id: byAccountId }, select: { login: true } }) : null
    const note = String(dto.note ?? '').trim().slice(0, 200)
    const row = await this.admin.licenceCode.create({
      data: {
        kind,
        computer,
        until: until === FOREVER ? null : new Date(dateOfDay(until) + 'T00:00:00.000Z'),
        registers,
        serial,
        note,
        code,
        byAccountId: byAccountId ?? null,
        byName: who?.login || '',
      },
    })
    // В журнал панели — как продление: кто, кому и на сколько
    const detail =
      kind === 'activate'
        ? `код активации для ${computer}: ${until === FOREVER ? 'навсегда' : 'до ' + dateOfDay(until)}, касс — ${registers}${note ? ` (${note})` : ''}`
        : `код сброса пароля для ${computer}${note ? ` (${note})` : ''}`
    await this.admin.auditLog
      .create({ data: { accountId: byAccountId ?? null, accountName: who?.login || '', action: kind === 'activate' ? 'licence' : 'licence-reset', detail } })
      .catch((e) => this.log.warn('журнал: выпуск кода не записан: ' + (e?.code || e?.message || e)))
    return view(row)
  }

  async list(): Promise<LicenceView[]> {
    const rows = await this.admin.licenceCode.findMany({ orderBy: { createdAt: 'desc' }, take: 300 })
    return rows.map(view)
  }
}

function view(r: {
  id: string
  kind: string
  computer: string
  until: Date | null
  registers: number
  serial: number
  note: string
  code: string
  byName: string
  createdAt: Date
}): LicenceView {
  return {
    id: r.id,
    kind: r.kind,
    computer: r.computer,
    until: r.until ? r.until.toISOString().slice(0, 10) : null,
    registers: r.registers,
    serial: r.serial,
    note: r.note,
    code: r.code,
    byName: r.byName,
    createdAt: r.createdAt.toISOString(),
  }
}
