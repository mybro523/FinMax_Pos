// ── Данные аптеки на чеке: адрес, телефон, подпись внизу ──
//
// Название аптеки приходит с сервера вместе со входом, а эти три строки владелец
// вписывает сам в Настройках. Хранятся они на этом устройстве (localStorage) под
// кодом аптеки: чек печатает касса, и то, что на нём написано, — дело каждой кассы.
// На другой кассе владелец вписывает их ещё раз (обычно касса одна-две).
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.

const KEY = 'apteka_rekvizity_'

// Пустые реквизиты — валидные: чек печатается и без адреса с телефоном
export const REKVIZITY_PUSTO = { address: '', phone: '', footer: '' }

// Строки режутся по длине: чековая лента узкая, а поле ввода не должно превращаться
// в сочинение. Переводы строк убираются — каждая запись занимает одну строку чека
const chistka = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)

export function getRekvizity(code) {
  try {
    const raw = localStorage.getItem(KEY + (code || 'default'))
    const r = raw ? JSON.parse(raw) : null
    return r && typeof r === 'object'
      ? { address: chistka(r.address), phone: chistka(r.phone), footer: chistka(r.footer) }
      : { ...REKVIZITY_PUSTO }
  } catch {
    return { ...REKVIZITY_PUSTO } // приватный режим или испорченная запись
  }
}

export function saveRekvizity(code, data) {
  const clean = { address: chistka(data?.address), phone: chistka(data?.phone), footer: chistka(data?.footer) }
  try {
    localStorage.setItem(KEY + (code || 'default'), JSON.stringify(clean))
  } catch {
    /* негде хранить — чек просто останется без адреса */
  }
  return clean
}
