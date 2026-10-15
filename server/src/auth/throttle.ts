// ── Защита входа от подбора пароля ──
// Пароль от шести символов удобен кассиру, который вводит его по десять раз за
// смену, но машина перебирает такой за считанные дни. А вход открыт из интернета.
// Поэтому считаем неудачные попытки и после нескольких подряд закрываем вход.
//
// ── Почему по устройству, а не только по имени ──
// Сначала строгий счёт был только по имени сотрудника, а по адресу устройства
// стоял мягкий порог в тридцать попыток. Дыра нашлась сразу и на живой системе:
// пять раз промахнулся под одним логином — вход под ним закрыт, но под соседним
// можно пробовать дальше, и так до тридцати. То есть строгий порог обходился
// сменой имени, а имена в этой системе угадываются легко: логин обычно совпадает
// с кодом магазина.
//
// Теперь строго и там, и там. Пять промахов с устройства закрывают вход целиком,
// какими бы именами ни пользовались.
//
// ── Почему ступенями, а не сразу на четверть часа ──
// В магазине все устройства выходят в сеть через один адрес: касса, компьютер
// владельца, телефон. Пятнадцать минут за пять опечаток означали бы, что забывчивый
// кассир закрывает вход всему магазину — и владельцу тоже. А на мобильном интернете
// один адрес нередко делят несколько заведений сразу.
//
// Поэтому первая блокировка короткая, а каждая следующая серия промахов дороже
// предыдущей: минута, пять минут, пятнадцать. Человек, забывший пароль, подождёт
// минуту. Машине это оставляет от силы полторы сотни попыток в сутки — при
// шестизначном пароле перебор занял бы годы.
//
// Успешный вход стирает всё: опечатались дважды и вошли — ступенька не вырастет.
//
// Счётчик живёт в памяти процесса. Для одного сервера этого достаточно: перезапуск
// случается редко и сбрасывает блокировки — неприятно, но безопасность держится
// на самом пароле, а это лишь замедление подбора.

export interface ThrottleOptions {
  limit?: number // сколько неудач подряд допустимо
  steps?: number[] // на сколько закрывается вход после первой, второй, третьей серии…
  blockMs?: number // одна ступень вместо нескольких (для мест, где рост не нужен)
  windowMs?: number // за какое время неудачи считаются «подряд»
  forgetMs?: number // через сколько тишины забываем и саму ступеньку
  maxKeys?: number // предохранитель от разрастания памяти
}

interface Entry {
  fails: number // неудач в нынешней серии
  firstFailAt: number
  lastFailAt: number
  blockedUntil: number
  step: number // сколько серий уже набрано — по нему берётся длина блокировки
}

const MIN = 60_000
// Минута, пять, пятнадцать — дальше пятнадцать за каждую следующую серию
const DEFAULT_STEPS = [MIN, 5 * MIN, 15 * MIN]

export class LoginThrottle {
  private readonly hits = new Map<string, Entry>()
  private readonly limit: number
  private readonly steps: number[]
  private readonly windowMs: number
  private readonly forgetMs: number
  private readonly maxKeys: number

  constructor(opts: ThrottleOptions = {}) {
    this.limit = opts.limit ?? 5
    this.steps = opts.steps ?? (opts.blockMs ? [opts.blockMs] : DEFAULT_STEPS)
    this.windowMs = opts.windowMs ?? 15 * MIN
    this.forgetMs = opts.forgetMs ?? 60 * MIN
    this.maxKeys = opts.maxKeys ?? 10_000
  }

  // Сколько миллисекунд осталось ждать. 0 — вход разрешён.
  retryAfterMs(key: string, now = Date.now()): number {
    const e = this.hits.get(key)
    if (!e) return 0
    if (e.blockedUntil > now) return e.blockedUntil - now
    // Запись держим и после снятия блокировки: в ней помнится ступенька, и без
    // неё вторая серия промахов стоила бы столько же, сколько первая, — то есть
    // перебор шёл бы вечно по пять попыток в минуту
    if (now - e.lastFailAt > this.forgetMs) this.hits.delete(key)
    return 0
  }

  // Наибольшее ожидание среди ключей (имя и адрес проверяются вместе)
  retryAfterAny(keys: string[], now = Date.now()): number {
    return keys.reduce((max, k) => Math.max(max, this.retryAfterMs(k, now)), 0)
  }

  // Записать неудачную попытку
  fail(key: string, now = Date.now()): void {
    this.sweep(now)
    const e = this.hits.get(key)

    // Давно ничего не путал — забываем и промахи, и ступеньку
    if (!e || now - e.lastFailAt > this.forgetMs) {
      this.hits.set(key, { fails: 1, firstFailAt: now, lastFailAt: now, blockedUntil: 0, step: 0 })
      return
    }

    // Прошлая серия оборвалась давно — начинаем новую, но ступеньку помним
    if (now - e.firstFailAt > this.windowMs && e.blockedUntil <= now) {
      e.fails = 1
      e.firstFailAt = now
      e.lastFailAt = now
      return
    }

    e.fails += 1
    e.lastFailAt = now
    if (e.fails >= this.limit) {
      e.blockedUntil = now + this.steps[Math.min(e.step, this.steps.length - 1)]
      e.step += 1
      // Следующая серия считается с нуля — иначе каждая новая ошибка после
      // блокировки удлиняла бы её заново
      e.fails = 0
      e.firstFailAt = now
    }
  }

  failMany(keys: string[], now = Date.now()): void {
    keys.forEach((k) => this.fail(k, now))
  }

  // Успешный вход снимает подозрения полностью, вместе со ступенькой
  success(keys: string[]): void {
    keys.forEach((k) => this.hits.delete(k))
  }

  // Сколько ключей под наблюдением — для проверок и наблюдения за памятью
  get size(): number {
    return this.hits.size
  }

  // Убираем отработавшие записи, чтобы карта не росла бесконечно
  private sweep(now: number): void {
    if (this.hits.size < this.maxKeys) {
      // Дешёвая уборка: раз в сотню записей проходим и чистим протухшее
      if (this.hits.size % 100 !== 0) return
    }
    for (const [k, e] of this.hits) {
      if (e.blockedUntil <= now && now - e.lastFailAt > this.forgetMs) this.hits.delete(k)
    }
    // Если и после уборки записей слишком много — идёт массовый перебор.
    // Держать их все незачем: чистим целиком, блокировки восстановятся сами.
    if (this.hits.size >= this.maxKeys) this.hits.clear()
  }

  // Для сообщений пользователю
  static humanWait(ms: number): string {
    const sec = Math.ceil(ms / 1000)
    if (sec < 60) return `${sec} сек.`
    return `${Math.ceil(sec / 60)} мин.`
  }
}
