import { useMemo, useState } from 'react'
import { LuArrowRightLeft, LuSearch, LuStore } from 'react-icons/lu'
import NumberInput from './NumberInput'
import { useToast } from './ui'
import { money, stockText } from '../db/store'
import { skladToShop } from '../db/ops'
import { useT } from '../lib/i18n'
import { poiskZapros, tovarPodhodit } from '../lib/poisk'
import { uppOf, isVesovoy, opensPack, packLabel, pieceLabel, unitsText, gramsOfKg, KG } from '../lib/units'
import { fmtDate } from '../lib/time'

// ── Количество «уп + шт» для склада ──
// Как в остальных формах: целые упаковки и штуки (у весового — килограммы) отдельно.
// Весовой без мешка — одно поле в килограммах, товар без вскрытия — одни упаковки
export function qtyParts(p) {
  const ves = isVesovoy(p)
  return { packs: ves ? opensPack(p) : true, pieces: ves || opensPack(p) }
}
export function unitsFrom(p, packs, pieces) {
  const pp = qtyParts(p)
  const up = pp.packs ? Math.max(0, Math.trunc(Number(String(packs ?? '').replace(',', '.')) || 0)) * uppOf(p) : 0
  const sh = pp.pieces ? (isVesovoy(p) ? gramsOfKg(pieces) : Math.max(0, Math.trunc(Number(pieces) || 0))) : 0
  return up + sh
}
// Штуки → поля формы (для «Поправить остаток»: в полях сразу нынешний остаток)
export function partsFrom(p, units) {
  const pp = qtyParts(p)
  const u = Math.max(0, Math.trunc(Number(units) || 0))
  if (!pp.packs) return { packs: '', pieces: String(u / KG).replace('.', ',') }
  const upp = uppOf(p)
  const packs = Math.floor(u / upp)
  const rest = u - packs * upp
  if (!pp.pieces) return { packs: String(packs), pieces: '' }
  return { packs: String(packs), pieces: rest ? (isVesovoy(p) ? String(rest / KG).replace('.', ',') : String(rest)) : '' }
}

export function QtyFields({ p, packs, pieces, onChange, testid }) {
  const t = useT()
  const pp = qtyParts(p)
  return (
    <span className="sklad-qty" data-testid={testid}>
      {pp.packs && (
        <label>
          <NumberInput integer value={packs} placeholder="0" onChange={(e) => onChange({ packs: e.target.value, pieces })} aria-label={t(packLabel(p))} />
          <span>{t(packLabel(p))}</span>
        </label>
      )}
      {pp.pieces && (
        <label>
          <NumberInput integer={!isVesovoy(p)} value={pieces} placeholder="0" onChange={(e) => onChange({ packs, pieces: e.target.value })} aria-label={t(pieceLabel(p))} />
          <span>{t(pieceLabel(p))}</span>
        </label>
      )}
    </span>
  )
}

// ── Перенос со склада в магазин ──
// Список товаров склада, у каждого — сколько перенести (не больше, чем лежит на складе).
// «Перенести в магазин» — один документ на все заполненные строки: сервер снимает
// товар со склада (сначала ближайший срок) и кладёт в магазин партиями с теми же
// ценой и сроком. Денег и долгов перенос не создаёт.
// rows — строки склада (lib/sklad.js: skladPoTovaram); onDone — после переноса
export function PerenosForm({ rows, onDone, onCancel, compact = false }) {
  const t = useT()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [vvod, setVvod] = useState({}) // productId → { packs, pieces }
  const [busy, setBusy] = useState(false)
  const z = useMemo(() => poiskZapros(q), [q])
  const list = useMemo(() => rows.filter((r) => tovarPodhodit(z, `${r.product.name} ${r.product.dosage || ''}`, r.product.barcode)), [rows, z])

  const chosen = rows
    .map((r) => ({ r, units: unitsFrom(r.product, vvod[r.productId]?.packs, vvod[r.productId]?.pieces) }))
    .filter((x) => x.units > 0)
  const lishnee = chosen.filter((x) => x.units > x.r.units)
  const sum = chosen.reduce((s, x) => s + (x.r.units ? (x.r.cost * Math.min(x.units, x.r.units)) / x.r.units : 0), 0)

  async function go() {
    if (!chosen.length) return toast(t('Впишите, сколько перенести'), 'err')
    if (lishnee.length) return toast(`${t('На складе меньше')}: ${lishnee[0].r.product.name} (${t('есть')} ${unitsText(lishnee[0].r.units, lishnee[0].r.product, t)})`, 'err')
    setBusy(true)
    try {
      await skladToShop(chosen.map((x) => ({ productId: x.r.productId, units: x.units })))
      toast(`${t('Перенесено в магазин')}: ${chosen.length} ${t('поз.')}`)
      setVvod({})
      onDone?.()
    } catch (e) {
      toast(t(e?.message || 'Не получилось. Повторите.'), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sklad-perenos" data-testid="sklad-perenos">
      <label className="prh-sheet-search" style={{ marginBottom: 10 }}>
        <LuSearch size={15} aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Название или штрихкод…')} aria-label={t('Поиск товара на складе')} data-testid="perenos-q" />
      </label>
      <div style={{ maxHeight: compact ? '46vh' : '60vh', overflow: 'auto' }}>
        <table className="table-cards">
          <thead>
            <tr><th>{t('Товар')}</th><th className="num">{t('На складе')}</th><th className="num">{t('В магазине')}</th><th>{t('Перенести')}</th></tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const v = vvod[r.productId] || { packs: '', pieces: '' }
              const units = unitsFrom(r.product, v.packs, v.pieces)
              return (
                <tr key={r.productId} data-testid="perenos-row">
                  <td className="cell-main">
                    <b>{r.product.name}</b>{r.product.dosage ? <span className="tag-cat"> · {r.product.dosage}</span> : null}
                    <div className="tag-cat">{r.product.barcode}{r.expiry ? ` · ${t('срок')} ${fmtDate(r.expiry)}` : ''}</div>
                  </td>
                  <td className="num" data-label={t('На складе')}><b>{unitsText(r.units, r.product, t)}</b></td>
                  <td className="num" data-label={t('В магазине')}>{stockText(r.product)}</td>
                  <td data-label={t('Перенести')}>
                    <QtyFields p={r.product} packs={v.packs} pieces={v.pieces} testid="perenos-qty" onChange={(x) => setVvod({ ...vvod, [r.productId]: x })} />
                    {units > r.units && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('больше, чем на складе')}</div>}
                  </td>
                </tr>
              )
            })}
            {!list.length && <tr><td colSpan="4" className="empty">{rows.length ? t('Ничего не найдено') : t('На складе пока пусто')}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="modal-actions" style={{ alignItems: 'center' }}>
        <span className="tag-cat" style={{ marginRight: 'auto' }}>
          {chosen.length ? `${t('Выбрано')}: ${chosen.length} ${t('поз.')} · ${t('по закупке')} ${money(sum)}` : t('Впишите количество у нужных товаров')}
        </span>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>{t('Отмена')}</button>}
        <button type="button" className="btn green" data-testid="perenos-go" disabled={busy || !chosen.length} onClick={go}>
          <span className="ic">{compact ? <LuArrowRightLeft size={16} /> : <LuStore size={16} />}</span> {busy ? t('Переносим…') : t('Перенести в магазин')}
        </button>
      </div>
    </div>
  )
}
