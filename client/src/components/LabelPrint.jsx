import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { LuPrinter, LuTag } from 'react-icons/lu'
import { Modal, useToast } from './ui'
import PrintDoc from './PrintDoc'
import NumberInput from './NumberInput'
import { NakleykiDoc, NakleykaPreview, SizePicker, stickerOf } from './Nakleyka'
import { barcodeModel, barcodeSvg, moduleFor, modulesOf } from '../lib/barcode'
import { PROBLEM_TEXT, copiesOf, nakleykaName, razvernut, savedSize, saveSize, sizeText } from '../lib/nakleyka'
import { labelConfig, labelPrinterOf } from '../lib/print'
import { pechat, pechatNakleyki } from '../lib/pechat'
import { money } from '../db/store'
import { isDesktop } from '../lib/desktop'
import { translate as tr, useT } from '../lib/i18n'

// ── Печать этикеток со штрихкодом ──
// Два вида:
//   • наклейки на принтере этикеток — каждая отдельной страницей ровно размера наклейки.
//     В программе с выбранным принтером этикеток («Настройки → Чек и печать») они уходят
//     в него сразу; иначе — экран печати программы или окно печати браузера;
//   • лист A4 с сеткой этикеток для обычного принтера — режется ножницами.
// Штрихкод — любой: EAN-13, EAN-8 или Code 128 (lib/barcode.js). Оформление листа A4 —
// фирменное (название тёмно-синим, цена на синей плашке), наклейка — чёрно-белая.

const VID_KEY = 'apteka_etiketki_vid'
function savedVid() {
  try {
    return localStorage.getItem(VID_KEY) === 'a4' ? 'a4' : 'roll'
  } catch {
    return 'roll'
  }
}

// Этикетка листа A4: 42 мм шириной, полоски — под обычный принтер (600 точек на дюйм)
function a4Label(product) {
  const model = barcodeModel(product.barcode)
  const module = model ? moduleFor(modulesOf(model), 39, 600) : 0
  return module ? barcodeSvg(model, { module, barMm: 16, fontMm: 2.8 }) : ''
}

export default function LabelPrint({ product, onClose }) {
  const t = useT()
  const toast = useToast()
  const [vid, setVid] = useState(savedVid)
  // Настройка принтера этикеток: undefined — ещё читается (в программе до ответа печатать
  // нельзя: наклейки нарисованы бы по размеру из памяти браузера), null — её нет (сайт)
  const [cfg, setCfg] = useState(isDesktop ? undefined : null)
  const [size, setSize] = useState(savedSize)
  const [copies, setCopies] = useState('1')
  const [a4count, setA4count] = useState('12')
  const [busy, setBusy] = useState(false)

  // Принтер этикеток этого компьютера (только в программе)
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

  // Сдвиг и поворот из настройки принтера этикеток — их учитывает раскладка
  const shift = printer ? { dx: cfg.dx, dy: cfg.dy, flip: cfg.flip } : {}
  const data = useMemo(() => stickerOf(product, useSize, dpi, shift), [product, useSize.w, useSize.h, dpi, shift.dx, shift.dy, shift.flip]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = copiesOf(copies)
  // Сотня наклеек в печатном слое перерисовывается не на каждую набранную цифру
  const nLater = useDeferredValue(n)
  const items = useMemo(() => razvernut([{ key: product.id || 'p', data, count: nLater }]).map((x) => ({ key: x.key, data: x.data })), [product.id, data, nLater])
  // Печатный слой ещё не догнал набранное число — печатать рано: ушло бы прежнее число наклеек
  const behind = nLater !== n

  const a4svg = useMemo(() => a4Label(product), [product])
  const a4n = Math.max(1, Math.min(80, Number(a4count) || 1))
  const title = `${tr('Этикетки')} — ${nakleykaName(product) || product.name}`

  const chooseVid = (v) => {
    setVid(v)
    try {
      localStorage.setItem(VID_KEY, v)
    } catch {
      /* не запомнилось — не страшно */
    }
  }
  const chooseSize = (s) => {
    setSize(s)
    saveSize(s)
  }

  const problem = vid === 'roll' ? data.plan.problem : product.barcode ? (a4svg ? '' : barcodeModel(product.barcode) ? 'toolong' : 'badcode') : 'nocode'

  async function doPrint() {
    if (busy || problem) return
    if (vid === 'a4') return pechat({ kind: 'labels' })
    if (n < 1) return toast(t('Укажите, сколько наклеек напечатать'), 'err')
    if (behind || !ready) return
    setBusy(true)
    try {
      const where = await pechatNakleyki(useSize, { cfg })
      if (where === 'printer') toast(`${t('Отправлено на принтер этикеток')}: ${n}`)
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setBusy(false)
    }
  }

  const label = (key) => (
    <div className="label-item" key={key}>
      <div className="label-name">{product.name}</div>
      {product.dosage ? <div className="label-dose">{product.dosage}</div> : null}
      <div className="label-bc" dangerouslySetInnerHTML={{ __html: a4svg }} />
      <div className="label-price">{money(product.price)}</div>
    </div>
  )
  const sheet = <div className="label-sheet a4">{Array.from({ length: a4n }, (_, i) => label(i))}</div>

  return (
    <Modal className="label-print" title={<><span className="ic"><LuTag size={18} /></span>{t('Печать этикеток')}</>} onClose={onClose} wide>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button type="button" className={'chip ' + (vid === 'roll' ? 'active' : '')} onClick={() => chooseVid('roll')} data-testid="lp-roll">
          {t('Наклейки')}
        </button>
        <button type="button" className={'chip ' + (vid === 'a4' ? 'active' : '')} onClick={() => chooseVid('a4')} data-testid="lp-a4">
          {t('Лист A4')}
        </button>
      </div>

      {problem ? (
        <>
          <div className="note err" style={{ marginBottom: 12 }} data-testid="lp-problem">{t(PROBLEM_TEXT[problem])}</div>
          {problem === 'nocode' && (
            <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
              {t('Откройте карточку товара и нажмите кнопку генерации рядом с полем штрихкода — система создаст свой код, и его можно будет распечатать.')}
            </p>
          )}
        </>
      ) : null}

      {vid === 'roll' ? (
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
            <div className="field" style={{ maxWidth: 200 }}>
              <label htmlFor="lp-copies">{t('Сколько наклеек')}</label>
              <NumberInput id="lp-copies" integer value={copies} onChange={(e) => setCopies(e.target.value)} data-testid="lp-copies" />
            </div>
          </div>
          {!problem && <NakleykaPreview data={data} />}
        </div>
      ) : (
        <>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t('Сколько этикеток')}</label>
            <NumberInput integer value={a4count} onChange={(e) => setA4count(e.target.value)} />
          </div>
          <div className="note info" style={{ marginBottom: 12 }}>{t('Печать на обычном принтере: лист с этикетками, разрежьте по рамкам.')}</div>
          {!problem && sheet}
        </>
      )}

      {/* На бумагу — из печатного слоя: наклейки страницами своего размера или лист A4 */}
      {!problem && vid === 'roll' && <NakleykiDoc items={items} size={useSize} title={title} />}
      {!problem && vid === 'a4' && (
        <PrintDoc prio={2} kind="labels" title={title}>
          {sheet}
        </PrintDoc>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('Закрыть')}</button>
        <button className="btn" onClick={doPrint} disabled={busy || !!problem || (vid === 'roll' && (n < 1 || behind || !ready))} data-testid="lp-print">
          <span className="ic"><LuPrinter size={16} /></span> {busy ? t('Печать…') : t('Печать')}
        </button>
      </div>
    </Modal>
  )
}
