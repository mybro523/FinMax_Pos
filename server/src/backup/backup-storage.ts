import { createHash, createHmac } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ── Куда уезжают автоматические копии ──
// Копия, лежащая рядом с базой, спасает только от ошибки в данных. От потери
// сервера — нет: исчезнут оба разом. Поэтому настоящее назначение — хранилище
// снаружи, S3-совместимое: Cloudflare R2, Backblaze B2 и подобные.
//
// Второй способ — папка на диске. Он годится, только если это подключённый том,
// переживающий перезапуск. На обычной файловой системе контейнера копии исчезнут
// при первой же выкладке, а хуже несуществующих копий только копии, в которые
// верят.
//
// Не настроено ничего — не делаем вид, что копии есть. Сервер скажет об этом
// в журнале и не станет их снимать вовсе.

export interface BackupTarget {
  readonly kind: string
  readonly where: string
  put(key: string, body: Buffer, contentType: string): Promise<void>
  // Убрать лишнее, если хранилище это умеет само не делать
  prune?(prefix: string, keep: number): Promise<number>
}

// ── Подпись запросов к S3 (AWS Signature V4) ──
// Библиотеки для этого весят десятки мегабайт и тянут за собой половину экосистемы.
// Сам алгоритм — четыре вложенных HMAC и одна строка по правилам; ровно столько
// здесь и написано. Проект уже так поступил с паролями: встроенный crypto вместо
// внешней зависимости.
const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

// Ключ подписи выводится из секрета, даты, региона и службы. Он один на сутки,
// поэтому его и называют временным: утёкший ключ протухнет сам.
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request')
}

export interface S3Config {
  endpoint: string // https://<account>.r2.cloudflarestorage.com
  bucket: string
  accessKey: string
  secretKey: string
  region: string
}

// Готовые заголовки для PUT объекта. Вынесено отдельно, чтобы подпись можно было
// проверить, не поднимая сеть.
export function signPut(cfg: S3Config, key: string, body: Buffer, contentType: string, now: Date) {
  const url = new URL(`${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}/${key}`)
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date = amzDate.slice(0, 8)
  const payloadHash = sha256hex(body)

  // Путь в подписи должен быть закодирован так же, как в самом запросе
  const canonicalUri = url.pathname
    .split('/')
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/')

  const headers: Record<string, string> = {
    host: url.host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h].trim()}\n`)
    .join('')

  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${cfg.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(cfg.secretKey, date, cfg.region, 's3'))
    .update(stringToSign)
    .digest('hex')

  return {
    url: url.toString(),
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

class S3Target implements BackupTarget {
  readonly kind = 'S3'
  readonly where: string
  constructor(private cfg: S3Config) {
    this.where = `${cfg.endpoint}/${cfg.bucket}`
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { url, headers } = signPut(this.cfg, key, body, contentType, new Date())
    // Отправляем байты без копирования. Приведение типа здесь не от лени:
    // описания типов Node отстают от самой платформы — она такое тело принимает
    // с восемнадцатой версии, а в типах этого ещё нет. Обновление типов до
    // двадцать второй версии ломает сгенерированные клиенты Prisma, поэтому
    // расхождение обходим здесь, в одной строке, а не во всём проекте.
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit
    const res = await fetch(url, { method: 'PUT', headers, body: bytes })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`хранилище отказало: ${res.status} ${text.slice(0, 200)}`)
    }
  }
  // Уборка не нужна: имена ячеек повторяются по кругу, и новая копия затирает
  // самую старую сама. Так не приходится ни перечислять содержимое хранилища,
  // ни удалять из него — а значит, и права нужны самые скромные.
}

class DirTarget implements BackupTarget {
  readonly kind = 'папка'
  constructor(readonly where: string) {}

  async put(key: string, body: Buffer): Promise<void> {
    const path = join(this.where, key)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, body)
  }

  async prune(prefix: string, keep: number): Promise<number> {
    const dir = join(this.where, prefix)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).sort()
    } catch {
      return 0
    }
    const extra = files.slice(0, Math.max(0, files.length - keep))
    for (const f of extra) await unlink(join(dir, f)).catch(() => {})
    return extra.length
  }
}

// Что настроено в окружении. Ничего — значит копии не снимаются вовсе.
export function backupTarget(env: NodeJS.ProcessEnv = process.env): BackupTarget | null {
  const { BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY, BACKUP_S3_SECRET } = env
  if (BACKUP_S3_ENDPOINT && BACKUP_S3_BUCKET && BACKUP_S3_KEY && BACKUP_S3_SECRET) {
    return new S3Target({
      endpoint: BACKUP_S3_ENDPOINT,
      bucket: BACKUP_S3_BUCKET,
      accessKey: BACKUP_S3_KEY,
      secretKey: BACKUP_S3_SECRET,
      region: env.BACKUP_S3_REGION || 'auto',
    })
  }
  if (env.BACKUP_DIR) return new DirTarget(env.BACKUP_DIR)
  return null
}
