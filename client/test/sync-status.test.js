// Значок состояния программы для Windows: что кассир видит в шапке.
// Главное обещание — «кассир должен видеть, что всё сохранено». Здесь проверяется,
// что для каждого положения дел у значка есть своё слово и что важное не теряется
// за менее важным.
import test from 'node:test'
import assert from 'node:assert/strict'
import { badgeOf, opTitle, updateBadgeOf, updateText } from '../src/lib/syncStatus.js'
import { setLang, translate as t } from '../src/lib/i18n.js'

const DAY = 86400000
const HOUR = 3600000
const base = { online: true, syncing: false, blocked: false, refused: '', pending: 0, rejected: 0, licence: { checkedAt: null, unlimited: true } }
const st = (over) => ({ ...base, ...over })

test('пока программа не сообщила о себе, значка нет', () => {
  setLang('ru')
  assert.equal(badgeOf(null, t), null)
  assert.equal(updateBadgeOf(null, t), null)
})

test('связь есть и всё ушло — «Всё отправлено»', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st(), t), { tone: 'ok', label: 'Всё отправлено' })
  // Обычная сверка с сервером значок не дёргает: отправлять нечего — значит, всё отправлено
  assert.equal(badgeOf(st({ syncing: true }), t).tone, 'ok')
})

test('есть что отправлять — видно, сколько', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st({ pending: 3, syncing: true }), t), { tone: 'busy', label: 'Отправка: 3' })
  // Связь есть, а отправить нечем: нужен вход автора чеков или владельца
  assert.deepEqual(badgeOf(st({ pending: 2, blocked: true }), t), { tone: 'warn', label: 'Ждут отправки: 2' })
})

test('программа только что запущена: пока связь не проверена, «нет интернета» не говорим', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st({ online: false, checking: true }), t), { tone: 'busy', label: 'Проверяем связь…' })
  // Но то, что требует человека, видно и в эту секунду
  assert.equal(badgeOf(st({ online: false, checking: true, rejected: 1 }), t).tone, 'bad')
})

test('интернета нет — касса работает, и видно, сколько чеков ждёт', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st({ online: false }), t), { tone: 'warn', label: 'Нет интернета · касса работает' })
  assert.deepEqual(badgeOf(st({ online: false, pending: 12 }), t), { tone: 'warn', label: 'Нет интернета · ждут отправки: 12' })
})

test('1.6.5: срока работы без связи нет — значок им не пугает и кассу не «закрывает»', () => {
  setLang('ru')
  // Даже если бы пришла прежняя отметка «срок вышел» — значок о сроке не говорит
  const old = { expired: true, warn: true, leftMs: -HOUR }
  assert.deepEqual(badgeOf(st({ online: false, pending: 12, licence: old }), t), { tone: 'warn', label: 'Нет интернета · ждут отправки: 12' })
  assert.deepEqual(badgeOf(st({ online: false, licence: old }), t), { tone: 'warn', label: 'Нет интернета · касса работает' })
  assert.equal(badgeOf(st({ licence: old }), t).tone, 'ok')
  assert.ok(DAY > 0)
})

test('часы компьютера сбиты, а сверить время не с кем — значок просит проверить часы', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st({ online: false, pending: 3, clockDoubt: true }), t), { tone: 'warn', label: 'Нет интернета · проверьте часы компьютера' })
  // Связь есть — время сверено с сервером, беспокоить нечем
  assert.equal(badgeOf(st({ clockDoubt: false }), t).tone, 'ok')
  setLang('tg')
  try {
    assert.equal(badgeOf(st({ online: false, clockDoubt: true }), t).label, 'Интернет нест · соати компютерро санҷед')
  } finally {
    setLang('ru')
  }
})

test('то, что требует человека, перекрывает всё остальное', () => {
  setLang('ru')
  assert.deepEqual(badgeOf(st({ rejected: 2, pending: 5 }), t), { tone: 'bad', label: 'Не принято сервером: 2' })
  assert.deepEqual(badgeOf(st({ refused: 'лишнее поле', pending: 5 }), t), { tone: 'bad', label: 'Сервер не принимает данные' })
})

test('обновление: готовность видна отдельным значком, а ход — словами', () => {
  setLang('ru')
  assert.equal(updateBadgeOf(st({ update: { state: 'downloading', percent: 40 } }), t), null)
  assert.deepEqual(updateBadgeOf(st({ update: { state: 'ready', version: '1.2.0' } }), t), { tone: 'busy', label: 'Обновление готово' })
  assert.equal(updateText({ state: 'downloading', version: '1.2.0', percent: 40 }, t), 'Скачивается версия 1.2.0: 40%')
  assert.equal(updateText({ state: 'ready', version: '1.2.0' }, t), 'Версия 1.2.0 скачана. Она установится сама, когда программу закроют.')
  assert.equal(updateText({ state: 'idle' }, t), 'Установлена последняя версия.')
  assert.match(updateText({ state: 'off' }, t), /не настроено/)
  assert.match(updateText(undefined, t), /не настроено/)
})

test('у каждой операции кассы есть название — и у незнакомой тоже', () => {
  setLang('ru')
  const types = ['sale', 'return', 'arrival', 'writeoff', 'shift.open', 'shift.close', 'debt.pay', 'customer.create', 'deferred.add', 'expense']
  const names = types.map((x) => opTitle(x, t))
  assert.equal(new Set(names).size, types.length, 'названия совпали: ' + names.join(' | '))
  assert.equal(opTitle('чего-то-нового', t), 'Операция')
})

test('на таджикском значок и подписи переведены', () => {
  setLang('tg')
  try {
    assert.equal(badgeOf(st(), t).label, 'Ҳама фиристода шуд')
    assert.equal(badgeOf(st({ online: false, pending: 4 }), t).label, 'Интернет нест · мунтазири фиристодан: 4')
    assert.equal(badgeOf(st({ pending: 3 }), t).label, 'Фиристодан: 3')
    assert.equal(t('без ограничения'), 'бе маҳдудият')
    assert.equal(t('Последняя связь с сервером'), 'Алоқаи охирин бо сервер')
    assert.equal(updateText({ state: 'ready', version: '1.2.0' }, t), 'Версияи 1.2.0 боргирӣ шуд. Он ҳангоми пӯшидани барнома худаш насб мешавад.')
    assert.equal(opTitle('shift.open', t), 'Кушодани баст')
    assert.equal(opTitle('expense', t), 'Хароҷот')
  } finally {
    setLang('ru')
  }
})
