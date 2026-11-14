import { useMemo, useState } from 'react'
import { LuPackagePlus, LuBanknote } from 'react-icons/lu'
import { money } from '../../db/store'
import { fmtDateTime } from '../../lib/time'
import { useT } from '../../lib/i18n'
import { oplataPrihoda } from '../../lib/otchety'
import { SupplierPayPanel, SupplierPaymentsTable } from '../../components/SupplierMoney'
import SupplierDebtsPanel from '../SupplierDebts'
import { Modal, useToast } from '../../components/ui'
import { REFUNDS } from './ReturnTab'

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
      <BalanceCards supplier={supplier} bal={bal} debt={debt} periodLabel={periodLabel} onOpenArrival={onOpenArrival} />

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


// ── Карточки баланса — кликабельные ──
// «Долг сейчас» — приходы периода, по которым остался долг; «Закуплено» — приходы;
// «Возвращено» — возвраты поставщику; «Оплачено» — оплаты; «Начальный долг» — откуда
// он; «Телефон» — копируется. Всё — из уже посчитанного баланса за выбранный период
function BalanceCards({ supplier, bal, debt, periodLabel, onOpenArrival }) {
  const t = useT()
  const toast = useToast()
  const [okno, setOkno] = useState('')
  function open(key) {
    if (key !== 'phone') return setOkno(key)
    if (!supplier.phone) return toast(t('Телефон поставщика не записан'), 'err')
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(supplier.phone))
      .then(() => toast(t('Телефон скопирован')), () => toast(supplier.phone))
  }
  const card = (key, label, value, style) => (
    <div
      className="mini-card clickable"
      role="button"
      tabIndex={0}
      data-testid={'bal-card-' + key}
      onClick={() => open(key)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(key) } }}
    >
      <div className="m-label">{label}</div><div className="m-value sm" style={style}>{value}</div>
    </div>
  )
  const close = () => setOkno('')
  const arrivalsTable = (list, empty) => (
    <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
      <table>
        <thead><tr><th>{t('Дата')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('В долг')}</th><th></th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className="clickable" onClick={() => { close(); onOpenArrival(a) }}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.date)}</td>
              <td className="num">{(a.items || []).length}</td>
              <td className="num"><b>{money(a.total)}</b></td>
              <td className="num" style={{ color: Number(a.debt) > 0 ? 'var(--danger)' : undefined }}>{money(a.debt)}</td>
              <td className="num"><span className="btn ghost sm">{t('Подробно')}</span></td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan="5" className="empty">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  )
  const title = (x) => `${supplier.name} · ${x}`
  const closeBtn = <div className="modal-actions"><button className="btn" onClick={close}>{t('Закрыть')}</button></div>
  return (
    <>
      <div className="mini-cards prh-bal-cards" data-tour="bal.cards">
        {card('debt', t('Долг сейчас'), money(debt), { color: debt > 0 ? 'var(--danger)' : undefined })}
        {card('zakup', t('Закуплено за период'), money(bal.zakupleno))}
        {card('vozvrat', t('Возвращено за период'), money(bal.vozvrat))}
        {card('oplata', t('Оплачено за период'), money(bal.oplacheno), { color: bal.oplacheno > 0 ? 'var(--green)' : undefined })}
        {card('nachalo', t('Начальный долг'), money(supplier.openingDebt || 0))}
        {card('phone', t('Телефон'), supplier.phone || '—')}
      </div>
      {okno === 'debt' && (
        <Modal wide title={title(t('Долг сейчас'))} onClose={close}>
          <div className="tag-cat" style={{ marginBottom: 8 }}>
            {t('Долг сейчас')}: <b>{money(debt)}</b> · {t('Приходы в долг за период')} ({periodLabel})
          </div>
          {arrivalsTable(bal.arrivals.filter((a) => Number(a.debt) > 0), t('За этот период приходов в долг не было'))}
          {closeBtn}
        </Modal>
      )}
      {okno === 'zakup' && (
        <Modal wide title={title(t('Закуплено за период'))} onClose={close}>
          <div className="tag-cat" style={{ marginBottom: 8 }}>{periodLabel} · {t('Приходов')}: {bal.arrivals.length} · {money(bal.zakupleno)}</div>
          {arrivalsTable(bal.arrivals, t('За этот период приходов от поставщика не было'))}
          {closeBtn}
        </Modal>
      )}
      {okno === 'vozvrat' && (
        <Modal wide title={title(t('Возвращено за период'))} onClose={close}>
          <div className="tag-cat" style={{ marginBottom: 8 }}>{periodLabel} · {money(bal.vozvrat)}</div>
          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('Дата')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th>{t('Как вернули деньги')}</th></tr></thead>
              <tbody>
                {(bal.returns || []).map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                    <td className="num">{(r.items || []).length}</td>
                    <td className="num"><b>{money(r.total)}</b></td>
                    <td>{t(REFUNDS[r.refund]?.[0] || '—')}</td>
                  </tr>
                ))}
                {!(bal.returns || []).length && <tr><td colSpan="4" className="empty">{t('За этот период возвратов не было')}</td></tr>}
              </tbody>
            </table>
          </div>
          {closeBtn}
        </Modal>
      )}
      {okno === 'oplata' && (
        <Modal wide title={title(t('Оплачено за период'))} onClose={close}>
          <div className="tag-cat" style={{ marginBottom: 8 }}>{periodLabel} · {money(bal.oplacheno)}</div>
          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            <SupplierPaymentsTable payments={bal.payments} empty={t('За этот период оплат не было')} />
          </div>
          {closeBtn}
        </Modal>
      )}
      {okno === 'nachalo' && (
        <Modal title={title(t('Начальный долг'))} onClose={close}>
          <div className="total-row big"><span>{t('Начальный долг')}</span><span>{money(supplier.openingDebt || 0)}</span></div>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {t('Сколько магазин был должен поставщику до начала работы в программе. Вписывается в карточке поставщика.')}
          </p>
          {closeBtn}
        </Modal>
      )}
    </>
  )
}
