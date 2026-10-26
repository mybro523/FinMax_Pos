// ── Отмена чека ──
//
// Кнопка «Отмена» в окне чека отменяет только что проведённую продажу возвратом всего
// чека: товар — обратно на полку, деньги — тем же способом, каким платили (наличные из
// кассы, на карту, переводом, а продажа в долг уменьшает долг клиента). Товары снова
// оказываются в корзине — кассир поправит и проведёт заново.
//
// Запись возврата несёт пометку OTMENA_CHEKA. По ней отмену видно в журнале возвратов,
// в Z-отчёте, в истории долга клиента и в отчёте «Чеки», а отчёт продаж такой чек не
// считает: продажи не было. Пометка хранится как есть, по-русски; на экране и на бумаге
// переводится вместе с интерфейсом.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { lineNet, lineUnits, uppOf } from './units.js'

export const OTMENA_CHEKA = 'Отмена чека'
export const isOtmena = (r) => String(r?.note || '').trim() === OTMENA_CHEKA

// Чеки, отменённые кнопкой «Отмена»: id продаж
export const otmenennyeCheki = (returns) => new Set((returns || []).filter(isOtmena).map((r) => r.saleId).filter(Boolean))

const SPOSOBY = ['cash', 'card', 'transfer', 'debt']

// Возврат, которым отменяется продажа (то, что получает returnGoods из db/ops.js):
// все позиции целиком и на полку, деньги — тем же способом, каким платили
export function otmenaVozvrat(sale) {
  const refund = SPOSOBY.includes(sale?.payment) ? sale.payment : 'cash'
  return {
    saleId: sale?.id,
    refund,
    refundVia: refund === 'transfer' ? sale?.payVia || '' : '',
    customerId: refund === 'debt' ? sale?.customerId || sale?.customer?.id || '' : '',
    note: OTMENA_CHEKA,
    // Один ключ на продажу: отмену можно нажать ещё раз после оборванного ответа
    clientId: sale?.id ? 'otmena:' + sale.id : '',
    total: Number(sale?.total) || 0,
    lines: (sale?.items || [])
      .filter((i) => i && i.productId && lineUnits(i) > 0)
      .map((i) => ({
        productId: i.productId,
        name: i.name,
        units: lineUnits(i),
        unit: i.unit || '',
        unitsPerPack: uppOf(i),
        price: Number(i.price) || 0,
        cost: Number(i.cost) || 0,
        amount: lineNet(i),
        restock: true,
      })),
  }
}
