import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { LuPrinter, LuTag } from 'react-icons/lu'
import { Modal, useToast } from './ui'
import NumberInput from './NumberInput'
import { NakleykiDoc, NakleykaPreview, SizePicker, stickerOf } from './Nakleyka'
import { MAX_TOTAL, PROBLEM_TEXT, copiesOf, nakleekNaStroku, razvernut, savedSize, saveSize, sizeText, totalOf } from '../lib/nakleyka'
import { labelConfig, labelPrinterOf } from '../lib/print'
import { pechatNakleyki } from '../lib/pechat'
import { fmtDateTime } from '../lib/time'
import { isDesktop } from '../lib/desktop'
import { translate as tr, useT } from '../lib/i18n'

// ── Этикетки на весь приход ──
// Пришёл товар — на каждую упаковку нужна наклейка со штрихкодом и ценой. Здесь —
// все товары накладной: у каждого «сколько наклеек» (сразу — сколько упаковок пришло,
// весовому — одна), поправить можно, ноль — пропустить. Одна «Печать» на всё: наклейки
// идут подряд, товар за товаром. Цена — нынешняя, из карточки товара.

export default function PrihodNakleyki({ arrival, products, onClose }) {
  const t = useT()
  const toast = useToast()
  // Настройка принтера этикеток: undefined — ещё читается (в программе до ответа печатать
  // нельзя: наклейки нарисованы бы по размеру из памяти браузера), null — её нет (сайт)
  const [cfg, setCfg] = useState(isDesktop ? undefined : null)
  const [size, setSize] = useState(savedSize)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    labelConfig(true).then((c) => alive && setCfg(c || null))
    return () => {
      alive = false
    }
  }, [])
  const ready = cfg !== undefined
  const printer = labelPrinterOf(cfg)
  const useSize = printer ? { w: cfg.w, h: cfg.h } : size
  const dpi = printer ? cfg.dpi : 203

  // Строки накладной с товарами из справочника. Товар удалили — наклейку не из чего делать
  const lines = useMemo(
    () =>
      (arrival.items || []).map((i, n) => {
        const p = products.find((x) => x.id === i.productId) || null
        return { key: String(i.id || n), item: i, product: p, start: nakleekNaStroku(i, p) }
      }),
    [arrival, products],
  )
  // Сколько наклеек на строку — поле на каждую. Товары справочника могли догрузиться позже
  // окна: строке, у которой товар появился, число подставляется тогда же, один раз
  const seeded = useRef(new Set())
  const [counts, setCounts] = useState({})
  useEffect(() => {
    // Что подставить — считается здесь, а не внутри setCounts: функцию обновления React
    // вправе вызвать дважды, и второй вызов увидел бы строки уже «засеянными»
    const patch = {}
    for (const l of lines) {
      if (!l.product || seeded.current.has(l.key)) continue
      seeded.current.add(l.key)
      patch[l.key] = String(l.start)
    }
    if (Object.keys(patch).length) setCounts((c) => ({ ...patch, ...c }))
  }, [lines])

  const shift = printer ? { dx: cfg.dx, dy: cfg.dy, flip: cfg.flip } : {}
  const rows = useMemo(
    () =>
      lines.map((l) => {
        const data = l.product ? stickerOf(l.product, useSize, dpi, shift) : null
        const problem = !l.product ? 'gone' : data.plan.problem
        return { ...l, data, problem, count: problem ? 0 : copiesOf(counts[l.key]) }
      }),
    [lines, counts, useSize.w, useSize.h, dpi, shift.dx, shift.dy, shift.flip], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const total = totalOf(rows)
  const later = useDeferredValue(rows)
  const items = useMemo(() => razvernut(later.filter((r) => !r.problem)).map((x) => ({ key: x.key, data: x.data })), [later])
  // Печатный слой ещё не догнал поправленные числа — печатать рано
  const behind = later !== rows
  const first = rows.find((r) => !r.problem && r.count > 0) || rows.find((r) => !r.problem)

  const chooseSize = (s) => {
    setSize(s)
    saveSize(s)
  }

  async function doPrint() {
    if (busy || behind || !ready) return
    if (total < 1) return toast(t('Укажите, сколько наклеек напечатать'), 'err')
    setBusy(true)
    try {
      const where = await pechatNakleyki(useSize, { cfg })
      if (where === 'printer') toast(`${t('Отправлено на принтер этикеток')}: ${Math.min(total, MAX_TOTAL)}`)
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal className="label-print" wide title={<><span className="ic"><LuTag size={18} /></span>{t('Этикетки на приход')}</>} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 12 }}>
        {arrival.supplier ? `${arrival.supplier} · ` : ''}
        {fmtDateTime(arrival.date)}
      </div>

      <div className="lp-roll">
        <div className="lp-side">
          {printer ? (
            <div className="note info" data-testid="lp-printer">
              {t('Принтер этикеток')}: <b>{printer}</b> · {sizeText(useSize)}
              <div className="tag-cat">{t('Принтер и размер наклейки меняются в «Настройки → Чек и печать».')}</div>
            </div>
          ) : (
            <>
              <SizePicker value={size} onChange={chooseSize} />
              <div className="tag-cat" style={{ marginBottom: 10 }}>
                {isDesktop
                  ? t('Чтобы наклейки печатались сразу, без экрана печати, выберите принтер этикеток в «Настройки → Чек и печать».')
                  : t('В окне печати выберите принтер этикеток и бумагу того же размера.')}
              </div>
            </>
          )}
        </div>
        {first && <NakleykaPreview data={first.data} />}
      </div>

      <div className="table-scroll" style={{ maxHeight: '38vh' }}>
        <table data-testid="pn-table">
          <thead>
            <tr>
              <th>{t('Товар')}</th>
              <th>{t('Штрихкод')}</th>
              <th className="num">{t('Наклеек')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-testid="pn-row">
                <td>{r.product?.name || r.item.name}</td>
                <td>
                  {r.problem ? (
                    <span className="pn-problem">{r.problem === 'gone' ? t('Товара больше нет в справочнике') : t(PROBLEM_TEXT[r.problem])}</span>
                  ) : (
                    <span className="pn-code">{r.data.code}</span>
                  )}
                </td>
                <td className="num">
                  <NumberInput
                    integer
                    className="pn-count"
                    value={r.problem ? '0' : (counts[r.key] ?? '')}
                    disabled={!!r.problem}
                    onChange={(e) => setCounts((c) => ({ ...c, [r.key]: e.target.value }))}
                    aria-label={t('Наклеек')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="total-row big">
        <span>{t('Всего наклеек')}</span>
        <span data-testid="pn-total">{total}</span>
      </div>
      {total > MAX_TOTAL && <div className="note warn">{t('За один раз печатается не больше 2000 наклеек — остальные напечатайте следующим разом.')}</div>}

      <NakleykiDoc items={items} size={useSize} title={`${t('Этикетки на приход')} — ${arrival.supplier || fmtDateTime(arrival.date)}`} />

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('Закрыть')}</button>
        <button className="btn" onClick={doPrint} disabled={busy || total < 1 || behind || !ready} data-testid="pn-print">
          <span className="ic"><LuPrinter size={16} /></span> {busy ? t('Печать…') : t('Печать')}
        </button>
      </div>
    </Modal>
  )
}
