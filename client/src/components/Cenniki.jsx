import { useEffect, useMemo, useState } from 'react'
import { LuMinus, LuPlus, LuPrinter, LuReceiptText } from 'react-icons/lu'
import { Modal } from './ui'
import PrintDoc from './PrintDoc'
import NumberInput from './NumberInput'
import { money } from '../db/store'
import { getUser } from '../db/auth'
import { fmtDate, serverNow } from '../lib/time'
import { pechat } from '../lib/pechat'
import { useT } from '../lib/i18n'

// ── Ценники как в 1С (1.7.8; вид точь-в-точь как образец 1С — 1.7.11) ──
// Лист A4 на обычном принтере. Ценник в толстой рамке: серая шапка с названием магазина,
// «Наименование:» и название крупно, «Ед.:» и «Код:», «Цена, сомони:» и очень крупная цена,
// под ценой дозировка или категория, внизу «Подпись ответственного лица» с чертой и дата.
// Печатается печатным слоем 'labels' (лист A4, поля 8 мм — PrintDoc.jsx).
//
// Размер выбирают при печати: «Крупные» (95×55 мм, 10 на листе), «Мелкие» (64×55 мм, 15 на
// листе) или «Свой размер» — ширина и высота в мм; сколько встанет на лист, считается само.
// Шрифт подстраивается под размер, и его можно сделать крупнее или мельче («Шрифт ценника»).
// Выбор помнится на этом компьютере.

// Место на листе A4 за полями 8 мм (с запасом на округление движка печати), мм
const LIST_W = 193.5
const LIST_H = 280.5
export const PRESETS = { big: { w: 95, h: 55 }, small: { w: 64, h: 55 } }
export const LIMITS = { wMin: 40, wMax: 190, hMin: 25, hMax: 135, fMin: 70, fMax: 150, fStep: 10 }
export const MAX_CENNIKOV = 500
const KEY = 'finmax_cennik_format'
const PRICE_NF = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// Выбор → проверенный: вид, размер (мм, целые), шрифт (%, шаг 10)
export function formatOf(sel) {
  const vid = sel?.vid === 'small' || sel?.vid === 'custom' ? sel.vid : 'big'
  const font = clamp(Math.round((Number(sel?.font) || 100) / LIMITS.fStep) * LIMITS.fStep, LIMITS.fMin, LIMITS.fMax)
  const base = vid === 'custom' ? { w: Number(sel?.w) || 95, h: Number(sel?.h) || 55 } : PRESETS[vid]
  const w = clamp(Math.round(base.w), LIMITS.wMin, LIMITS.wMax)
  const h = clamp(Math.round(base.h), LIMITS.hMin, LIMITS.hMax)
  return { vid, w, h, font }
}

// Раскладка на листе и масштаб шрифта для выбранного формата
export function cennikLayout(sel) {
  const f = formatOf(sel)
  const cols = Math.max(1, Math.floor(LIST_W / f.w))
  const rows = Math.max(1, Math.floor(LIST_H / f.h))
  // Шрифт — от размера ценника (крупный 95×55 — 100 %) и от «Шрифта ценника»
  const k = Math.round((0.4 * (f.w / 95) + 0.6 * (f.h / 55)) * (f.font / 100) * 100) / 100
  return { ...f, cols, rows, perPage: cols * rows, k }
}

function savedSel() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && typeof v === 'object') return formatOf(v)
    // Прежняя настройка (1.7.8–1.7.10): только «крупные» или «мелкие»
    return formatOf({ vid: localStorage.getItem('finmax_cennik_razmer') === 'small' ? 'small' : 'big' })
  } catch {
    return formatOf(null)
  }
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

// Сетка листа и масштаб шрифта — стилями страницы ценников
const pageStyle = (L) => ({ gridTemplateColumns: `repeat(${L.cols}, ${L.w}mm)`, gridAutoRows: `${L.h}mm`, '--k': L.k })

export function Cennik({ product, shop, date }) {
  const t = useT()
  const sub = product.dosage || (product.category && product.category !== 'Прочее' ? product.category : '')
  return (
    <div className="cn" data-testid="cennik">
      <div className="cn-box">
        <div className="cn-head">{shop}</div>
        <div className="cn-body">
          <div className="cn-lbl">{t('Наименование')}:</div>
          <div className="cn-name"><span>{product.name}</span></div>
          <div className="cn-row">
            <span>{t('Ед.')}: <b>{t(product.unit || 'уп')}</b></span>
            <span>{t('Код')}: <b className="cn-code">{product.barcode || '—'}</b></span>
          </div>
          <div className="cn-lbl">{t('Цена, сомони')}:</div>
          <div className="cn-price">{PRICE_NF.format(Math.round((Number(product.price) || 0) * 100) / 100)}</div>
          {sub ? <div className="cn-sub">{t(sub)}</div> : null}
          <div className="cn-foot">
            <span className="cn-sign">{t('Подпись ответственного лица')}:<span className="cn-line" /></span>
            <span>{date}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// Листы A4: по perPage ценников на лист. razmer — выбор размера (useRazmerCennika)
export function CennikiDoc({ rows, razmer, title = '' }) {
  const L = useMemo(() => cennikLayout(razmer), [razmer])
  const list = cennikiRows(rows)
  const shop = getUser()?.pharmacy?.name || ''
  const date = fmtDate(serverNow())
  const pages = []
  for (let i = 0; i < list.length; i += L.perPage) pages.push(list.slice(i, i + L.perPage))
  return (
    <PrintDoc prio={2} kind="labels" title={title}>
      {pages.map((pg, i) => (
        <div key={i} className="cn-page" style={pageStyle(L)}>
          {pg.map((x) => <Cennik key={x.key} product={x.product} shop={shop} date={date} />)}
        </div>
      ))}
    </PrintDoc>
  )
}

// Поле размера: число набирается свободно, в выбор уходит, когда оно в пределах; ушли из
// поля — в поле то, что действует
function PoleMm({ label, value, lo, hi, onChange, testid }) {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => setTxt(String(value)), [value])
  return (
    <div className="field" style={{ maxWidth: 170 }}>
      <label>{label} ({lo}–{hi})</label>
      <NumberInput
        integer
        value={txt}
        onChange={(e) => {
          setTxt(e.target.value)
          const n = Number(e.target.value)
          if (n >= lo && n <= hi) onChange(n)
        }}
        onBlur={() => setTxt(String(value))}
        data-testid={testid}
      />
    </div>
  )
}

// Выбор размера и шрифта
export function RazmerCennika({ value, onChange }) {
  const t = useT()
  const f = formatOf(value)
  const L = cennikLayout(f)
  const set = (patch) => onChange(formatOf({ ...f, ...patch }))
  return (
    <div data-testid="cn-razmer">
      <div className="field">
        <label>{t('Размер ценника')}</label>
        <div className="chips">
          <button type="button" className={'chip' + (f.vid === 'big' ? ' active' : '')} data-razmer="big" onClick={() => set({ vid: 'big' })}>
            {t('Крупные')} 95×55
          </button>
          <button type="button" className={'chip' + (f.vid === 'small' ? ' active' : '')} data-razmer="small" onClick={() => set({ vid: 'small' })}>
            {t('Мелкие')} 64×55
          </button>
          <button type="button" className={'chip' + (f.vid === 'custom' ? ' active' : '')} data-razmer="custom" onClick={() => set({ vid: 'custom', w: f.w, h: f.h })}>
            {t('Свой размер')}
          </button>
        </div>
      </div>
      {f.vid === 'custom' && (
        <div className="row" style={{ maxWidth: 420 }}>
          <PoleMm label={t('Ширина, мм')} value={f.w} lo={LIMITS.wMin} hi={LIMITS.wMax} onChange={(w) => set({ w })} testid="cn-w" />
          <PoleMm label={t('Высота, мм')} value={f.h} lo={LIMITS.hMin} hi={LIMITS.hMax} onChange={(h) => set({ h })} testid="cn-h" />
        </div>
      )}
      <div className="field">
        <label>{t('Шрифт ценника')}</label>
        <div className="nk-step">
          <button type="button" className="btn ghost sm icon" onClick={() => set({ font: f.font - LIMITS.fStep })} disabled={f.font <= LIMITS.fMin} aria-label={t('Меньше')} title={t('Меньше')} data-testid="cn-font-less">
            <LuMinus size={15} />
          </button>
          <span className="nk-step-val" data-testid="cn-font">{f.font} %</span>
          <button type="button" className="btn ghost sm icon" onClick={() => set({ font: f.font + LIMITS.fStep })} disabled={f.font >= LIMITS.fMax} aria-label={t('Больше')} title={t('Больше')} data-testid="cn-font-more">
            <LuPlus size={15} />
          </button>
        </div>
      </div>
      <div className="tag-cat" style={{ marginBottom: 10 }} data-testid="cn-perpage">
        {f.w}×{f.h} {t('мм')} · {t('На листе A4')}: {L.perPage} ({L.cols} × {L.rows})
      </div>
    </div>
  )
}

export function useRazmerCennika() {
  const [sel, setSel] = useState(savedSel)
  const choose = (v) => {
    const f = formatOf(v)
    setSel(f)
    try {
      localStorage.setItem(KEY, JSON.stringify(f))
    } catch {
      /* не запомнилось */
    }
  }
  return [sel, choose]
}

// Образец на экране — первый ценник; большой ценник уменьшается, чтобы влез в окно
export function CennikPreview({ product, razmer }) {
  const L = useMemo(() => cennikLayout(razmer), [razmer])
  const shop = getUser()?.pharmacy?.name || ''
  const zoom = Math.min(1.35, 640 / (L.w * 3.78), 420 / (L.h * 3.78))
  return (
    <div className="cn-preview" data-testid="cn-preview">
      <div className="cn-page" style={{ ...pageStyle(L), gridTemplateColumns: `${L.w}mm`, zoom }}>
        <Cennik product={product} shop={shop} date={fmtDate(serverNow())} />
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
  const sheets = Math.ceil(total / cennikLayout(razmer).perPage)
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
