// ── Расхождения с касс: что именно не сошлось, человеческими словами ──
//
// Программа для Windows продаёт и без интернета, а сервер принимает её чеки позже —
// такими, какие они есть: товар уже отдан, деньги взяты. Если при этом что-то не
// сошлось с базой, сервер записывает расхождение, а владелец видит его на панели.
//
// Сервер присылает только вид расхождения и числа. Слова подбираются здесь: так
// они переводятся вместе со всем интерфейсом, а не приходят готовой русской фразой.
//
// Перевод передаётся снаружи (t), а надписи стоят в коде целиком — их наличие
// в таджикском словаре стережёт test/i18n.test.js.

// Подробности, которые сервер кладёт в расхождение текстом JSON (правка карточки, дубль)
export function noteOf(d) {
  try {
    const n = d?.note ? JSON.parse(d.note) : {}
    return n && typeof n === 'object' ? n : {}
  } catch {
    return {}
  }
}

// Поля карточки — как их называет сервер — в подписи для человека
const FIELD = {
  name: 'Название',
  barcode: 'Штрихкод',
  category: 'Категория',
  type: 'Тип товара',
  cost: 'Закупочная цена',
  price: 'Цена продажи',
  minStock: 'Минимальный остаток',
  unit: 'Единица',
  unitsPerPack: 'Штук в упаковке',
  dosage: 'Дозировка',
  analogIds: 'Аналоги',
  image: 'Фото',
  noExpiry: 'Без срока годности',
  analogs: 'С аналогами',
  phone: 'Телефон',
  note: 'Примечание',
  amount: 'Сумма',
  date: 'Дата',
  employeeId: 'Сотрудник',
  salaryMonth: 'Месяц зарплаты',
  bonusFrom: 'Бонус с',
  bonusTo: 'Бонус по',
  // Сотрудник и роль (1.4.16)
  active: 'Доступ',
  roleId: 'Роль',
  password: 'Пароль',
  fullName: 'ФИО',
  salary: 'Оклад',
  bonusPercent: 'Бонус, %',
  salaryDay: 'День зарплаты',
  description: 'Описание',
  permissions: 'Права',
}
const MONEY_FIELDS = new Set(['cost', 'price', 'amount', 'salary'])
export const fieldLabel = (f, t) => t(FIELD[f] || f)

// Значение поля для человека: деньги — деньгами, да/нет — словами, пусто — прочерком
function shown(field, v, t, money) {
  if (v === null || v === undefined || v === '') return '—'
  if (MONEY_FIELDS.has(field) && Number.isFinite(Number(v))) return money(v)
  if (typeof v === 'boolean') return v ? t('да') : t('нет')
  if (Array.isArray(v)) return String(v.length)
  if (field === 'date' && typeof v === 'string') return v.slice(0, 10)
  return String(v)
}

export function discrepancyTitle(kind, t) {
  if (kind === 'edit') return t('Правку сделали и на кассе без связи, и на сайте')
  if (kind === 'barcode') return t('Штрихкод уже был занят — товар получил внутренний код')
  if (kind === 'supdebt') return t('Поставщику заплатили больше, чем был долг')
  if (kind === 'sale') return t('Продано больше, чем было на складе')
  if (kind === 'writeoff') return t('Списано больше, чем было на складе')
  if (kind === 'price') return t('Цена в чеке не та, что была в базе')
  if (kind === 'return') return t('По чеку вернули больше, чем продали')
  if (kind === 'counted') return t('Операция кассы пришла после пересчёта остатка')
  if (kind === 'debt') return t('Сумма больше долга клиента')
  if (kind === 'supreturn') return t('Поставщику отдали больше, чем было на складе')
  return t('Расхождение')
}

// Подробность: сколько штук или какие цены. money — как печатать деньги
export function discrepancyDetail(d, t, money = String) {
  if (d.kind === 'edit') return editDetail(noteOf(d), t, money)
  if (d.kind === 'barcode') {
    const n = noteOf(d)
    const who = n.other?.name ? `«${n.other.name}»` : ''
    return n.edit
      ? `${t('код')} ${n.barcode || '—'} ${t('уже у товара')} ${who} — ${t('у этого товара остался прежний код')} ${n.kept || ''}`.trim()
      : `${t('код')} ${n.barcode || '—'} ${t('уже у товара')} ${who} — ${t('принят с кодом')} ${n.internal || ''}`.trim()
  }
  if (d.kind === 'supdebt') return `${t('оплачено')} ${money(d.checkPrice)}, ${t('долг был')} ${money(d.basePrice)}`
  if (d.kind === 'price') return `${t('в чеке')} ${money(d.checkPrice)}, ${t('в базе')} ${money(d.basePrice)}`
  if (d.kind === 'return') return `${t('лишних')} ${d.units} ${t('шт')}`
  if (d.kind === 'counted') return `${d.units} ${t('шт')} — ${t('остаток не менялся')}`
  if (d.kind === 'debt') return `${t('принято')} ${money(d.checkPrice)}, ${t('долг был')} ${money(d.basePrice)}`
  return `${t('сверх остатка')} ${d.units} ${t('шт')}`
}

// Правка карточки, сделанная и на кассе, и на сайте: по каждому полю — что прислала
// касса, что было на сайте и чья правка осталась (позже по времени — та и осталась)
function editDetail(n, t, money) {
  if (n.gone) return t('запись удалили, пока касса была без связи, — правка с кассы не применена')
  // Сотрудник, заведённый на кассе без связи: его логин за это время заняли в другом магазине
  if (n.loginTaken) return `${t('логин')} «${n.loginTaken}» ${t('уже был занят — сотрудник заведён под логином')} «${n.login || ''}»`
  if (n.tbl === 'Role' && n.sameName) return t('такая роль уже была — сотрудники с кассы назначены на неё, права остались как на сайте')
  if (n.passwordKept) return t('пароль с кассы не применён: его сменили на сайте позже')
  if (n.merged) return `${t('остаток с кассы не применён: эту карточку уже объединили с другой')} (${t('на кассе насчитали')} ${n.stock ?? 0} ${t('шт')})`
  if (n.sameName) return `${t('поставщик с таким названием уже был — долг на начало с кассы к нему не прибавлен')}: ${money(n.openingDebt ?? 0)}`
  if (n.deleteKept) return t('удаление с кассы не применено: запись поправили позже')
  if (n.kept) return t('правка с кассы не применена: запись поправили позже')
  const parts = (Array.isArray(n.fields) ? n.fields : []).map(
    (f) =>
      `${fieldLabel(f.field, t)}: ${t('на кассе')} ${shown(f.field, f.kassa, t, money)}, ${t('на сайте')} ${shown(f.field, f.server, t, money)} — ${
        f.won === 'kassa' ? t('осталась правка кассы') : t('осталась правка сайта')
      }`,
  )
  if (n.nameTaken) parts.push(`${n.tbl === 'Account' ? t('логин') : t('название')} «${n.nameTaken}» ${t('уже занято — осталось прежнее')}`)
  return parts.join('; ') || t('правку сделали в двух местах')
}

// Что владельцу с этим делать
export function discrepancyAdvice(kind, t) {
  if (kind === 'edit') return t('Проверьте карточку: если осталось не то, что нужно, поправьте её ещё раз.')
  if (kind === 'barcode') {
    return t('Если это один и тот же товар — объедините карточки кнопкой «Объединить». Остаток и история перейдут к основной карточке.')
  }
  if (kind === 'supdebt') return t('Долг поставщику ушёл в минус: теперь он должен магазину. Сверьте оплаты с поставщиком.')
  if (kind === 'price') return t('Цену меняли, пока касса была без связи? Если нет — спросите кассира.')
  if (kind === 'return') return t('Этот чек уже возвращали на другой кассе или на сайте. Проверьте, кому отдали деньги.')
  if (kind === 'counted') {
    return t('Касса оформила это без связи ещё до пересчёта остатка, а прислала после. Пересчёт её уже учёл, поэтому остаток сервер не менял. Сомневаетесь — пересчитайте товар на полке.')
  }
  if (kind === 'debt') {
    return t('Клиент заплатил (или ему зачли возвратом) больше, чем был должен: долг успели погасить на сайте или на другой кассе. Разницу нужно вернуть клиенту.')
  }
  return t('Пересчитайте товар на полке и поправьте остаток.')
}
