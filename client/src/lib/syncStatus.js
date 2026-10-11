// ── Состояние программы для Windows: что сказать человеку ──
//
// Основная часть программы присылает числа: есть ли связь, сколько операций ждёт
// отправки, сколько осталось работать без связи. Здесь из них получаются слова.
// Главное — кассир должен видеть, что всё сохранено: пропал интернет — чек не
// пропал, он лежит на этом компьютере и уйдёт на сервер сам.
//
// Перевод передаётся снаружи (t), а надписи стоят в коде целиком — их наличие
// в таджикском словаре стережёт test/i18n.test.js.

const HOUR = 3600000

// Сколько осталось работать без связи — словами: «5 дн.», «1 дн. 6 ч.» или «3 ч.».
// Счёт идёт на часы, с округлением до ближайшего: через несколько секунд после
// обмена осталось «7 дн.», а не «6 дн.» — иначе рядом со строкой «программа работает
// 7 дн.» это выглядело бы как потерянный день. Последний час — «1 ч.», а не «0 ч.»:
// работать ещё можно.
export function leftText(leftMs, t) {
  if (!(leftMs > 0)) return `0 ${t('ч.')}`
  const hours = Math.max(1, Math.round(leftMs / HOUR))
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  if (!days) return `${hours} ${t('ч.')}`
  return rest ? `${days} ${t('дн.')} ${rest} ${t('ч.')}` : `${days} ${t('дн.')}`
}

// ── Значок в шапке ──
// tone: ok — всё отправлено; busy — идёт отправка; warn — работаем без связи или
// что-то ждёт; bad — нужно вмешательство человека.
// Порядок проверок — от самого важного: если сервер что-то не принял, это важнее
// того, что интернет сейчас есть.
export function badgeOf(st, t) {
  if (!st) return null
  const pending = st.pending || 0
  if (st.licence?.expired) return { tone: 'bad', label: t('Нужна связь с сервером') }
  if (st.rejected > 0) return { tone: 'bad', label: `${t('Не принято сервером')}: ${st.rejected}` }
  if (st.refused) return { tone: 'bad', label: t('Сервер не принимает данные') }
  // Программа только что запущена и ещё не знает, есть ли связь
  if (st.checking) return { tone: 'busy', label: t('Проверяем связь…') }
  if (!st.online) {
    // Без связи осталось работать недолго — это важнее числа ждущих чеков
    if (st.licence?.warn) return { tone: 'warn', label: `${t('Нет интернета')} · ${t('осталось')} ${leftText(st.licence.leftMs, t)}` }
    // Часы компьютера показывают прошлое, а сверить время не с кем: чеки получают
    // неточное время, и исправить это может только человек (или вернувшаяся связь)
    if (st.clockDoubt) return { tone: 'warn', label: t('Нет интернета · проверьте часы компьютера') }
    return { tone: 'warn', label: pending > 0 ? `${t('Нет интернета')} · ${t('ждут отправки')}: ${pending}` : t('Нет интернета · касса работает') }
  }
  if (pending > 0) {
    // Связь есть, а отправить нечем: нужен вход автора этих чеков или владельца
    if (st.blocked) return { tone: 'warn', label: `${t('Ждут отправки')}: ${pending}` }
    return { tone: 'busy', label: `${t('Отправка')}: ${pending}` }
  }
  return { tone: 'ok', label: t('Всё отправлено') }
}

// Второй значок, поменьше: обновление скачано и ждёт перезапуска
export function updateBadgeOf(st, t) {
  return st?.update?.state === 'ready' ? { tone: 'busy', label: t('Обновление готово') } : null
}

// ── Что это была за операция (список «не принято сервером») ──
export function opTitle(type, t) {
  switch (type) {
    case 'sale':
      return t('Чек')
    case 'return':
      return t('Возврат')
    case 'arrival':
      return t('Приход')
    case 'writeoff':
      return t('Списание')
    case 'shift.open':
      return t('Открытие смены')
    case 'shift.close':
      return t('Закрытие смены')
    case 'debt.pay':
      return t('Погашение долга')
    case 'customer.create':
      return t('Новый клиент')
    case 'deferred.add':
    case 'deferred.remove':
      return t('Отложенный штрихкод')
    case 'expense':
      return t('Расход')
    case 'cash.move':
      return t('Наличные в смене')
    default:
      return t('Операция')
  }
}

// ── Обновление программы — одной строкой ──
export function updateText(update, t) {
  switch (update?.state) {
    case 'checking':
      return t('Проверяем, нет ли новой версии…')
    case 'downloading':
      return `${t('Скачивается версия')} ${update.version || ''}: ${update.percent || 0}%`
    case 'ready':
      return `${t('Версия')} ${update.version || ''} ${t('скачана. Она установится сама, когда программу закроют.')}`
    case 'idle':
      return t('Установлена последняя версия.')
    default:
      return t('Автообновление не настроено: новые версии ставятся установщиком.')
  }
}
