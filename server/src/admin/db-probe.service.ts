import { Injectable, Logger } from '@nestjs/common'
import { promises as dns } from 'node:dns'
import { AdminDbService } from './admin-db.service'

// ── Сколько стоит один поход в базу ──
//
// Замер снаружи показал: любой запрос к серверу платит около ста тридцати пяти
// миллисекунд за каждое обращение к базе. Для чтения это половина времени, для
// продажи — почти всё: она делает полтора десятка шагов подряд, и каждый стоит
// столько же.
//
// Снаружи причину не различить: то ли база далеко от сервера, то ли адрес ведёт
// через интернет, то ли имя долго разрешается. Отсюда, изнутри, видно точно —
// поэтому проверка живёт здесь, а не в моей голове.
//
// Что считать нормой: один-три миллисекунды, если база рядом. Всё, что больше
// десяти, означает, что запрос уходит за пределы дата-центра.

@Injectable()
export class DbProbe {
  private readonly log = new Logger('DbProbe')

  constructor(private admin: AdminDbService) {}

  // Адрес базы без пароля: показывать его владельцу сервиса можно, а хранить
  // в журналах и ответах — нет
  private target(): { host: string; port: string } {
    try {
      const u = new URL(process.env.DATABASE_URL || '')
      return { host: u.hostname, port: u.port || '5432' }
    } catch {
      return { host: 'неизвестен', port: '' }
    }
  }

  async check() {
    const { host, port } = this.target()

    // Разрешение имени. На внутренней сети Railway адреса шестой версии, и если
    // имя разрешается долго, это видно только отсюда.
    let dnsMs: number | null = null
    let address = ''
    try {
      const at = process.hrtime.bigint()
      const r = await dns.lookup(host, { verbatim: true })
      dnsMs = Number(process.hrtime.bigint() - at) / 1e6
      address = r.family === 6 ? 'IPv6' : 'IPv4'
    } catch {
      /* имя может не разрешаться вне Railway — на замер это не влияет */
    }

    // Самый дешёвый запрос, какой бывает. Всё, что он покажет сверх нуля, —
    // это дорога до базы и обратно.
    const runs: number[] = []
    for (let i = 0; i < 9; i++) {
      const at = process.hrtime.bigint()
      await this.admin.$queryRaw`SELECT 1`
      runs.push(Number(process.hrtime.bigint() - at) / 1e6)
    }
    runs.sort((a, b) => a - b)
    const med = runs[Math.floor(runs.length / 2)]

    // ── Сколько подключений отдаёт база ──
    // В это упирается вся затея со схемой на каждую аптеку: у каждой открытой
    // аптеки своё подключение (а то и несколько), а Postgres отдаёт их
    // ограниченное число на всех. Нагрузочная проверка показывает, что система
    // держит сотню аптек, но потолок надо знать не по опыту, а по числу —
    // и знать заранее, а не по отказам посреди рабочего дня.
    let limit: number | null = null
    let used: number | null = null
    try {
      const [a]: any = await this.admin.$queryRaw`SELECT current_setting('max_connections') AS max`
      limit = Number(a?.max) || null
      const [b]: any = await this.admin.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity`
      used = Number(b?.n) || null
    } catch {
      /* прав может не хватить — на замер скорости это не влияет */
    }

    return {
      host,
      port,
      address,
      region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || 'неизвестен',
      dnsMs: dnsMs === null ? null : Math.round(dnsMs * 10) / 10,
      // Подключений к базе: занято сейчас из скольких возможных
      connections: used === null || limit === null ? null : `${used} из ${limit}`,
      // Медиана, лучший и худший из девяти — по разбросу видно, дорога это
      // или случайная заминка
      queryMs: Math.round(med * 10) / 10,
      bestMs: Math.round(runs[0] * 10) / 10,
      worstMs: Math.round(runs[runs.length - 1] * 10) / 10,
      verdict:
        med <= 5
          ? 'база рядом — быстрее уже некуда'
          : med <= 20
            ? 'терпимо, но заметно дальше, чем должна быть'
            : 'база далеко: запрос уходит за пределы дата-центра. Сервер и Postgres должны быть в одном регионе',
    }
  }
}
