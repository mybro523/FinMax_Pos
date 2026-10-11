import { Prisma } from '@prisma/client'

// ── «Остаток пересчитан» ──
//
// Касса в программе для Windows продаёт и без интернета, а чеки присылает позже.
// Обычно сервер просто вычитает проданное из остатка. Но пока касса была без связи,
// остаток могли пересчитать: применили инвентаризацию или поправили число на полке
// в карточке товара. Пересчитывали то, что лежит на полке, — а проданного кассой
// там уже не было. Вычесть ту продажу ещё раз, когда чек наконец придёт, значит
// посчитать её дважды: остаток окажется меньше настоящего, и никто этого не заметит.
//
// Поэтому каждый пересчёт товара запоминается: когда он был и чем — листом
// инвентаризации или правкой в карточке. Операция кассы, сделанная РАНЬШЕ пересчёта,
// им уже учтена: документ записывается, а остаток не двигается. (Так же сайт
// поступает и со своими продажами: применение пересчёта ставит число поверх всего,
// что было до него.) Помнится не только последний пересчёт, а все недавние: операцию
// учёл первый пересчёт после неё, и поправлять — если поправлять — надо его итог.
//
// Отметки лежат в служебной таблице синхронизации: по строке на товар и пересчёт.
// Имя строки — «counted:<товар>|<когда>», значение — лист инвентаризации и строка
// товара в нём (у правки в карточке значение пустое).

type Tx = Prisma.TransactionClient

const KEY = 'counted:'
// Разделитель, которого нет ни в номере товара, ни в записи времени
const SEP = '|'
const CHUNK = 500
// Чем закрыта недостача листа инвентаризации: «invwo:<лист>» → номер списания
const SHORTAGE = 'invwo:'

export interface Count {
  at: Date
  // Лист инвентаризации и строка товара в нём. У правки в карточке их нет
  inventoryId?: string
  itemId?: string
  // Сколько штук было в упаковке, когда лист применяли: недостача оценена по этой
  // цене штуки, и поправлять её надо по ней же, даже если карточку с тех пор изменили
  upp?: number
}

export interface Counted {
  productId: string
  inventoryId?: string
  itemId?: string
  upp?: number
}

export async function markCounted(tx: Tx, entries: Counted[], at: Date = new Date()) {
  const seen = new Set<string>()
  const list = entries.filter((e) => e.productId && !e.productId.includes(SEP) && !seen.has(e.productId) && !!seen.add(e.productId))
  const when = at.toISOString()
  for (let n = 0; n < list.length; n += CHUNK) {
    const rows = list
      .slice(n, n + CHUNK)
      .map((e) => Prisma.sql`(${KEY + e.productId + SEP + when}, ${e.inventoryId && e.itemId ? JSON.stringify({ inv: e.inventoryId, item: e.itemId, upp: e.upp }) : ''})`)
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "SyncMeta" ("key", "value") VALUES ${Prisma.join(rows)}
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`)
  }
}

// Первый пересчёт каждого из этих товаров ПОСЛЕ указанного момента — тот, что учёл
// операцию, сделанную в этот момент. Товара в ответе нет — его с тех пор не пересчитывали
export async function firstCountAfter(tx: Tx, productIds: string[], moment: Date): Promise<Map<string, Count>> {
  const ids = [...new Set(productIds.filter(Boolean))]
  const out = new Map<string, Count>()
  const than = moment.getTime()
  for (let n = 0; n < ids.length; n += CHUNK) {
    const part = ids.slice(n, n + CHUNK)
    // Часть имени до разделителя — «counted:<товар>»; по ней и ищем
    const rows = await tx.$queryRaw<{ key: string; value: string }[]>(Prisma.sql`
      SELECT "key", "value" FROM "SyncMeta"
      WHERE "key" LIKE ${KEY + '%'} AND split_part("key", ${SEP}, 1) IN (${Prisma.join(part.map((id) => KEY + id))})`)
    for (const r of rows) {
      const cut = r.key.lastIndexOf(SEP)
      const productId = r.key.slice(KEY.length, cut)
      const at = Date.parse(r.key.slice(cut + 1))
      if (!Number.isFinite(at) || at <= than) continue
      const was = out.get(productId)
      if (was && was.at.getTime() <= at) continue
      let link: { inv?: string; item?: string; upp?: number } = {}
      try {
        link = r.value ? JSON.parse(r.value) : {}
      } catch {
        link = {}
      }
      const upp = Number.isInteger(link.upp) && link.upp! > 0 ? link.upp : undefined
      out.set(productId, { at: new Date(at), inventoryId: link.inv, itemId: link.item, upp })
    }
  }
  return out
}

// Базу подняли из копии: пересчёты, сделанные после этой копии, отменены вместе
// со всем остальным — и их отметки больше ничего не значат. Более ранние остаются:
// их итог в поднятых данных есть
export async function forgetCountedAfter(tx: Tx, moment: Date) {
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "SyncMeta" WHERE "key" LIKE ${KEY + '%'} AND split_part("key", ${SEP}, 2) > ${moment.toISOString()}`)
}

// ── Уборка давних отметок ──
// Касса не работает без связи дольше месяца, но выйти на связь может и позже:
// компьютер сломался, его починили через два месяца, а в нём — неотправленные чеки
// последнего дня. Если бы давние отметки убирались все, такие чеки вычлись бы из
// остатка, который с тех пор уже пересчитали, — то есть посчитались бы дважды.
//
// Поэтому у каждого товара остаётся последняя из давних отметок: по ней сервер
// по-прежнему видит, что после операции остаток пересчитывали, и остаток не двигает.
// Остальные давние отметки убираются. А раз их больше нет, какой именно пересчёт
// учёл столь давнюю операцию, уже не узнать — у оставшейся отметки стирается ссылка
// на лист: итог листа по такой операции не поправляется, владелец видит расхождение.
export async function pruneCounted(tx: Tx, before: Date) {
  const than = before.toISOString()
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "SyncMeta" m
    WHERE m."key" LIKE ${KEY + '%'} AND split_part(m."key", ${SEP}, 2) < ${than}
      AND EXISTS (
        SELECT 1 FROM "SyncMeta" n
        WHERE n."key" LIKE ${KEY + '%'}
          AND split_part(n."key", ${SEP}, 1) = split_part(m."key", ${SEP}, 1)
          AND split_part(n."key", ${SEP}, 2) < ${than}
          AND split_part(n."key", ${SEP}, 2) > split_part(m."key", ${SEP}, 2)
      )`)
  await tx.$executeRaw(Prisma.sql`
    UPDATE "SyncMeta" SET "value" = ''
    WHERE "key" LIKE ${KEY + '%'} AND split_part("key", ${SEP}, 2) < ${than} AND "value" <> ''`)
  // Товара больше нет — его отметки не нужны: остаток удалённого товара никто не двигает
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "SyncMeta" m
    WHERE m."key" LIKE ${KEY + '%'}
      AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE ${KEY} || p."id" = split_part(m."key", ${SEP}, 1))`)
  // Заодно — запомненные номера списаний (см. ниже) у листов, которые применены давно
  // или которых уже нет: поправлять их итог больше некому
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "SyncMeta" m WHERE m."key" LIKE ${SHORTAGE + '%'}
      AND NOT EXISTS (
        SELECT 1 FROM "Inventory" i
        WHERE i."id" = split_part(m."key", ':', 2) AND i."appliedAt" >= ${before}
      )`)
}

// ── Замок на лист инвентаризации ──
// Всё, что меняет лист или его итог, идёт по одному: сохранение насчитанного,
// применение, удаление — и поправка недостачи, когда касса присылает операцию,
// сделанную до пересчёта. Без замка два сохранения и применение одного листа читали
// бы его в разном состоянии, а две кассы, поправляющие недостачу разных товаров одного
// листа, записывали бы сумму списания друг поверх друга.
// Порядок по номеру — как у товаров: чтобы две операции не заперли друг друга.
export async function lockInventories(tx: Tx, ids: (string | null | undefined)[]) {
  const sorted = [...new Set(ids.filter((x): x is string => !!x))].sort()
  for (let n = 0; n < sorted.length; n += CHUNK) {
    const part = sorted.slice(n, n + CHUNK)
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Inventory" WHERE "id" IN (${Prisma.join(part)}) ORDER BY "id" FOR NO KEY UPDATE`)
  }
}

// ── Недостача листа инвентаризации ──
// Применение листа оформляет недостачу списанием. Номер этого списания запоминается:
// если позже выяснится, что часть «недостачи» была продана кассой без связи, поправить
// надо именно его.
export async function rememberShortageDoc(tx: Tx, inventoryId: string, writeOffId: string) {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "SyncMeta" ("key", "value") VALUES (${SHORTAGE + inventoryId}, ${writeOffId})
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`)
}

// Списание, которым закрыта недостача листа, — вместе с позициями. Нет такого — null.
//
// Запомненному номеру верим, пока по нему что-то находится. Номера может не быть или
// он может вести в никуда: базу поднимали из копии (в копии списание есть, а номер
// к тому времени стёрли — или наоборот), давние номера убраны уборкой. Тогда списание
// узнаётся по нему самому: оно создано применением листа и датировано ровно моментом
// применения. Иначе на тот же лист завелось бы второе списание, а первое так и
// осталось бы с завышенной недостачей.
export async function shortageDocOf(tx: Tx, inventoryId: string) {
  const known = (await tx.syncMeta.findUnique({ where: { key: SHORTAGE + inventoryId } }))?.value || null
  const byId = known ? await tx.writeOff.findUnique({ where: { id: known }, include: { items: true } }) : null
  if (byId) return byId
  const inv = await tx.inventory.findUnique({
    where: { id: inventoryId },
    select: { appliedAt: true, items: { select: { productId: true } } },
  })
  if (!inv?.appliedAt) return null
  const sameMoment = await tx.writeOff.findMany({ where: { source: 'inventory', date: inv.appliedAt }, include: { items: true }, orderBy: { id: 'asc' } })
  if (!sameMoment.length) return null
  // Два листа могли примениться в одну и ту же миллисекунду — тогда «списание с этой
  // датой» не обязательно наше. Чужое узнаётся по тому, что за ним уже записан другой
  // лист; а из оставшихся берётся то, где есть товары этого листа
  const claimed = await tx.syncMeta.findMany({ where: { key: { startsWith: SHORTAGE }, value: { in: sameMoment.map((d) => d.id) } } })
  const taken = new Set(claimed.filter((m) => m.key !== SHORTAGE + inventoryId).map((m) => m.value))
  const free = sameMoment.filter((d) => !taken.has(d.id))
  const mine = new Set(inv.items.map((i) => i.productId).filter(Boolean))
  const found =
    free.find((d) => d.items.some((i) => !!i.productId && mine.has(i.productId))) ||
    // Товары списания удалены из справочника — сверить не с чем; берём, если оно такое одно
    (free.length === 1 && free[0].items.every((i) => !i.productId) ? free[0] : null)
  if (found) await rememberShortageDoc(tx, inventoryId, found.id)
  return found
}

export async function forgetShortageDoc(tx: Tx, inventoryId: string) {
  await tx.syncMeta.deleteMany({ where: { key: SHORTAGE + inventoryId } })
}
