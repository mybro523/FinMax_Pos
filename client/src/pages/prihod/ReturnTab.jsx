import { useEffect, useMemo, useRef, useState } from 'react'
import { LuUndo2, LuTrash2, LuPlus, LuCheck, LuEraser, LuScanLine, LuClock, LuCalculator, LuBanknote, LuCreditCard, LuList } from 'react-icons/lu'
import { Modal, useToast, useDialog } from '../../components/ui'
import NumberInput from '../../components/NumberInput'
import { Pagination, usePagination } from '../../components/Pagination'
import { useCashSources, sourceName } from '../../components/SupplierMoney'
import { money, stockText } from '../../db/store'
import { createSupplierReturn, deleteSupplierReturn } from '../../db/ops'
import { useCan } from '../../db/auth'
import { fmtDateTime } from '../../lib/time'
import { useT, translate as tr } from '../../lib/i18n'
import { beepOk, beepError } from '../../lib/sound'
import { stockUnits, uppOf } from '../../lib/units'
import { qtyText as unitsText } from '../../lib/otchety'
import { retLineFromProduct, retLineSum, retSummary, retProblem, toRetItem, qtyText, n2, num } from '../../lib/prihod'
import { usePrihod, setRet, setRetForm, resetRet, blankRetForm } from './store'
import ProductPick from './ProductPick'

// ── Возврат товара поставщику ──
// Товар уходит со склада (просроченное — тоже: его чаще всего и возвращают), деньги
// возвращаются одним из четырёх способов — как «Чем заплатили» в приходе, только
// наоборот: в счёт долга (долг поставщику уменьшается), в кассу (деньги ложатся в ящик
// открытой смены и видны в её отчёте), наличными мимо кассы, на карту.
//
// Возвращают конкретному поставщику — он выбирается слева. Цена строки — по которой
// этот поставщик привёз товар в последний раз, иначе закупочная; её можно поправить.
// Набранное живёт в store.js, как и новый приход.

export const REFUNDS = {
  debt: ['В счёт долга', LuClock],
  cash: ['В кассу', LuCalculator],
  own: ['Наличными', LuBanknote],
  card: ['На карту', LuCreditCard],
}
const looksLikeScan = (v) => String(v ?? '').replace(/\D/g, '').length >= 8
const inRange = (d, r) => {
  const ts = new Date(d).getTime()
  return Number.isFinite(ts) && (!r.from || ts >= r.from.getTime()) && (!r.to || ts < r.to.getTime())
}

export default function ReturnTab({ products, suppliers, sup, arrivals, returns, range, loading, periodLabel }) {
  const t = useT()
  const can = useCan()
  const [view, setView] = useState(null)
  const journal = useMemo(
    () => returns.filter((r) => inRange(r.date, range) && (!sup || r.supplierId === sup.id)).sort((a, b) => new Date(b.date) - new Date(a.date)),
    [returns, range, sup],
  )
  const pg = usePagination(journal, 10, `${sup?.id || ''}|${range.from?.getTime() || 0}`)
  const total = useMemo(() => journal.reduce((s, r) => s + num(r.total), 0), [journal])

  return (
    <div className="prh-ret">
      {can('arrivals.return') && <NewReturn products={products} suppliers={suppliers} sup={sup} arrivals={arrivals} />}

      <div className="panel" style={{ padding: 0 }} data-tour="ret.journal">
        <div className="prh-panel-head">
          <h2><span className="h2-title"><span className="ic"><LuList size={17} /></span>{t('Возвраты поставщикам')}</span></h2>
          <span className="tag-cat">{loading ? t('загружаем…') : `${periodLabel} · ${t('Найдено записей')}: ${journal.length} · ${money(total)}`}</span>
        </div>
        <div className="table-cards-wrap">
          <table className="table-cards">
            <thead>
              <tr><th>{t('Дата')}</th><th>{t('Поставщик')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th>{t('Как вернули деньги')}</th><th>{t('Принял')}</th><th></th></tr>
            </thead>
            <tbody>
              {pg.slice.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                  <td className="cell-main">
                    <b>{r.supplier}</b>
                    {r.note ? <div className="tag-cat">{r.note}</div> : null}
                  </td>
                  <td className="num" data-label={t('Позиций')}>{(r.items || []).length}</td>
                  <td className="num" data-label={t('Сумма')}><b>{money(r.total)}</b></td>
                  <td data-label={t('Как вернули деньги')}>{t(REFUNDS[r.refund]?.[0] || '—')}</td>
                  <td data-label={t('Принял')} className="tag-cat">{r.user?.name || '—'}</td>
                  <td className="num"><button type="button" className="btn ghost sm" data-tour="ret.details" onClick={() => setView(r)}>{t('Подробно')}</button></td>
                </tr>
              ))}
              {!journal.length && (
                <tr><td colSpan="7" className="empty">{loading ? t('Загружаем…') : t('За выбранный период возвратов поставщикам не было')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pg} />
      </div>

      {view && <ReturnDetails r={view} products={products} canDelete={can('arrivals.edit')} onClose={() => setView(null)} />}
    </div>
  )
}

// ── Новый возврат ──
function NewReturn({ products, suppliers, sup, arrivals }) {
  const t = useT()
  const toast = useToast()
  const st = usePrihod()
  const { lines, form, refund, note, sourceId } = st.ret
  const s = useMemo(() => retSummary(lines), [lines])
  const scanRef = useRef(null)
  const qtyRef = useRef(null)
  const [focusQty, setFocusQty] = useState(0)
  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0)
  useEffect(() => {
    if (!focusQty) return
    qtyRef.current?.focus()
    qtyRef.current?.select?.()
  }, [focusQty])

  const sources = useCashSources()
  const tills = useMemo(() => sources || [], [sources])
  useEffect(() => {
    if (tills.length && !tills.some((x) => x.shiftId === sourceId)) setRet({ sourceId: (tills.find((x) => !x.deviceId) || tills[0]).shiftId })
  }, [tills, sourceId])

  const chosen = form.productId ? products.find((p) => p.id === form.productId) || null : null
  const editing = form.editKey ? lines.find((l) => l.key === form.editKey) || null : null
  const base = editing || (chosen ? retLineFromProduct(chosen, { arrivals, supplierId: sup?.id }) : null)
  const draft = base ? { ...base, qty: form.qty, pieces: form.pieces, price: form.price } : null

  function editLine(l) {
    setRetForm({ productId: l.productId, code: l.barcode || '', q: l.name, qty: l.qty, pieces: l.pieces, price: l.price, editKey: l.key })
    setFocusQty((n) => n + 1)
  }
  function choose(p) {
    const was = lines.find((l) => l.productId === p.id)
    if (was) {
      beepError()
      toast(`«${p.name}» ${tr('уже в этом возврате — исправьте строку')}`, 'err')
      return editLine(was)
    }
    if (stockUnits(p) <= 0) {
      beepError()
      return toast(`«${p.name}»: ${tr('на складе нет — возвращать нечего')}`, 'err')
    }
    const l = retLineFromProduct(p, { arrivals, supplierId: sup?.id })
    setRetForm({ productId: p.id, code: p.barcode || '', q: p.name, qty: '1', pieces: '', price: l.price, editKey: '' })
    beepOk()
    setFocusQty((n) => n + 1)
  }
  const numField = (key) => (e) => {
    if (looksLikeScan(e.target.value)) {
      beepError()
      toast(tr('Это похоже на штрихкод — сканируйте ещё раз'), 'err')
      return focusScan()
    }
    setRetForm({ [key]: e.target.value })
  }
  function commit() {
    if (!draft) {
      toast(tr('Сначала выберите товар: отсканируйте штрихкод или найдите по названию'), 'err')
      return focusScan()
    }
    // Остаток — нынешний, а не тот, что был при добавлении строки
    const p = products.find((x) => x.id === draft.productId)
    const l = { ...draft, stock: p ? stockUnits(p) : draft.stock }
    const problem = retProblem(l)
    if (problem) return toast(`«${l.name}»: ${tr(problem)}${problem === 'на складе меньше' ? ` (${stockText(p || {})})` : ''}`, 'err')
    setRet((r) => ({
      lines: r.form.editKey ? r.lines.map((y) => (y.key === r.form.editKey ? l : y)) : [...r.lines, l],
      form: blankRetForm(),
    }))
    focusScan()
  }
  const onEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }
  const removeLine = (key) => setRet((r) => ({ lines: r.lines.filter((l) => l.key !== key), ...(r.form.editKey === key ? { form: blankRetForm() } : {}) }))

  const debt = Number(sup?.debt) || 0
  const debtAfter = Math.max(0, debt - s.total)

  function submit() {
    if (!sup) return toast(tr('Выберите поставщика слева — товар возвращают конкретному поставщику'), 'err')
    if (!lines.length) return toast(tr('Добавьте хотя бы один товар'), 'err')
    for (const l of lines) {
      const p = products.find((x) => x.id === l.productId)
      const problem = retProblem({ ...l, stock: p ? stockUnits(p) : 0 })
      if (problem) {
        toast(`«${l.name}»: ${tr(problem)}`, 'err')
        return editLine(l)
      }
    }
    if (!refund) return toast(tr('Выберите, как поставщик вернул деньги'), 'err')
    if (refund === 'debt' && s.total > debt + 0.005) return toast(`${tr('Долг поставщика меньше суммы возврата')} (${money(debt)}). ${tr('Выберите другой способ')}`, 'err')
    if (refund === 'cash' && !tills.length) return toast(tr('Нет открытой смены — положить деньги в кассу некуда.'), 'err')
    // Мгновенно, как приход: склад меняется сразу, форма очищается. Сервер отказал
    // (долг успели погасить, товара у него меньше) — откат, и набранное возвращается
    // в форму, если её ещё не начали заново
    const saved = { lines, refund, note, sourceId }
    createSupplierReturn({
      supplierId: sup.id,
      supplier: sup.name,
      refund,
      shiftId: refund === 'cash' ? sourceId || '' : '',
      note: note.trim(),
      items: lines.map(toRetItem),
    }).catch((e) => {
      toast(e.message, 'err')
      setRet((r) => (r.lines.length ? {} : { ...saved, form: blankRetForm() }))
    })
    toast(tr('Возврат оформлен, товар списан со склада'))
    resetRet()
  }

  return (
    <section className="panel prh-ret-new" data-tour="ret.new">
      <div className="prh-panel-head" style={{ padding: '0 0 12px' }}>
        <h2><span className="h2-title"><span className="ic"><LuUndo2 size={17} /></span>{t('Новый возврат поставщику')}</span></h2>
        <span className={'prh-ret-sup' + (sup ? '' : ' none')}>{sup ? sup.name : t('поставщик не выбран')}</span>
      </div>
      {!sup && <div className="note info" style={{ marginBottom: 12 }}>{t('Выберите поставщика слева — товар возвращают конкретному поставщику.')}</div>}

      <div className="prh-ret-form">
        <ProductPick
          ids={{ code: 'ret-q', name: 'ret-name' }}
          tour="ret.scan"
          codeRef={scanRef}
          products={products}
          code={form.code || ''}
          name={form.q}
          chosen={chosen}
          onCode={(v) => setRetForm({ code: v, q: '', productId: '' })}
          onName={(v) => setRetForm({ q: v, code: '', productId: '' })}
          readOnly={!!editing}
          autoFocus={false}
          onPick={choose}
          onEnterChosen={() => setFocusQty((n) => n + 1)}
          onUnknownCode={() => toast(tr('Товар с таким штрихкодом не найден'), 'err')}
          onUnknownName={() => toast(tr('Товар не найден'), 'err')}
          hint={
            <>
              <span className="ic"><LuScanLine size={15} /></span>
              {draft
                ? `${t('На складе')}: ${stockText(products.find((p) => p.id === draft.productId) || {})} · ${draft.fromArrival ? t('цена — из последнего прихода от этого поставщика') : t('цена — закупочная из карточки')}`
                : t('Отсканируйте товар, который отдаёте поставщику')}
            </>
          }
        />
        <div className="prh-f">
          <label>{t('Количество')}</label>
          <div className="prh-qty">
            <label className="prh-unit">
              <NumberInput ref={qtyRef} integer={!draft?.ves} value={form.qty} onChange={numField('qty')} onKeyDown={onEnter} disabled={!draft} aria-label={t('Количество')} />
              <span>{draft ? t(draft.unit) : t('уп')}</span>
            </label>
            {draft?.div && (
              <label className="prh-unit">
                <NumberInput integer value={form.pieces} placeholder="0" onChange={numField('pieces')} onKeyDown={onEnter} aria-label={t('Штук сверх упаковок')} />
                <span>{t('шт')}</span>
              </label>
            )}
          </div>
        </div>
        <div className="prh-f prh-f-price">
          <label>{t('Цена возврата')}</label>
          <NumberInput value={form.price} onChange={numField('price')} onKeyDown={onEnter} disabled={!draft} placeholder="0" />
        </div>
        <div className="prh-ret-actions">
          {(editing || draft) && (
            <button type="button" className="btn ghost" onClick={() => { setRetForm(blankRetForm()); focusScan() }} title={t('Очистить форму')}>
              <span className="ic"><LuEraser size={15} /></span>
            </button>
          )}
          <button type="button" className="btn green" data-tour="ret.add" onClick={commit} disabled={!draft}>
            <span className="ic">{editing ? <LuCheck size={16} /> : <LuPlus size={16} />}</span> {editing ? t('Сохранить строку') : t('Добавить')}
          </button>
        </div>
      </div>

      <div className="prh-grid-wrap prh-ret-grid">
        <table className="prh-grid">
          <thead>
            <tr>
              <th className="num">№</th>
              <th>{t('Наименование')}</th>
              <th>{t('Штрихкод')}</th>
              <th className="num">{t('На складе')}</th>
              <th className="num">{t('Кол-во')}</th>
              <th className="num">{t('Цена возврата')}</th>
              <th className="num">{t('Сумма')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, n) => (
              <tr key={l.key} className={form.editKey === l.key ? 'sel' : ''} onClick={() => editLine(l)} title={t('Открыть строку в форме')}>
                <td className="num muted">{n + 1}</td>
                <td className="prh-c-name" title={l.name}>{l.name}</td>
                <td className="muted prh-c-code">{l.barcode || '—'}</td>
                <td className="num muted">{unitsText(stockUnits(products.find((p) => p.id === l.productId) || {}), products.find((p) => p.id === l.productId) || { unitsPerPack: uppOf(l), unit: l.unit }, t)}</td>
                <td className="num"><b>{qtyText(l, t)}</b></td>
                <td className="num">{n2(num(l.price))}</td>
                <td className="num"><b>{n2(retLineSum(l))}</b></td>
                <td className="prh-c-act" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn ghost sm icon" onClick={() => removeLine(l.key)} title={t('Убрать из возврата')} aria-label={`${t('Убрать из возврата')}: ${l.name}`}>
                    <LuTrash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {!lines.length && <tr className="prh-empty"><td colSpan="8">{t('Строк пока нет — добавьте товар, который отдаёте поставщику.')}</td></tr>}
          </tbody>
          {lines.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan="4">{t('Итого')}: {s.count} {t('поз.')}</td>
                <td className="num">{n2(s.packs)}</td>
                <td></td>
                <td className="num">{n2(s.total)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="prh-ret-finish">
        <div>
          <div data-tour="ret.refund">
            <label className="prh-ret-label">{t('Как поставщик вернул деньги')}</label>
            <div className="arr-pay">
              {Object.entries(REFUNDS).map(([key, [label, Icon]]) => {
                const off = (key === 'debt' && debt <= 0) || (key === 'cash' && !tills.length)
                return (
                  <button
                    key={key}
                    type="button"
                    className={'arr-pay-btn' + (refund === key ? ' active' : '')}
                    disabled={off}
                    title={key === 'debt' && debt <= 0 ? tr('Долга перед этим поставщиком нет') : key === 'cash' && !tills.length ? tr('Нет открытой смены — положить деньги в кассу некуда.') : undefined}
                    onClick={() => setRet({ refund: key })}
                  >
                    <Icon size={16} />
                    <span>{t(label)}</span>
                  </button>
                )
              })}
            </div>
            {!refund && <div className="arr-pay-hint">{t('Выберите, как поставщик вернул деньги')}</div>}
            {refund === 'debt' && sup && (
              <div className="tag-cat" style={{ marginTop: 8 }}>
                {t('Долг поставщику')}: <b>{money(debt)}</b> → <b>{money(debtAfter)}</b>
              </div>
            )}
            {refund === 'cash' && tills.length > 1 && (
              <div className="field" style={{ maxWidth: 320, marginTop: 8, marginBottom: 0 }}>
                <label>{t('В какую кассу')}</label>
                <select value={sourceId} onChange={(e) => setRet({ sourceId: e.target.value })}>
                  {tills.map((x) => <option key={x.shiftId} value={x.shiftId}>{x.label || sourceName(x, tr)}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
            <label htmlFor="ret-note">{t('Причина (необязательно)')}</label>
            <input id="ret-note" value={note} maxLength={500} onChange={(e) => setRet({ note: e.target.value })} placeholder={t('напр. просрочка, брак, пересорт')} />
          </div>
        </div>
        <div className="prh-finish-total">
          <span>{t('К возврату')}</span>
          <b>{money(s.total)}</b>
          <small>{lines.length} {t('поз.')}{sup ? ` · ${sup.name}` : ''}</small>
          <button type="button" className="btn big" data-tour="ret.submit" disabled={!lines.length || !sup} onClick={submit}>
            <span className="ic"><LuUndo2 size={18} /></span> {t('Оформить возврат')}
          </button>
        </div>
      </div>
    </section>
  )
}

// ── Возврат · подробно ──
// Удалить может только владелец: товар вернётся на склад, долг или деньги в кассе —
// назад. Деньги, положенные в кассу уже закрытой смены, вошли в её отчёт — такой
// возврат не удаляется (то же правило, что у оплаты поставщику)
function ReturnDetails({ r, products, canDelete, onClose }) {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = useState(false)
  async function remove() {
    const ok = await dialog.confirm({
      title: t('Удалить возврат?'),
      message: `${r.supplier} · ${money(r.total)}. ${t('Товар вернётся на склад, а долг поставщику или деньги в кассе — назад.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    setBusy(true)
    try {
      await deleteSupplierReturn(r.id)
      toast(t('Возврат удалён, товар снова на складе'))
      onClose()
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Возврат поставщику · детали')} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>
        {r.supplier} · {fmtDateTime(r.date)} · {t('Как вернули деньги')}: {t(REFUNDS[r.refund]?.[0] || '—')}
        {r.user?.name ? ` · ${t('Принял')}: ${r.user.name}` : ''}
      </div>
      {r.note && <div className="note info" style={{ marginBottom: 12 }}>{t('Причина')}: {r.note}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th><th className="num">{t('Цена')}</th><th className="num">{t('Сумма')}</th></tr></thead>
          <tbody>
            {(r.items || []).map((i, n) => {
              const p = products.find((x) => x.id === i.productId) || { unitsPerPack: num(i.pieces) > 0 ? 1000 : 1, unit: num(i.pieces) > 0 ? 'кг' : 'уп' }
              const units = num(i.qty) * uppOf(p) + num(i.pieces)
              return (
                <tr key={i.id || n}>
                  <td>{i.name}</td>
                  <td className="num">{unitsText(units, p, t)}</td>
                  <td className="num">{money(i.price)}</td>
                  <td className="num">{money(num(i.price) * (units / uppOf(p)))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="total-row big"><span>{t('Итого')}</span><span>{money(r.total)}</span></div>
      {canDelete && (
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={remove} disabled={busy}>
            <span className="ic"><LuTrash2 size={16} /></span> {t('Удалить')}
          </button>
        </div>
      )}
    </Modal>
  )
}
