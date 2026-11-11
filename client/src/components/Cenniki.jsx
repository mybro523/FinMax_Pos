import { useMemo, useState } from 'react'
import { LuPrinter, LuReceiptText } from 'react-icons/lu'
import { Modal } from './ui'
import PrintDoc from './PrintDoc'
import NumberInput from './NumberInput'
import { barcodeModel, barcodeSvg, moduleFor, modulesOf } from '../lib/barcode'
import { money } from '../db/store'
import { getUser } from '../db/auth'
import { fmtDate, serverNow } from '../lib/time'
import { pechat } from '../lib/pechat'
import { useT } from '../lib/i18n'

// ── Ценники как в 1С (1.7.8) ──
// Лист A4 на обычном принтере, ценники в рамке с пунктиром для разрезания: название крупно,
// вторая строка (дозировка или категория), штрихкод с цифрами, крупная цена за единицу, внизу —
// магазин, «Подпись» и дата печати. Два размера: крупные — 2 в ряд, 10 на листе (95×55 мм),
// мелкие — 3 в ряд, 15 на листе (64×55 мм). Печатается печатным слоем 'labels' (лист A4, поля
// 8 мм — PrintDoc.jsx).

export const RAZMERY = {
  big: { cols: 2, perPage: 10, w: 95, h: 55, bc: 86, bar: 14, font: 2.8 },
  // Мелкие — 64×55 мм, 15 на листе (1.7.10: владелец дважды попросил крупнее — было 64×34, 24)
  small: { cols: 3, perPage: 15, w: 64, h: 55, bc: 57, bar: 13, font: 2.6 },
}
export const MAX_CENNIKOV = 500
const KEY = 'finmax_cennik_razmer'
const savedRazmer = () => {
  try {
    return localStorage.getItem(KEY) === 'small' ? 'small' : 'big'
  } catch {
    return 'big'
  }
}

// Штрихкод ценника — под лазерный принтер (600 точек), не шире полосы ценника
function cennikBc(code, r) {
  const model = barcodeModel(String(code || '').trim())
  const module = model ? moduleFor(modulesOf(model), r.bc, 600) : 0
  return module ? barcodeSvg(model, { module, barMm: r.bar, fontMm: r.font }) : ''
}

// Ценники подряд: строки { product, count } → по одному на каждую копию
export function cennikiRows(rows, max = MAX_CENNIKOV) {
  const out = []
  for (const r of rows || []) {
    const n = Math.max(0, Math.min(999, Math.trunc(Number(r?.count) || 0)))
    for (let k = 0; k < n && out.length < max; k++) out.push({ key: `${r.product.id}:${k}`, product: r.product })
  }
  return out
}

export function Cennik({ product, razmer = 'big', shop, date }) {
  const t = useT()
  const r = RAZMERY[razmer] || RAZMERY.big
  const bc = useMemo(() => cennikBc(product.barcode, r), [product.barcode, r])
  const sub = product.dosage || product.category || ''
  return (
    <div className="cn" data-testid="cennik">
      <div className="cn-box">
        <div className="cn-name">{product.name}</div>
        {sub ? <div className="cn-sub">{t(sub)}</div> : null}
        <div className="cn-bc" dangerouslySetInnerHTML={{ __html: bc }} />
        <div className="cn-price">
          {money(product.price)}
          <span className="cn-unit"> / {t(product.unit || 'уп')}</span>
        </div>
        <div className="cn-foot">
          <span className="cn-shop">{shop}</span>
          <span>{t('Подпись')} ________</span>
          <span>{date}</span>
        </div>
      </div>
    </div>
  )
}

// Листы A4: по perPage ценников на лист
export function CennikiDoc({ rows, razmer = 'big', title = '' }) {
  const r = RAZMERY[razmer] || RAZMERY.big
  const list = cennikiRows(rows)
  const shop = getUser()?.pharmacy?.name || ''
  const date = fmtDate(serverNow())
  const pages = []
  for (let i = 0; i < list.length; i += r.perPage) pages.push(list.slice(i, i + r.perPage))
  return (
    <PrintDoc prio={2} kind="labels" title={title}>
      {pages.map((pg, i) => (
        <div key={i} className={'cn-page ' + razmer}>
          {pg.map((x) => <Cennik key={x.key} product={x.product} razmer={razmer} shop={shop} date={date} />)}
        </div>
      ))}
    </PrintDoc>
  )
}

// Выбор размера
export function RazmerCennika({ value, onChange }) {
  const t = useT()
  return (
    <div className="field" data-testid="cn-razmer">
      <label>{t('Размер ценника')}</label>
      <div className="chips">
        <button type="button" className={'chip' + (value === 'big' ? ' active' : '')} data-razmer="big" onClick={() => onChange('big')}>
          {t('Крупные (10 на листе)')}
        </button>
        <button type="button" className={'chip' + (value === 'small' ? ' active' : '')} data-razmer="small" onClick={() => onChange('small')}>
          {t('Мелкие (15 на листе)')}
        </button>
      </div>
    </div>
  )
}

export function useRazmerCennika() {
  const [razmer, setRazmer] = useState(savedRazmer)
  const choose = (v) => {
    setRazmer(v)
    try {
      localStorage.setItem(KEY, v)
    } catch {
      /* не запомнилось */
    }
  }
  return [razmer, choose]
}

// Образец на экране — первый ценник
export function CennikPreview({ product, razmer }) {
  const shop = getUser()?.pharmacy?.name || ''
  return (
    <div className="cn-preview" data-testid="cn-preview">
      <div className={'cn-page ' + razmer} style={{ display: 'block' }}>
        <Cennik product={product} razmer={razmer} shop={shop} date={fmtDate(serverNow())} />
      </div>
    </div>
  )
}

// ── Окно «Ценники»: несколько товаров (из «Товаров» — отмеченные, из прихода — его товары) ──
export default function CennikiModal({ products, onClose, title }) {
  const t = useT()
  const [razmer, setRazmer] = useRazmerCennika()
  const list = (products || []).filter(Boolean)
  const [counts, setCounts] = useState(() => Object.fromEntries(list.map((p) => [p.id, '1'])))
  const rows = list.map((p) => ({ product: p, count: counts[p.id] }))
  const total = cennikiRows(rows).length
  const r = RAZMERY[razmer]
  const sheets = Math.ceil(total / r.perPage)
  const name = title || t('Ценники')
  return (
    <Modal className="label-print" title={<><span className="ic"><LuReceiptText size={18} /></span>{name}</>} onClose={onClose} wide>
      <RazmerCennika value={razmer} onChange={setRazmer} />
      <div className="cn-rows" data-testid="cn-rows">
        <table>
          <thead>
            <tr><th>{t('Товар')}</th><th className="num">{t('Цена')}</th><th style={{ width: 110 }}>{t('Сколько')}</th></tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="tag-cat">{p.barcode || '—'}</div></td>
                <td className="num">{money(p.price)}</td>
                <td>
                  <NumberInput integer className="disc-input" style={{ width: 80 }} value={counts[p.id] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value }))} aria-label={`${t('Сколько')}: ${p.name}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tag-cat" style={{ margin: '10px 0' }} data-testid="cn-total">
        {t('Ценников')}: {total} · {t('листов A4')}: {sheets}
        {total >= MAX_CENNIKOV ? ` · ${t('за один раз — не больше')} ${MAX_CENNIKOV}` : ''}
      </div>
      {list[0] && <CennikPreview product={list[0]} razmer={razmer} />}
      <CennikiDoc rows={rows} razmer={razmer} title={name} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('Закрыть')}</button>
        <button className="btn" onClick={() => pechat({ kind: 'labels' })} disabled={total < 1} data-testid="cn-print">
          <span className="ic"><LuPrinter size={16} /></span> {t('Печать')}
        </button>
      </div>
    </Modal>
  )
}
