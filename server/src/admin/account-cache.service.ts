import { Injectable, Logger } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'

// ── Кто это такой: помним несколько секунд ──
//
// Сторож на входе спрашивает базу о сотруднике при КАЖДОМ запросе. Ответ один и тот
// же тысячу раз подряд, но стоит он дорого: на живом сервере один поход в базу —
// сто тридцать пять миллисекунд. То есть каждый запрос, даже возвращающий пустой
// список, платил эту цену ещё до того, как начиналась работа.
//
// Замер до правки: любой раздел магазина — 535 мс, из них 122 сеть, 135 этот вопрос,
// остальное собственно дело. Убрав повторный вопрос, снимаем четверть со всего
// подряд — и с кассы, и с панели, и со списков.
//
// ── Почему это не дыра ──
// Ответ живёт секунды, а не минуты, и сбрасывается принудительно везде, где
// действительно меняется: заблокировали сотрудника, сменили пароль, приостановили
// магазин, продлили подписку, удалили магазин целиком. Срок — страховка на случай
// забытого места сброса и на случай, когда серверов станет больше одного: тогда
// сброс на одном не дойдёт до другого, и разъехаться они смогут не дольше срока.
//
// Состояние подписки здесь не хранится и храниться не может: оно считается из даты
// оплаты при каждом запросе. Дата в памяти та же, что в базе, поэтому вчера
// оплаченный магазин сегодня посчитается просроченным без всякого сброса.
const LIFE_MS = Number(process.env.ACCOUNT_CACHE_MS || 10_000)

// Ровно то, что нужно сторожу, — и ничего сверх. Лишние поля означали бы лишние
// причины для сброса.
const SHAPE = {
  include: {
    pharmacy: {
      select: {
        id: true,
        code: true,
        name: true,
        schemaName: true,
        blocked: true,
        paidUntil: true,
        trial: true,
        offlineDays: true,
      },
    },
    roleRef: { select: { id: true, name: true, permissions: true } },
  },
} as const

type Account = NonNullable<Awaited<ReturnType<AdminDbService['account']['findUnique']>>> & {
  pharmacy: {
    id: string
    code: string
    name: string
    schemaName: string
    blocked: boolean
    paidUntil: Date
    trial: boolean
    offlineDays: number
  } | null
  roleRef: { id: string; name: string; permissions: string[] } | null
}

@Injectable()
export class AccountCache {
  private readonly log = new Logger('AccountCache')
  private readonly hot = new Map<string, { at: number; acc: Account }>()
  // Сколько раз ответили из памяти и сколько раз пришлось идти в базу —
  // по этим двум числам видно, работает ли всё это вообще
  private hits = 0
  private misses = 0

  constructor(private admin: AdminDbService) {}

  async get(accountId: string): Promise<Account | null> {
    const found = this.hot.get(accountId)
    if (found && Date.now() - found.at < LIFE_MS) {
      this.hits++
      return found.acc
    }

    this.misses++
    const acc = (await this.admin.account.findUnique({ where: { id: accountId }, ...SHAPE })) as Account | null
    // Несуществующего не запоминаем: это либо удалённый сотрудник, либо чужой
    // подобранный токен, и в обоих случаях память тратить не на что
    if (acc) this.hot.set(accountId, { at: Date.now(), acc })
    else this.hot.delete(accountId)
    return acc
  }

  // Сотрудник изменился: сменил пароль, потерял доступ, стал другим по роли
  drop(accountId: string) {
    this.hot.delete(accountId)
  }

  // Изменилась сам магазин: приостановили, возобновили, продлили, удалили.
  // Задевает всех её сотрудников разом, а их немного — проще пройти по списку,
  // чем держать вторую карту «магазин → сотрудники» и следить за её верностью.
  dropPharmacy(pharmacyId: string) {
    if (!pharmacyId) return
    for (const [id, e] of this.hot) if (e.acc.pharmacyId === pharmacyId) this.hot.delete(id)
  }

  clear() {
    this.hot.clear()
  }

  stats() {
    const total = this.hits + this.misses
    return {
      lifeMs: LIFE_MS,
      kept: this.hot.size,
      hits: this.hits,
      misses: this.misses,
      // Доля запросов, обошедшихся без похода в базу
      saved: total ? Math.round((this.hits / total) * 100) + '%' : '—',
    }
  }
}
