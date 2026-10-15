import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AdminDbService } from './admin-db.service'
import { withSchema } from '../common/db-url'

const run = promisify(execFile)
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations')

// Запускаем CLI Prisma напрямую тем же Node, а не через npx. На Windows npx — это
// файл .cmd, а Node отказывается запускать такие без оболочки; с оболочкой же
// аргументы склеиваются в строку, и путь с пробелом разваливает вызов. Прямой путь
// к файлу работает одинаково и в разработке, и в образе.
const PRISMA_CLI = require.resolve('prisma/build/index.js')

// Имя схемы попадает в SQL напрямую: подставить его параметром нельзя, так устроен
// сам язык. Поэтому перед подстановкой проверяем его целиком — не «экранируем»,
// а именно не пропускаем ничего, кроме букв, цифр и подчёркиваний. Имена строит
// schemaNameFor, эта проверка — вторая линия на случай, если однажды их начнут
// задавать откуда-то ещё.
const SAFE_SCHEMA = /^tenant_[a-z0-9_]{1,40}$/

@Injectable()
export class TenantSchemaService {
  private readonly log = new Logger('TenantSchema')

  constructor(private admin: AdminDbService) {}

  // Последняя миграция в наборе — её имя запоминается у магазина, чтобы потом было
  // видно, какие схемы уже обновлены, а какие ещё нет
  latestMigration(): string {
    if (!existsSync(MIGRATIONS_DIR)) return ''
    const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    return names[names.length - 1] || ''
  }

  private assertSafe(schema: string): void {
    if (!SAFE_SCHEMA.test(schema)) {
      throw new InternalServerErrorException(`Недопустимое имя схемы: «${schema}»`)
    }
  }

  // Prisma заводит в схеме таблицы, но саму схему не создаёт, а подключение
  // указывает сразу внутрь неё. Поэтому создаём её сами, до миграций.
  async ensureSchema(schema: string): Promise<void> {
    this.assertSafe(schema)
    await this.admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  }

  // Убрать схему со всем содержимым. Вызывается только тогда, когда заведение
  // магазина не удалось и надо убрать за собой: у работающего магазина это стёрло бы
  // всё — товары, продажи, долги — и восстановить их было бы неоткуда.
  async dropSchema(schema: string): Promise<void> {
    this.assertSafe(schema)
    await this.admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }

  // Привести схему магазина к текущему набору миграций.
  //
  // Запускаем prisma migrate deploy отдельным процессом, а не выполняем SQL сами.
  // Своими руками пришлось бы вести и учёт применённого — с контрольными суммами
  // и порядком, — а это ровно та часть, ошибка в которой обнаруживается позже
  // всего и стоит дороже всего. Две секунды на магазин того стоят; там, где схем
  // сотни, это делается фоновой задачей, а не при обращении.
  async migrate(schema: string): Promise<void> {
    this.assertSafe(schema)
    try {
      const { stdout, stderr } = await run(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
        timeout: 180000,
        // Схема магазина подставляется в тот же DATABASE_URL, из которого Prisma
        // берёт адрес: своей переменной у неё нет
        env: { ...process.env, DATABASE_URL: withSchema(process.env.DATABASE_URL || '', schema) },
      })
      const out = (stdout || '') + (stderr || '')
      if (out.trim()) this.log.log(`«${schema}»: ${out.trim().split('\n').pop()}`)
    } catch (e: any) {
      const out = (e?.stdout || '') + (e?.stderr || '') || e?.message || String(e)
      this.log.error(`Миграции схемы «${schema}» не прошли: ${out}`)
      throw new InternalServerErrorException(`Не удалось подготовить базу магазина: ${out.slice(0, 300)}`)
    }
  }
}
