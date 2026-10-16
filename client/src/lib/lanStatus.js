// ── Обмен кассами по местной сети: что сказать человеку ──
//
// Основная часть программы присылает, какие соседние кассы найдены, когда был последний
// обмен с каждой и что пошло не так. Здесь из этого получаются слова. Перевод передаётся
// снаружи (t), надписи стоят в коде целиком — их перевод стережёт test/i18n.test.js.
//
// Файл ни от чего не зависит: его загружают и проверки, без сборщика.

// Сколько соседей на связи прямо сейчас
export const lanOnline = (lan) => (Array.isArray(lan?.peers) ? lan.peers.filter((p) => p.online).length : 0)

// Значок в шапке: только когда обмен по сети включён (у магазина больше одной кассы)
export function lanBadgeOf(st, t) {
  const lan = st?.lan
  if (!lan?.enabled) return null
  const n = lanOnline(lan)
  if (n > 0) return { tone: 'ok', label: `${t('Кассы в сети')}: ${n}` }
  return { tone: 'muted', label: t('Кассы в сети: нет связи') }
}

// Что не так со связью с соседом — коротко и с тем, что делать
export function lanErrorText(code, t) {
  switch (code) {
    case 'key':
      return t('Это касса другого магазина: ключи не совпадают.')
    case 'self':
      return t('Это адрес этого же компьютера.')
    case 'off':
      return t('На том компьютере обмен по сети выключен: там ещё не входили или касса одна.')
    case 'refused':
      return t('Компьютер найден, но программа на нём не отвечает: она закрыта или порт занят.')
    case 'notfound':
      return t('Компьютер с таким именем в сети не найден. Впишите его адрес цифрами.')
    case 'timeout':
      return t('Компьютер не отвечает: он выключен, в другой сети или подключения закрыл брандмауэр Windows.')
    case 'error':
      return t('Связаться не удалось. Программа попробует ещё раз сама.')
    default:
      return ''
  }
}

// Сосед одной строкой: «Касса 2 · 192.168.1.5 · на связи»
export function lanPeerLine(p, t, fmt = (x) => x) {
  const parts = [p.address || '—']
  if (p.online) parts.push(t('на связи'))
  else if (p.okAt) parts.push(`${t('последний обмен')} ${fmt(p.okAt)}`)
  else parts.push(t('ещё не обменивались'))
  return parts.join(' · ')
}
