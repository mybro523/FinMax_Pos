// ── «Печатать чек при нажатии „Готово“» (1.7.13) ──
// Галочка в «Настройки → Чек и печать». Включена — кассир проводит продажу, жмёт «Готово»
// в окне чека, окно закрывается, а чек сам уходит на печать (как по кнопке «Печать»).
// Настройка этого компьютера: у каждой кассы свой принтер. Хранится в localStorage;
// хранилище недоступно — галочка просто выключена.
const KEY = 'finmax_pechat_gotovo'

export function pechatPoGotovo() {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setPechatPoGotovo(on) {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, '1')
    else globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* хранилище недоступно — настройка не запомнится */
  }
  return pechatPoGotovo()
}
