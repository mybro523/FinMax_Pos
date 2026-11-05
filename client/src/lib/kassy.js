// ── Кассы магазина без интернета (версия 1.7.0) ──
//
// Главный компьютер показывает код подключения из 8 знаков (desktop/src/lan.mjs), касса его
// вводит. Знаки — без похожих (I, L, O, U); набранные похожие и русские буквы-двойники
// принимаются — как у основной части программы. Здесь же — сколько коду осталось и что
// написать на значке внизу.
//
// Перевод передаётся снаружи (t). Расширение в путях — файл загружают и проверки без сборщика.

export const PAIR_LEN = 8
const PAIR_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const LOOKALIKE = { O: '0', I: '1', L: '1', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: '0', Р: 'P', С: 'C', Т: 'T', Х: 'X' }

// Только знаки кода, заглавными, не длиннее 8
export function normalizePair(raw) {
  let out = ''
  for (const ch of String(raw ?? '').toUpperCase()) {
    const c = LOOKALIKE[ch] || ch
    if (PAIR_ABC.includes(c)) out += c
  }
  return out.slice(0, PAIR_LEN)
}

// «ABCD-EFGH» — как его показывает главный
export function formatPair(raw) {
  const c = normalizePair(raw)
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c
}

// Сколько коду осталось: «9:41»; вышел — пусто. deadline — момент по часам этого окна (главный
// присылает, сколько осталось, — часы окна и программы могут расходиться); не больше 10 минут
export function pairLeft(deadline, now = Date.now()) {
  const ms = Math.min((Number(deadline) || 0) - now, 10 * 60 * 1000)
  if (!(ms > 0)) return ''
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Что сказал главный — касса должна подключиться заново
export const REJOIN = new Set(['star', 'epoch', 'gone', 'base', 'key', 'off'])

// Значок внизу: на главном — сколько касс на связи, на кассе — связь с главным.
// null — касс нет (главный без касс): значок не нужен
export function soloNetBadge(net, t) {
  if (!net) return null
  if (net.role === 'register') {
    const m = net.main || {}
    if (REJOIN.has(m.error)) return { tone: 'warn', label: t('Подключите кассу заново') }
    if (m.error === 'version') return { tone: 'warn', label: t('Разные версии программы') }
    if (m.online) return { tone: 'ok', label: `${t('Главный компьютер')}: ${t('на связи')}` }
    const wait = net.pending > 0 ? ` · ${t('ждут')}: ${net.pending}` : ''
    return { tone: 'muted', label: `${t('Главный компьютер')}: ${t('нет связи')}${wait}` }
  }
  const regs = Array.isArray(net.registers) ? net.registers : []
  if (!regs.length) return null
  const on = regs.filter((r) => r.online).length
  return { tone: on > 0 ? 'ok' : 'muted', label: `${t('Кассы на связи')}: ${on} ${t('из')} ${regs.length}` }
}

// Связь кассы с главным — словами для окна (что случилось и что делать)
export function mainProblemText(error, t) {
  if (error === 'star') return t('Главный компьютер отключил эту кассу. Попросите на нём новый код подключения и подключите кассу заново.')
  if (error === 'epoch') return t('На главном компьютере загрузили копию базы. Подключите кассу заново — продажи этой кассы, которых нет на главном, перейдут на него.')
  if (error === 'gone') return t('Касса долго не была на связи с главным компьютером. Подключите кассу заново — сделанное на ней перейдёт на главный.')
  if (error === 'base') return t('Сделанное на главном компьютере не легло на эту кассу. Подключите кассу заново.')
  if (error === 'key' || error === 'off') return t('Главный компьютер больше не узнаёт эту кассу (его заводили заново или загрузили копию). Подключите кассу заново.')
  if (error === 'version') return t('На главном компьютере и на этой кассе разные версии программы. Обновите программу на всех компьютерах магазина до одной версии — до этого касса работает сама, сделанное на ней сохраняется и уйдёт после обновления.')
  if (error === 'refused') return t('Главный компьютер найден, но программа на нём не отвечает: она закрыта. Касса работает — всё уйдёт, когда программа на главном откроется.')
  if (error === 'timeout') return t('Главный компьютер не отвечает: он выключен, в другой сети или подключения закрыл брандмауэр Windows. Касса работает — всё уйдёт, когда связь вернётся.')
  return ''
}
