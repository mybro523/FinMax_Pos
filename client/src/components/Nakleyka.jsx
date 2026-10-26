import { memo, useEffect, useMemo, useRef, useState } from 'react'
import PrintDoc from './PrintDoc'
import NumberInput from './NumberInput'
import { barcodeInner } from '../lib/barcode'
import { MM_PER_PT, NAKLEYKA_SIZES, SIZE_LIMITS, nakleykaName, nakleykaPlan, sizeId, sizeOf, sizeText } from '../lib/nakleyka'
import { money } from '../db/store'
import { isDesktop } from '../lib/desktop'
import { useT } from '../lib/i18n'

// ── Наклейка со штрихкодом: на экране и на бумаге ──
// Раскладку (кегли, высоту полосок, ширину модуля) считает lib/nakleyka.js; здесь она
// превращается в наклейку ровно своего размера в миллиметрах. На бумагу каждая наклейка
// идёт отдельной страницей того же размера (NakleykiDoc) — принтер этикеток кладёт
// страницу на наклейку. Наклейка всегда чёрно-белая: так печатает термопринтер.

// Ширина текста — по-настоящему, тем же шрифтом, что на наклейке
let ctx = null
const widths = new Map()
export function canvasMeasure(text, pt, bold = true) {
  const key = (bold ? 'b' : 'n') + text
  let em = widths.get(key)
  if (em === undefined) {
    try {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d')
      ctx.font = `${bold ? 700 : 400} 100px Arial, Helvetica, sans-serif`
      em = ctx.measureText(text).width / 100
    } catch {
      em = String(text).length * (bold ? 0.6 : 0.55)
    }
    if (widths.size > 4000) widths.clear()
    widths.set(key, em)
  }
  return em * pt * MM_PER_PT
}

// Вся наклейка — один рисунок SVG во весь блок наклейки, от его левого верхнего угла:
// название, штрихкод, плашка цены и рамка пробной наклейки. Так она одинакова на экране, на
// сайте и в обоих движках программы:
//   • браузер подгоняет картинки к целым точкам экрана (0,26 мм) — маленькая картинка с
//     кодом съехала бы с точек принтера и чуть растянулась бы. Рисунок же стоит в углу блока
//     (0, 0) и размером в целое число точек экрана — подгонять нечего, а всё внутри задано
//     в мм от края наклейки;
//   • сдвиг и поворот — внутри рисунка: он сам обрезает всё, что за его краем. Сдвинутое
//     стилями содержимое вылезало бы за страницу, и движок печати (особенно старый, Windows
//     7 и 8) добавлял бы пустую наклейку или ужимал бы страницу — полоски сошли бы с точек;
//   • строки названия переносит раскладка (lib/nakleyka.js) — как померила, так и печатает.
const PX_PER_MM = 96 / 25.4
const r3 = (v) => Math.round(v * 1000) / 1000
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Положение строки по высоте: базовая линия Arial — 0,905 кегля от верха, строка — с запасом
const baseline = (top, em, lineH) => top + em * ((lineH - 1.117) / 2 + 0.905)

function stickerSvg(plan, { frame = false }) {
  const pxW = Math.round(plan.vbW * PX_PER_MM)
  const pxH = Math.round(plan.vbH * PX_PER_MM)
  const { sx, sy } = plan
  // Сначала поворот вокруг середины наклейки, потом сдвиг — как их задала раскладка
  const move = [sx || sy ? `translate(${r3(sx)} ${r3(sy)})` : '', plan.flip ? `rotate(180 ${r3(plan.cx)} ${r3(plan.cy)})` : ''].filter(Boolean).join(' ')
  const xc = r3(plan.xc)
  let body = ''
  // Рамка пробной наклейки — в 1,4 мм от краёв плюс сдвиг: её не срезает ни при каком
  // сдвиге, а по ширине белых полей вокруг видно, ровно ли легла наклейка
  if (frame) {
    const fx = 1.4 + Math.abs(sx)
    const fy = 1.4 + Math.abs(sy)
    body += `<rect class="nk-t-frame" x="${r3(fx)}" y="${r3(fy)}" width="${r3(plan.w - 2 * fx)}" height="${r3(plan.h - 2 * fy)}" rx="1" fill="none" stroke="#000" stroke-width="0.3"/>`
  }
  const nm = plan.name
  if (nm.rows.length) {
    const em = nm.pt * MM_PER_PT
    const rows = nm.rows.map((row, i) => `<text class="nk-t-name" x="${xc}" y="${r3(baseline(nm.top + i * em * 1.12, em, 1.12))}">${xml(row)}</text>`)
    // На пробной наклейке рамка может пройти по буквам — белая обводка прерывает её вокруг текста
    const halo = frame ? ' stroke="#fff" stroke-width="0.6" stroke-linejoin="round" paint-order="stroke"' : ''
    body += `<g font-size="${r3(em)}" fill="#000"${halo}>${rows.join('')}</g>`
  }
  const bc = plan.barcode
  const b = barcodeInner(bc.model, bc)
  if (b) {
    // Под кодом — белое поле во всю его ширину: рамка пробной наклейки не заходит на белые
    // поля кода, где сканер ищет его край
    const under = frame ? `<rect x="0" y="0" width="${r3(b.w)}" height="${r3(b.h)}" fill="#fff"/>` : ''
    body += `<g transform="translate(${r3(bc.left)} ${r3(bc.top)})" shape-rendering="crispEdges">${under}${b.inner}</g>`
  }
  const pr = plan.price
  if (pr.text) {
    const em = pr.pt * MM_PER_PT
    body +=
      `<rect class="nk-t-plate" x="${r3(plan.xc - pr.plateW / 2)}" y="${r3(pr.top)}" width="${r3(pr.plateW)}" height="${r3(pr.height)}" rx="1" fill="#000"/>` +
      `<text class="nk-t-price" x="${xc}" y="${r3(baseline(pr.top + 0.4, em, 1.2))}" font-size="${r3(em)}" fill="#fff">${xml(pr.text)}</text>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}px" height="${pxH}px" viewBox="0 0 ${r3(plan.vbW)} ${r3(plan.vbH)}" preserveAspectRatio="none">` +
    `<g${move ? ` transform="${move}"` : ''} font-family="Arial, Helvetica, sans-serif" font-weight="700" text-anchor="middle">${body}</g></svg>`
  )
}

// Всё для наклейки: строки и раскладка. shift — { dx, dy, flip } из настройки принтера
// этикеток: раскладка оставляет место с той стороны, куда сдвиг уводит содержимое
export function stickerFrom({ name = '', price = '', code = '' }, size, dpi = 203, shift = {}) {
  const plan = nakleykaPlan(size, { name, price, code, dpi, measure: canvasMeasure, dx: shift.dx, dy: shift.dy, flip: shift.flip })
  return { name, price, code: String(code ?? '').trim(), plan }
}

// Наклейка товара: название с дозировкой, штрихкод и цена. Цена 0 — не печатается
export function stickerOf(product, size, dpi = 203, shift = {}) {
  const price = Number(product?.price) > 0 ? money(product.price) : ''
  return stickerFrom({ name: nakleykaName(product), price, code: product?.barcode }, size, dpi, shift)
}

// Одна наклейка: блок неподвижен и ничего за свои края не выпускает, в нём — рисунок.
// frame — рамка (пробная наклейка)
export const Nakleyka = memo(function Nakleyka({ data, frame = false }) {
  const { plan } = data
  const svg = useMemo(() => (plan.problem ? '' : stickerSvg(plan, { frame })), [plan, frame])
  return <div className="nk" style={{ width: `${r3(plan.boxW)}mm`, height: `${r3(plan.boxH)}mm` }} dangerouslySetInnerHTML={{ __html: svg }} />
})

// Наклейка на экране — крупнее, с краем наклейки
export function NakleykaPreview({ data, frame, zoom = 1.6 }) {
  return (
    <div className="nk-preview" data-testid="nk-preview">
      <div className="nk-zoom" style={{ zoom }}>
        <Nakleyka data={data} frame={frame} />
      </div>
    </div>
  )
}

// Наклейки на бумагу: каждая — своя страница ровно размера наклейки, без полей.
// items — [{ key, data }].
// Размер страницы в программе задаёт задание на принтер (точно, в микронах): размер из
// стилей движок округлил бы до пункта и чуть растянул бы наклейку под бумагу — полоски
// съехали бы с точек принтера. На сайте размер из стилей нужен окну печати браузера.
// Поля нулевые и у страниц без имени: старый движок (программа для Windows 7 и 8) правила
// именованной страницы (@page sticker) не применяет и взял бы поля обычного листа —
// 12 мм, — разрезав наклейку на полоски. Пока наклейки на печати, другого не печатают
const NO_BOXES = '@top-center { content: none } @bottom-left { content: none } @bottom-right { content: none }'
export function NakleykiDoc({ items, size, frame = false, title = '' }) {
  const s = sizeOf(size)
  const rule = `${isDesktop ? '' : `size: ${s.w}mm ${s.h}mm; `}margin: 0; ${NO_BOXES}`
  return (
    <PrintDoc prio={2} kind="sticker" title={title}>
      <style>{`@page { ${rule} } @page sticker { ${rule} }`}</style>
      {items.map((it) => (
        <Nakleyka key={it.key} data={it.data} frame={frame} />
      ))}
    </PrintDoc>
  )
}

// ── Выбор размера наклейки: ходовые размеры кнопками и свой ──
export function SizePicker({ value, onChange, testid = 'nk-size' }) {
  const t = useT()
  const id = sizeId(value)
  const [custom, setCustom] = useState(id === 'custom')
  const [cw, setCw] = useState(String(value.w))
  const [ch, setCh] = useState(String(value.h))
  // Размер, который поле отправило само, пока человек набирает: его в поля не возвращаем,
  // иначе набранное «40,3» на глазах превращалось бы в «40.5»
  const sent = useRef(null)
  // Размер поменяли снаружи (настройки прочитались позже) — поля следом
  useEffect(() => {
    if (sent.current && sent.current.w === value.w && sent.current.h === value.h) return
    setCw(String(value.w))
    setCh(String(value.h))
    if (sizeId(value) === 'custom') setCustom(true)
  }, [value.w, value.h]) // eslint-disable-line react-hooks/exhaustive-deps

  const L = SIZE_LIMITS
  const inLimits = (w, h) => w >= L.wMin && w <= L.wMax && h >= L.hMin && h <= L.hMax
  const num = (v) => Number(String(v).replace(',', '.'))
  // Пока человек набирает число, размер меняется, только когда оно уже в пределах;
  // ушёл из поля — в поле встаёт то, что действует (пустое или мусор — прежнее значение)
  const typed = (w, h) => {
    const nw = num(w)
    const nh = num(h)
    if (!inLimits(nw, nh)) return
    const s = sizeOf({ w: nw, h: nh })
    sent.current = s
    onChange(s)
  }
  const settle = () => {
    const okW = String(cw).trim() !== '' && Number.isFinite(num(cw)) && num(cw) > 0
    const okH = String(ch).trim() !== '' && Number.isFinite(num(ch)) && num(ch) > 0
    const s = sizeOf({ w: okW ? num(cw) : value.w, h: okH ? num(ch) : value.h })
    sent.current = null
    setCw(String(s.w))
    setCh(String(s.h))
    if (s.w !== value.w || s.h !== value.h) onChange(s)
  }

  return (
    <div className="field" data-testid={testid}>
      <label>{t('Размер наклейки')}</label>
      <div className="chips">
        {NAKLEYKA_SIZES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={'chip' + (!custom && id === s.id ? ' active' : '')}
            data-size={s.id}
            onClick={() => {
              setCustom(false)
              onChange({ w: s.w, h: s.h })
            }}
          >
            {sizeText(s)}
          </button>
        ))}
        <button type="button" className={'chip' + (custom ? ' active' : '')} data-size="custom" onClick={() => setCustom(true)}>
          {t('Свой размер')}
        </button>
      </div>
      {custom && (
        <div className="row nk-custom">
          <div className="field">
            <label>{t('Ширина, мм')}</label>
            <NumberInput
              value={cw}
              onChange={(e) => {
                setCw(e.target.value)
                typed(e.target.value, ch)
              }}
              onBlur={settle}
              data-testid={testid + '-w'}
            />
          </div>
          <div className="field">
            <label>{t('Высота, мм')}</label>
            <NumberInput
              value={ch}
              onChange={(e) => {
                setCh(e.target.value)
                typed(cw, e.target.value)
              }}
              onBlur={settle}
              data-testid={testid + '-h'}
            />
          </div>
          <div className="tag-cat nk-limits">{t('Ширина от 25 до 110 мм, высота от 20 до 150 мм')}</div>
        </div>
      )}
    </div>
  )
}
