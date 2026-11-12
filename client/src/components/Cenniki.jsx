import { useEffect, useMemo, useState } from 'react'
import { LuMinus, LuPlus, LuPrinter, LuReceiptText } from 'react-icons/lu'
import { Modal, useToast } from './ui'
import PrintDoc from './PrintDoc'
import NumberInput from './NumberInput'
import { StickerPages, canvasMeasure } from './Nakleyka'
import { money } from '../db/store'
import { getUser } from '../db/auth'
import { fmtDate, serverNow } from '../lib/time'
import { pechat, pechatNakleyki } from '../lib/pechat'
import { labelConfig, labelPrinterOf } from '../lib/print'
import { pageOf, rotOf, savedRot, savedSize, sizeOf, sizeText } from '../lib/nakleyka'
import { isDesktop } from '../lib/desktop'
import { translate as tr, useT } from '../lib/i18n'

// ── Ценники как в 1С (1.7.8; вид точь-в-точь как образец 1С — 1.7.11) ──
// Ценник в толстой рамке: серая шапка с названием магазина, «Наименование:» и название
// крупно, «Ед.:» и «Код:», «Цена, сомони:» и очень крупная цена, под ценой дозировка или
// категория, внизу «Подпись ответственного лица» с чертой и дата.
//
// Куда печатать (1.7.12) — выбирают при печати:
//   • «Принтер этикеток» (по умолчанию): один ценник — одна наклейка, страница ровно размера
//     наклейки, как у наклеек со штрихкодом (размер, поворот и сдвиг — те же: в программе из
//     «Настройки → Чек и печать», на сайте — выбранные во вкладке «Наклейки»);
//   • «Лист A4» на обычный принтер: «Крупные» (95×55 мм, 10 на листе), «Мелкие» (64×55 мм,
//     15 на листе) или «Свой размер» — ширина и высота в мм; сколько встанет на лист,
//     считается само (1.7.11). Печатный слой 'labels' (лист A4, поля 8 мм — PrintDoc.jsx).
// Шрифт подстраивается под размер, и его можно сделать крупнее или мельче («Шрифт
// ценника»). Выбор помнится на этом компьютере.

// Место на листе A4 за полями 8 мм (с запасом на округление движка печати), мм
const LIST_W = 193.5
const LIST_H = 280.5
export const PRESETS = { big: { w: 95, h: 55 }, small: { w: 64, h: 55 } }
export const LIMITS = { wMin: 40, wMax: 190, hMin: 25, hMax: 135, fMin: 70, fMax: 150, fStep: 10 }
export const MAX_CENNIKOV = 500
const KEY = 'finmax_cennik_format'
const PRICE_NF = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const r3 = (v) => Math.round(v * 1000) / 1000
// Масштаб шрифта: от размера ценника (крупный 95×55 — 100 %) и от «Шрифта ценника»
const kOf = (w, h, font) => Math.round((0.4 * (w / 95) + 0.6 * (h / 55)) * (font / 100) * 100) / 100

// Чтобы всё влезло (1.7.12): шрифт крупнее «влезающего» не делается — иначе на маленькой
// наклейке длинное название в две строки выдавило бы цену. Считается по размерам (мм) того,
// что на ценнике, тем же шрифтом, что на бумаге; цена ещё и не шире ценника
const PT = 25.4 / 72
export function cennikFit({ name = '', price = '', sub = false, w, h, k }) {
  const pad = (kk) => 1.2 * Math.min(1, kk)
  const innerW = (kk) => w - 2 * pad(kk) - 1.2 - 2 * 1.8 * Math.min(1, kk)
  const need = (kk) => {
    const lines = canvasMeasure(name, 14 * kk, true) <= innerW(kk) ? 1 : 2
    const perK = (13 + 9.2 * 2 + 15.4 * lines + 10.625 + 34 + (sub ? 10.35 : 0) + 9.1) * PT + 0.8 + 1.1
    return perK * kk + 2 * pad(kk) + 1.2 + 0.5
  }
  let kk = k
  while (kk > 0.3 && need(kk) > h - 0.3) kk = Math.round((kk - 0.02) * 100) / 100
  const pw = canvasMeasure(price, 34 * kk, true)
  const room = innerW(kk) - 0.6
  const pricePt = pw > room ? Math.floor(34 * kk * (room / pw) * 10) / 10 : Math.round(34 * kk * 10) / 10
  return { k: kk, pricePt }
}

// Выбор → проверенный: куда (наклейка или A4), вид, размер (мм, целые), шрифт (%, шаг 10)
export function formatOf(sel) {
  const kuda = sel?.kuda === 'a4' ? 'a4' : 'nk'
  const vid = sel?.vid === 'small' || sel?.vid === 'custom' ? sel.vid : 'big'
  const font = clamp(Math.round((Number(sel?.font) || 100) / LIMITS.fStep) * LIMITS.fStep, LIMITS.fMin, LIMITS.fMax)
  const base = vid === 'custom' ? { w: Number(sel?.w) || 95, h: Number(sel?.h) || 55 } : PRESETS[vid]
  const w = clamp(Math.round(base.w), LIMITS.wMin, LIMITS.wMax)
  const h = clamp(Math.round(base.h), LIMITS.hMin, LIMITS.hMax)
  return { kuda, vid, w, h, font }
}

// Раскладка на листе A4 и масштаб шрифта для выбранного формата
export function cennikLayout(sel) {
  const f = formatOf(sel)
  const cols = Math.max(1, Math.floor(LIST_W / f.w))
  const rows = Math.max(1, Math.floor(LIST_H / f.h))
  return { ...f, cols, rows, perPage: cols * rows, k: kOf(f.w, f.h, f.font) }
}

// Ценник на наклейке: nk — { size, rot, dx, dy } принтера этикеток. Блок — на 0,6 мм меньше
// страницы, как у наклеек со штрихкодом (движок печати округляет размер страницы, и блок
// ровно в страницу переносился бы на вторую — пустая наклейка). Ценник внутри — размером
// наклейки «как на экране», поворот и сдвиг — как у наклеек (lib/nakleyka.js transform)
export function cennikNaNakleyke(nk, font = 100) {
  const size = sizeOf(nk?.size)
  const rot = rotOf(nk?.rot)
  const page = pageOf(size, rot)
  const boxW = r3(page.w - 0.6)
  const boxH = r3(page.h - 0.6)
  const turned = rot % 180 !== 0
  const turn =
    rot === 90 ? `translate(${boxW}mm, 0) rotate(90deg)` : rot === 180 ? `translate(${boxW}mm, ${boxH}mm) rotate(180deg)` : rot === 270 ? `translate(0, ${boxH}mm) rotate(-90deg)` : ''
  const dx = r3(Number(nk?.dx) || 0)
  const dy = r3(Number(nk?.dy) || 0)
  const transform = ((dx || dy ? `translate(${dx}mm, ${dy}mm) ` : '') + turn).trim() || 'none'
  return { size, rot, page, boxW, boxH, iw: turned ? boxH : boxW, ih: turned ? boxW : boxH, transform, k: kOf(size.w, size.h, formatOf({ font }).font) }
}

function savedSel() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && typeof v === 'object') return formatOf(v)
    // Прежняя настройка (1.7.8–1.7.10): только «крупные» или «мелкие» на листе A4
    const old = localStorage.getItem('finmax_cennik_razmer')
    return formatOf(old ? { kuda: 'a4', vid: old === 'small' ? 'small' : 'big' } : null)
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

// fit — { w, h, k }: размер ценника (мм) и масштаб шрифта
export function Cennik({ product, shop, date, fit }) {
  const t = useT()
  const sub = product.dosage || (product.category && product.category !== 'Прочее' ? product.category : '')
  const price = PRICE_NF.format(Math.round((Number(product.price) || 0) * 100) / 100)
  const F = useMemo(() => (fit ? cennikFit({ name: product.name, price, sub: !!sub, ...fit }) : null), [product.name, price, sub, fit?.w, fit?.h, fit?.k]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cn" data-testid="cennik" style={F ? { '--k': F.k } : undefined}>
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
          <div className="cn-price" style={F ? { fontSize: `${F.pricePt}pt` } : undefined}>{price}</div>
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

// Один ценник — одна наклейка (блок .nk: печатный слой ставит каждую на свою страницу)
function CennikNakleyka({ product, N, shop, date }) {
  return (
    <div className="nk cn-nk" style={{ width: `${N.boxW}mm`, height: `${N.boxH}mm` }}>
      <div className="cn-nk-in" style={{ width: `${N.iw}mm`, height: `${N.ih}mm`, transform: N.transform, '--k': N.k }}>
        <Cennik product={product} shop={shop} date={date} fit={{ w: N.iw, h: N.ih, k: N.k }} />
      </div>
    </div>
  )
}

// На бумагу: на принтер этикеток — наклейками, на обычный принтер — листами A4.
// razmer — выбор (useRazmerCennika), nk — принтер этикеток (useNakleykaCennika)
export function CennikiDoc({ rows, razmer, nk, title = '' }) {
  const f = formatOf(razmer)
  const L = useMemo(() => cennikLayout(f), [f.kuda, f.vid, f.w, f.h, f.font]) // eslint-disable-line react-hooks/exhaustive-deps
  const N = useMemo(() => cennikNaNakleyke(nk, f.font), [nk?.size?.w, nk?.size?.h, nk?.rot, nk?.dx, nk?.dy, f.font]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = cennikiRows(rows)
  const shop = getUser()?.pharmacy?.name || ''
  const date = fmtDate(serverNow())
  if (f.kuda === 'nk') {
    return (
      <StickerPages title={title}>
        {list.map((x) => <CennikNakleyka key={x.key} product={x.product} N={N} shop={shop} date={date} />)}
      </StickerPages>
    )
  }
  const pages = []
  for (let i = 0; i < list.length; i += L.perPage) pages.push(list.slice(i, i + L.perPage))
  return (
    <PrintDoc prio={2} kind="labels" title={title}>
      {pages.map((pg, i) => (
        <div key={i} className="cn-page" style={pageStyle(L)}>
          {pg.map((x) => <Cennik key={x.key} product={x.product} shop={shop} date={date} fit={L} />)}
        </div>
      ))}
    </PrintDoc>
  )
}

// Принтер этикеток этого компьютера: в программе — из «Настройки → Чек и печать»; на сайте и
// без выбранного принтера — размер и поворот, выбранные во вкладке «Наклейки»
export function useNakleykaCennika() {
  const [cfg, setCfg] = useState(isDesktop ? undefined : null)
  const [site] = useState(() => ({ size: savedSize(), rot: savedRot() }))
  useEffect(() => {
    let alive = true
    labelConfig(true).then((c) => alive && setCfg(c || null))
    return () => {
      alive = false
    }
  }, [])
  const printer = labelPrinterOf(cfg)
  if (printer) return { ready: true, cfg, printer, size: { w: cfg.w, h: cfg.h }, rot: rotOf(cfg.rot, cfg.flip), dx: cfg.dx, dy: cfg.dy }
  return { ready: cfg !== undefined, cfg, printer: '', size: site.size, rot: site.rot, dx: 0, dy: 0 }
}

// Печать: на принтер этикеток — как наклейки (в программе с выбранным принтером — сразу в
// него), на лист A4 — окно печати. 'printer' — ушло прямо на принтер этикеток
export function pechatCennikov(razmer, nk) {
  if (formatOf(razmer).kuda === 'a4') return pechat({ kind: 'labels' })
  return pechatNakleyki(sizeOf(nk?.size), { cfg: nk?.cfg, rot: rotOf(nk?.rot) })
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

// Выбор: куда печатать, размер (на листе A4) и шрифт
export function RazmerCennika({ value, onChange, nk }) {
  const t = useT()
  const f = formatOf(value)
  const L = cennikLayout(f)
  const set = (patch) => onChange(formatOf({ ...f, ...patch }))
  const page = pageOf(sizeOf(nk?.size), rotOf(nk?.rot))
  return (
    <div data-testid="cn-razmer">
      <div className="field">
        <label>{t('Куда печатать')}</label>
        <div className="chips">
          <button type="button" className={'chip' + (f.kuda === 'nk' ? ' active' : '')} data-kuda="nk" onClick={() => set({ kuda: 'nk' })}>
            {t('Принтер этикеток')}
          </button>
          <button type="button" className={'chip' + (f.kuda === 'a4' ? ' active' : '')} data-kuda="a4" onClick={() => set({ kuda: 'a4' })}>
            {t('Лист A4')}
          </button>
        </div>
      </div>
      {f.kuda === 'nk' ? (
        <div className="note info" style={{ marginBottom: 12 }} data-testid="cn-nk-info">
          {t('Один ценник — одна наклейка')} {sizeText(sizeOf(nk?.size))} · {t('поворот')} {rotOf(nk?.rot)}°
          {nk?.printer ? (
            <div className="tag-cat">
              {t('Принтер этикеток')}: <b>{nk.printer}</b>. {t('Принтер, размер и поворот наклейки меняются в «Настройки → Чек и печать».')}
            </div>
          ) : (
            <div className="tag-cat">
              {t('Размер и поворот — как у наклеек (вкладка «Наклейки» в окне этикеток).')}{' '}
              {isDesktop
                ? t('Чтобы наклейки печатались сразу, без экрана печати, выберите принтер этикеток в «Настройки → Чек и печать».')
                : `${t('В окне печати выберите принтер этикеток, бумагу')} ${sizeText(page)}, ${t('поля — «Нет», масштаб — 100 %.')}`}
            </div>
          )}
        </div>
      ) : (
        <>
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
        </>
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
      {f.kuda === 'a4' && (
        <div className="tag-cat" style={{ marginBottom: 10 }} data-testid="cn-perpage">
          {f.w}×{f.h} {t('мм')} · {t('На листе A4')}: {L.perPage} ({L.cols} × {L.rows})
        </div>
      )}
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

// Образец на экране — первый ценник (как ляжет на бумагу); большой уменьшается, чтобы влез
export function CennikPreview({ product, razmer, nk }) {
  const f = formatOf(razmer)
  const L = useMemo(() => cennikLayout(f), [f.kuda, f.vid, f.w, f.h, f.font]) // eslint-disable-line react-hooks/exhaustive-deps
  const N = useMemo(() => cennikNaNakleyke(nk, f.font), [nk?.size?.w, nk?.size?.h, nk?.rot, nk?.dx, nk?.dy, f.font]) // eslint-disable-line react-hooks/exhaustive-deps
  const shop = getUser()?.pharmacy?.name || ''
  const date = fmtDate(serverNow())
  if (f.kuda === 'nk') {
    const zoom = Math.min(2, 560 / (N.boxW * 3.78), 400 / (N.boxH * 3.78))
    return (
      <div className="cn-preview" data-testid="cn-preview">
        <div className="cn-nk-zoom" style={{ zoom }}>
          <CennikNakleyka product={product} N={N} shop={shop} date={date} />
        </div>
      </div>
    )
  }
  const zoom = Math.min(1.35, 640 / (L.w * 3.78), 420 / (L.h * 3.78))
  return (
    <div className="cn-preview" data-testid="cn-preview">
      <div className="cn-page" style={{ ...pageStyle(L), gridTemplateColumns: `${L.w}mm`, zoom }}>
        <Cennik product={product} shop={shop} date={date} fit={L} />
      </div>
    </div>
  )
}

// ── Окно «Ценники»: несколько товаров (из «Товаров» — отмеченные, из прихода — его товары) ──
export default function CennikiModal({ products, onClose, title }) {
  const t = useT()
  const toast = useToast()
  const [razmer, setRazmer] = useRazmerCennika()
  const nk = useNakleykaCennika()
  const [busy, setBusy] = useState(false)
  const list = (products || []).filter(Boolean)
  const [counts, setCounts] = useState(() => Object.fromEntries(list.map((p) => [p.id, '1'])))
  const rows = list.map((p) => ({ product: p, count: counts[p.id] }))
  const total = cennikiRows(rows).length
  const f = formatOf(razmer)
  const sheets = Math.ceil(total / cennikLayout(f).perPage)
  const name = title || t('Ценники')
  async function doPrint() {
    if (busy || total < 1) return
    setBusy(true)
    try {
      const where = await pechatCennikov(razmer, nk)
      if (where === 'printer') toast(`${t('Отправлено на принтер этикеток')}: ${total}`)
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal className="label-print" title={<><span className="ic"><LuReceiptText size={18} /></span>{name}</>} onClose={onClose} wide>
      <RazmerCennika value={razmer} onChange={setRazmer} nk={nk} />
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
        {t('Ценников')}: {total}
        {f.kuda === 'a4' ? ` · ${t('листов A4')}: ${sheets}` : ` · ${t('наклеек')}: ${total}`}
        {total >= MAX_CENNIKOV ? ` · ${t('за один раз — не больше')} ${MAX_CENNIKOV}` : ''}
      </div>
      {list[0] && <CennikPreview product={list[0]} razmer={razmer} nk={nk} />}
      <CennikiDoc rows={rows} razmer={razmer} nk={nk} title={name} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('Закрыть')}</button>
        <button className="btn" onClick={doPrint} disabled={busy || total < 1 || (f.kuda === 'nk' && !nk.ready)} data-testid="cn-print">
          <span className="ic"><LuPrinter size={16} /></span> {busy ? t('Печать…') : t('Печать')}
        </button>
      </div>
    </Modal>
  )
}
