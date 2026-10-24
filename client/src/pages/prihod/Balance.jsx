import { useMemo } from 'react'
import { LuPackagePlus, LuBanknote } from 'react-icons/lu'
import { money } from '../../db/store'
import { fmtDateTime } from '../../lib/time'
import { useT } from '../../lib/i18n'
import { oplataPrihoda } from '../../lib/otchety'
import { SupplierPayPanel, SupplierPaymentsTable } from '../../components/SupplierMoney'
import SupplierDebtsPanel from '../SupplierDebts'

// ── Платежи и баланс ──
// Поставщик выбран слева — его долг, оплата долга, оплаты и приходы за период.
// Не выбран — сводка «кому сколько должны»: нажали на карточку — поставщик выбрался.
//
// Считается из уже загруженных приходов и оплат (а не отдельным запросом карточки):
// так вкладка учитывает выбранный сверху период и открывается в программе для
// Windows даже без интернета. Оплату там можно записать и без связи (версия 1.4.14):
// она ляжет в базу кассы и уйдёт на сервер, когда связь появится.

const inRange = (d, r) => {
  const ts = new Date(d).getTime()
  return Number.isFinite(ts) && (!r.from || ts >= r.from.getTime()) && (!r.to || ts < r.to.getTime())
}

export function useBalance({ supplier, arrivals, payments, returns = [], range }) {
  return useMemo(() => {
    if (!supplier) return null
    const myArr = arrivals.filter((a) => a.supplierId === supplier.id && inRange(a.date, range))
    const myPay = payments.filter((p) => p.supplierId === supplier.id && inRange(p.date, range))
    // Закуплено — сумма приходов; оплачено — сразу при приходе и погашениями долга.
    // Оплата прихода из кассы уже входит в «оплачено при приходе» — второй раз не считаем
    const zakupleno = myArr.reduce((s, a) => s + (Number(a.total) || 0), 0)
    const srazu = myArr.reduce((s, a) => s + Math.max(0, (Number(a.total) || 0) - (Number(a.debt) || 0)), 0)
    const pogasheno = myPay.filter((p) => !oplataPrihoda(p)).reduce((s, p) => s + (Number(p.amount) || 0), 0)
    // Возвраты поставщику: возвращено всего; деньгами — уменьшает оплаченное
    const myRet = returns.filter((r) => r.supplierId === supplier.id && inRange(r.date, range))
    const vozvrat = myRet.reduce((s, r) => s + (Number(r.total) || 0), 0)
    const dengami = myRet.filter((r) => r.refund !== 'debt').reduce((s, r) => s + (Number(r.total) || 0), 0)
    return { arrivals: myArr, payments: myPay, returns: myRet, zakupleno, vozvrat, oplacheno: srazu + pogasheno - dengami }
  }, [supplier, arrivals, payments, returns, range])
}

export default function Balance({ supplier, bal, dolgi, periodLabel, onSelect, onOpenArrival, loading }) {
  const t = useT()

  if (!supplier) {
    return (
      <div className="prh-balance">
        <div className="note info" style={{ marginBottom: 14 }}>
          {t('Выберите поставщика слева — здесь будут его долг, оплата долга, оплаты и приходы за период. Ниже — кому сколько должен магазин.')}
        </div>
        <SupplierDebtsPanel dolgi={dolgi} onOpen={(p) => onSelect(p.id)} />
      </div>
    )
  }

  const debt = Number(supplier.debt) || 0
  return (
    <div className="prh-balance">
      <div className="mini-cards prh-bal-cards" data-tour="bal.cards">
        <div className="mini-card"><div className="m-label">{t('Долг сейчас')}</div><div className="m-value sm" style={{ color: debt > 0 ? 'var(--danger)' : undefined }}>{money(debt)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Закуплено за период')}</div><div className="m-value sm">{money(bal.zakupleno)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Возвращено за период')}</div><div className="m-value sm">{money(bal.vozvrat)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Оплачено за период')}</div><div className="m-value sm" style={{ color: bal.oplacheno > 0 ? 'var(--green)' : undefined }}>{money(bal.oplacheno)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Начальный долг')}</div><div className="m-value sm">{money(supplier.openingDebt || 0)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Телефон')}</div><div className="m-value sm">{supplier.phone || '—'}</div></div>
      </div>

      <div className="prh-bal-cols">
        <SupplierPayPanel supplierId={supplier.id} debt={debt} tour="bal.pay" />

        <div className="panel" style={{ padding: 0 }}>
          <div className="prh-panel-head">
            <h2><span className="h2-title"><span className="ic"><LuBanknote size={17} /></span>{t('Оплаты')}</span></h2>
            <span className="tag-cat">{periodLabel}</span>
          </div>
          <div className="prh-scroll">
            <SupplierPaymentsTable payments={bal.payments} empty={loading ? t('Загружаем…') : t('За этот период оплат не было')} />
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 0, marginTop: 16 }}>
        <div className="prh-panel-head">
          <h2><span className="h2-title"><span className="ic"><LuPackagePlus size={17} /></span>{t('Приходы от поставщика')}</span></h2>
          <span className="tag-cat">{periodLabel}</span>
        </div>
        <div className="prh-scroll">
          <table>
            <thead><tr><th>{t('Дата')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('В долг')}</th><th>{t('Принял')}</th><th></th></tr></thead>
            <tbody>
              {bal.arrivals.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.date)}</td>
                  <td className="num">{(a.items || []).length}</td>
                  <td className="num"><b>{money(a.total)}</b></td>
                  <td className="num" style={{ color: Number(a.debt) > 0 ? 'var(--danger)' : undefined }}>{money(a.debt)}</td>
                  <td className="tag-cat">{a.user?.name || '—'}</td>
                  <td className="num"><button type="button" className="btn ghost sm" onClick={() => onOpenArrival(a)}>{t('Подробно')}</button></td>
                </tr>
              ))}
              {!bal.arrivals.length && <tr><td colSpan="6" className="empty">{loading ? t('Загружаем…') : t('За этот период приходов от поставщика не было')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

