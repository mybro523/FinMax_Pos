// ── Отказы проверки входных данных — по-человечески ──
// Проверка полей запроса отвечает своими текстами, и они английские: «password must
// be longer than or equal to 6 characters». Это уходило прямо на экран кассиру
// в программе, которая целиком на русском и таджикском.
//
// Дописывать русский текст к каждому правилу — сорок мест, и первое же новое поле
// про это забудет. Поэтому перевод здесь, на границе ответа: он ловит сами formulы,
// а не отдельные поля, и работает для всего, что появится потом.

// Как называются поля по-человечески. Чего нет в списке — покажем как есть:
// «amount: не меньше 0.01» всё равно понятнее английской фразы.
const FIELDS: Record<string, string> = {
  password: 'Пароль',
  newPassword: 'Новый пароль',
  oldPassword: 'Текущий пароль',
  ownerPassword: 'Пароль владельца',
  ownerLogin: 'Логин владельца',
  name: 'Название',
  code: 'Код',
  phone: 'Телефон',
  city: 'Город',
  note: 'Примечание',
  barcode: 'Штрихкод',
  category: 'Категория',
  qty: 'Количество',
  units: 'Количество',
  pieces: 'Штуки',
  cost: 'Закупочная цена',
  price: 'Цена продажи',
  amount: 'Сумма',
  discount: 'Скидка',
  stock: 'Остаток',
  minStock: 'Минимальный остаток',
  unitsPerPack: 'Штук в упаковке',
  actualUnits: 'Насчитано',
  months: 'Число месяцев',
  trialDays: 'Пробный период',
  offlineDays: 'Дней без связи',
  paidUntil: 'Дата оплаты',
  expiryDate: 'Срок годности',
  openingCash: 'Наличные на начало',
  countedCash: 'Пересчитано наличных',
  payment: 'Оплата',
  refund: 'Возврат денег',
  reason: 'Причина',
  method: 'Способ оплаты',
  role: 'Роль',
  items: 'Позиции',
  scope: 'Охват',
  supplier: 'Поставщик',
  customerId: 'Клиент',
  productId: 'Товар',
  saleId: 'Чек',
  fromCash: 'Из кассы',
  shiftId: 'Смена',
  date: 'Дата',
  payVia: 'Сервис перевода',
  refundVia: 'Сервис перевода',
  kind: 'Вид операции',
  openingDebt: 'Начальный долг',
  debt: 'Долг',
  supplierId: 'Поставщик',
}

const field = (raw: string) => FIELDS[raw] || raw

// Формулы, которыми отвечает проверка. Порядок важен: более общие — ниже.
const RULES: { re: RegExp; ru: (m: RegExpMatchArray) => string }[] = [
  { re: /^(\S+) must be longer than or equal to (\d+) characters$/, ru: (m) => `${field(m[1])}: не короче ${m[2]} символов` },
  { re: /^(\S+) must be shorter than or equal to (\d+) characters$/, ru: (m) => `${field(m[1])}: не длиннее ${m[2]} символов` },
  { re: /^(\S+) must not be less than (.+)$/, ru: (m) => `${field(m[1])}: не меньше ${m[2]}` },
  { re: /^(\S+) must not be greater than (.+)$/, ru: (m) => `${field(m[1])}: не больше ${m[2]}` },
  { re: /^(\S+) must be an integer number$/, ru: (m) => `${field(m[1])}: только целое число` },
  { re: /^(\S+) must be a number.*$/, ru: (m) => `${field(m[1])}: только число` },
  { re: /^(\S+) must be a string$/, ru: (m) => `${field(m[1])}: только текст` },
  { re: /^(\S+) must be a boolean value$/, ru: (m) => `${field(m[1])}: только «да» или «нет»` },
  { re: /^(\S+) must be one of the following values: (.+)$/, ru: (m) => `${field(m[1])}: допустимо только — ${m[2]}` },
  { re: /^(\S+) should not be empty$/, ru: (m) => `${field(m[1])}: не может быть пустым` },
  { re: /^(\S+) must be an array$/, ru: (m) => `${field(m[1])}: ожидается список` },
  { re: /^(\S+) must contain at least (\d+) elements$/, ru: (m) => `${field(m[1])}: нужна хотя бы ${m[2]} позиция` },
  { re: /^(\S+) must be a valid ISO 8601 date string$/, ru: (m) => `${field(m[1])}: дата в неверном виде` },
  { re: /^(\S+) must be a valid enum value$/, ru: (m) => `${field(m[1])}: недопустимое значение` },
  { re: /^property (\S+) should not exist$/, ru: (m) => `Лишнее поле: ${field(m[1])}` },
]

// Перевести одно сообщение. Незнакомое возвращаем как есть: показать английский
// текст неприятно, но потерять смысл отказа — хуже.
export function ruValidation(message: string): string {
  const text = String(message ?? '').trim()
  for (const rule of RULES) {
    const m = text.match(rule.re)
    if (m) return rule.ru(m)
  }
  return text
}

// Проверка присылает список сообщений, по одному на нарушенное правило
export function ruValidationList(message: unknown): unknown {
  if (Array.isArray(message)) return message.map((m) => ruValidation(String(m)))
  if (typeof message === 'string') return ruValidation(message)
  return message
}
