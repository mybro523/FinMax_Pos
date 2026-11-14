import { useMemo, useState } from 'react'
import { LuReceipt, LuPrinter, LuArrowLeft } from 'react-icons/lu'
import { Modal, PAYMENTS, useToast } from './ui'
import PrintDoc from './PrintDoc'
import TicketView from './TicketView'
import { useCollection, money } from '../db/store'
import { useAuth } from '../db/auth'
import { fmtDateTime, chekNomer } from '../lib/time'
import { useT } from '../lib/i18n'
import { spisokChekov } from '../lib/otchety'
import { isOtmena } from '../lib/otmena'
import { sEdinicami } from '../lib/units'
import { saleTicket } from '../lib/ticket'
import { getRekvizity } from '../lib/rekvizity'
import { pechatTicket } from '../lib/pechat'

// ── Чеки: список и чек целиком ──
// Общие окна для всех страниц: «Продажи за смену», строка истории смен, карточки
// Главной и отчётов. Список — чек одной строкой (номер, время, кассир, оплата, сумма);
// по клику — сам чек, как на бумаге, с кнопкой «Печать» (повтор). Окна не стоят
// друг на друге: чек открывается вместо списка, «Назад» возвращает к списку —
// так Esc закрывает ровно одно окно.

export const payLabel = (p, t) => t(PAYMENTS[p]?.label || 'Наличные')

// Пометка у чека в списке: отменён или был возврат
export const chekMark = (r, t) => (r.otmena ? t('Отменён') : r.vozvrat > 0 ? `${t('Возврат')} ${money(r.vozvrat)}` : '')

// Чек в том же виде, что на бумаге (lib/ticket.js), и «Печать» — тот же чек ещё раз:
// на чековый принтер или через экран печати. Строк «Получено» и «Сдача» в повторе нет —
// программа их не хранит, они есть только на первом чеке. Если чек отменили или по нему
// был возврат — об этом сказано над чеком. onBack — кнопка «Назад» к списку
export function ChekOkno({ row, products, onClose, onBack }) {
  const t = useT()
  const auth = useAuth()
  const toast = useToast()
  // У строк продажи с сервера нет единицы (кг, л…) — она берётся из карточки товара
  const s = { ...row.sale, items: sEdinicami(row.sale.items, products) }
  const ticket = saleTicket(s, {
    t,
    money,
    when: fmtDateTime,
    pharmacy: auth?.pharmacy?.name,
    cashier: s.user?.name || '',
    rekvizity: getRekvizity(auth?.pharmacy?.code),
    nomer: chekNomer(s.date),
    // Повтор отменённого чека — с пометкой: продажи по нему больше нет
    pometka: row.otmena ? `${t('Чек отменён')} ${fmtDateTime(row.otmena.date)}` : '',
  })
  const print = () => pechatTicket(ticket).catch((e) => toast(t(e.message), 'err'))
  const vozvraty = (row.vozvraty || []).filter((r) => !isOtmena(r))
  return (
    <Modal title={<><span className="ic"><LuReceipt size={18} /></span>{t('Чек')} № {chekNomer(s.date)}</>} onClose={onBack || onClose}>
      {row.otmena && (
        <div className="note err" style={{ marginBottom: 12 }}>
          {t('Чек отменён')} {fmtDateTime(row.otmena.date)}{row.otmena.user?.name ? ` · ${row.otmena.user.name}` : ''} —{' '}
          {s.payment === 'debt' ? t('товар вернулся на склад, долг клиента уменьшен.') : t('товар вернулся на склад, деньги возвращены.')}
        </div>
      )}
      {vozvraty.map((r) => (
        <div className="note info" style={{ marginBottom: 12 }} key={r.id}>
          {t('Возврат по чеку')}: {fmtDateTime(r.date)} — {money(r.total)}
        </div>
      ))}
      <TicketView ticket={ticket} />
      {/* На бумагу — этот же чек, из печатного слоя */}
      <PrintDoc prio={2} kind="ticket" title={t('Чек продажи')}><TicketView ticket={ticket} /></PrintDoc>
      <div className="modal-actions">
        {onBack && (
          <button className="btn ghost" data-testid="chek-back" onClick={onBack} style={{ marginRight: 'auto' }}>
            <span className="ic"><LuArrowLeft size={16} /></span> {t('Назад')}
          </button>
        )}
        <button className="btn ghost" data-testid="chek-print" onClick={print}><span className="ic"><LuPrinter size={16} /></span> {t('Печать')}</button>
        <button className="btn" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </Modal>
  )
}

// Список чеков. sales — продажи (уже отобранные: смена, день, способ оплаты…),
// returns — возвраты магазина (по ним видно отмены и возвраты по чеку).
// top — что показать над списком (итоги, пояснение)
export function ChekiOkno({ title, sales, returns, onClose, top, empty }) {
  const t = useT()
  const products = useCollection('products')
  const [otkryt, setOtkryt] = useState(null)
  const list = useMemo(() => spisokChekov({ sales, returns }), [sales, returns])
  if (otkryt) {
    return <ChekOkno row={otkryt} products={products} onBack={() => setOtkryt(null)} onClose={onClose} />
  }
  const rows = list.rows
  return (
    <Modal wide title={<><span className="ic"><LuReceipt size={18} /></span>{title}</>} onClose={onClose}>
      {top}
      <div className="tag-cat" style={{ margin: '4px 0 8px' }}>
        {t('Чеков')}: {list.itogo.cheki} · {t('на')} {money(list.itogo.sum)}
        {list.itogo.otmeneno > 0 ? ` · ${t('Отменено чеков')}: ${list.itogo.otmeneno}` : ''}
        {rows.length > 0 ? ` · ${t('нажмите на чек, чтобы открыть его')}` : ''}
      </div>
      <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
        <table className="table-cards" data-testid="cheki-list">
          <thead>
            <tr>
              <th>{t('Чек')}</th><th>{t('Время')}</th><th>{t('Кассир')}</th><th>{t('Оплата')}</th>
              <th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="clickable"
                tabIndex={0}
                title={t('Открыть чек')}
                data-testid="cheki-row"
                onClick={() => setOtkryt(r)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOtkryt(r) } }}
              >
                <td className="cell-main">
                  <b>{chekNomer(r.date)}</b>
                  {chekMark(r, t) && <div className="tag-cat" style={{ color: r.otmena ? 'var(--danger)' : 'var(--warn)' }}>{chekMark(r, t)}</div>}
                </td>
                <td data-label={t('Время')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                <td data-label={t('Кассир')}>{r.cashier || '—'}</td>
                <td data-label={t('Оплата')}>
                  {payLabel(r.payment, t)}{r.payVia ? <span className="tag-cat"> · {r.payVia}</span> : null}
                  {r.customer ? <div className="tag-cat">{r.customer}</div> : null}
                </td>
                <td className="num" data-label={t('Позиций')}>{r.positions}</td>
                <td className="num" data-label={t('Сумма')}>
                  <b style={r.otmena ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{money(r.total)}</b>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan="6" className="empty">{empty || t('Чеков нет')}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </Modal>
  )
}

// Окно-расшифровка цифры: строки «название — сумма» и итог. Для карточек, за которыми
// не список чеков, а формула (ожидается в кассе, прибыль, долги…)
export function RasshifrovkaOkno({ title, Icon, rows, itog, note, children, onClose }) {
  const t = useT()
  return (
    <Modal title={<>{Icon && <span className="ic"><Icon size={18} /></span>}{title}</>} onClose={onClose}>
      {note && <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 0 }}>{note}</p>}
      {(rows || []).filter(Boolean).map((r, i) => (
        <div className="total-row" key={i}>
          <span>{r.k}{r.sub ? <span className="tag-cat"> · {r.sub}</span> : null}</span>
          <span style={r.color ? { color: r.color } : undefined}>{r.v}</span>
        </div>
      ))}
      {itog && <div className="total-row big"><span>{itog.k}</span><span>{itog.v}</span></div>}
      {children}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </Modal>
  )
}
