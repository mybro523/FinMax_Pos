import { useEffect, useMemo, useRef, useState } from 'react'
import { LuMinus, LuPlus, LuTag } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { forgetLabelConfig } from '../lib/print'
import { sizeText } from '../lib/nakleyka'
import { translate as tr, useT } from '../lib/i18n'
import { useToast } from './ui'
import { NakleykiDoc, NakleykaPreview, SizePicker, stickerFrom, stickerOf } from './Nakleyka'

// ── Принтер этикеток (программа для Windows) ──
// Наклейки со штрихкодом печатаются на нём сразу, без экрана печати: из окна товара,
// из прихода. Здесь выбирают принтер, размер наклейки и разрешение принтера, а если
// принтер кладёт наклейку чуть мимо или вверх ногами — сдвиг и поворот. «Пробная
// наклейка» печатает две наклейки с рамкой по краю: по рамке видно, ровно ли легло, по
// второй — попадает ли принтер в следующую наклейку.
//
// Настройка относится к этому компьютеру, как и чековый принтер.

// Коды пробной наклейки и образца на экране: EAN-13, а на узкой наклейке, где он не
// помещается, — EAN-8 или короткий Code 128. Наклейка не должна выйти пустой
const PROBA_CODES = ['4600000000008', '96385074', '1234']
const OBRAZEC_CODES = ['4870204010060', '96385074', '1234']
const firstFitting = (codes, make) => {
  for (const code of codes) {
    const d = make(code)
    if (!d.plan.problem) return d
  }
  return make(codes[codes.length - 1])
}

const fmtMm = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + String(Math.abs(v)).replace('.', ',') + ' мм'

function Sdvig({ label, value, onChange, less, more, testid }) {
  const v = Math.round((Number(value) || 0) * 10) / 10
  const set = (x) => onChange(Math.max(-10, Math.min(10, Math.round(x * 10) / 10)))
  return (
    <div className="field">
      <label>{label}</label>
      <div className="nk-step">
        <button type="button" className="btn ghost sm icon" onClick={() => set(v - 0.5)} aria-label={less} title={less} data-testid={testid + '-less'}>
          <LuMinus size={15} />
        </button>
        <span className="nk-step-val" data-testid={testid}>{fmtMm(v)}</span>
        <button type="button" className="btn ghost sm icon" onClick={() => set(v + 0.5)} aria-label={more} title={more} data-testid={testid + '-more'}>
          <LuPlus size={15} />
        </button>
      </div>
    </div>
  )
}

export default function LabelPrinterPanel() {
  const t = useT()
  const toast = useToast()
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState('')
  const [proba, setProba] = useState(null)
  const printedFor = useRef(0)

  useEffect(() => {
    let alive = true
    bridge.labels.config().then((c) => alive && setCfg(c), () => {})
    return () => {
      alive = false
    }
  }, [])

  const size = cfg ? { w: cfg.w, h: cfg.h } : { w: 58, h: 40 }
  const obrazec = useMemo(
    () => (cfg ? firstFitting(OBRAZEC_CODES, (code) => stickerOf({ name: t('Пример товара'), price: 25.5, barcode: code }, { w: cfg.w, h: cfg.h }, cfg.dpi, { dx: cfg.dx, dy: cfg.dy, flip: cfg.flip })) : null),
    [cfg?.w, cfg?.h, cfg?.dpi, cfg?.dx, cfg?.dy, cfg?.flip, t], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // Пробные наклейки: две, с рамкой по краю, на них — размер и номер
  const probaItems = useMemo(() => {
    if (!proba) return []
    const s = { w: proba.w, h: proba.h }
    const shift = { dx: proba.dx, dy: proba.dy, flip: proba.flip }
    return [1, 2].map((k) => ({ key: 'proba' + k, data: firstFitting(PROBA_CODES, (code) => stickerFrom({ name: `${tr('Пробная наклейка')} ${k} ${tr('из')} 2`, price: sizeText(s), code }, s, proba.dpi, shift)) }))
  }, [proba])

  // Наклейки нарисованы в печатном слое — отправить их на принтер. Один раз на пробу
  // (в режиме разработки React вызывает эффект дважды)
  useEffect(() => {
    if (!proba || printedFor.current === proba.at) return
    printedFor.current = proba.at
    let alive = true
    ;(async () => {
      try {
        const r = await bridge.labels.print({ w: proba.w, h: proba.h })
        if (r?.ok) toast(t('Пробные наклейки отправлены на принтер'))
        else toast(tr(r?.error || 'Не удалось отправить задание на принтер.'), 'err')
      } catch {
        toast(t('Не получилось. Повторите.'), 'err')
      } finally {
        if (alive) {
          setProba(null)
          setBusy('')
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [proba]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return null
  const set = (patch) => setCfg({ ...cfg, ...patch })
  const strip = (c) => {
    const { printers: _printers, ...rest } = c
    return rest
  }

  async function save() {
    setBusy('save')
    try {
      const saved = await bridge.labels.setConfig(strip(cfg))
      if (!saved) throw new Error()
      setCfg({ ...saved, printers: cfg.printers })
      forgetLabelConfig()
      toast(t('Сохранено'))
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  // Пробуем с тем, что на экране: сначала сохранить, потом печатать
  async function probe() {
    setBusy('test')
    try {
      const saved = await bridge.labels.setConfig(strip(cfg))
      if (!saved) throw new Error()
      setCfg({ ...saved, printers: cfg.printers })
      forgetLabelConfig()
      if (!saved.printer) {
        toast(t('Выберите принтер этикеток'), 'err')
        setBusy('')
        return
      }
      setProba({ ...saved, at: Date.now() })
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
      setBusy('')
    }
  }

  const printers = cfg.printers || []
  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="label-panel">
      <h2><span className="h2-title"><span className="ic"><LuTag size={17} /></span>{t('Принтер этикеток')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Наклейки со штрихкодом печатаются на нём сразу, без экрана печати — из окна товара и из прихода. Настройка этого компьютера.')}
      </p>

      <div className="field">
        <label htmlFor="lbl-printer">{t('Принтер')}</label>
        {/* Выбранного принтера нет в Windows — он всё равно в списке, с пометкой: иначе
            список показал бы «не выбран», а настройка тихо хранила бы прежнее имя */}
        <select id="lbl-printer" value={cfg.printer} onChange={(e) => set({ printer: e.target.value })} data-testid="label-printer">
          <option value="">{t('— не выбран: печать через экран печати —')}</option>
          {cfg.printer && !printers.includes(cfg.printer) && <option value={cfg.printer}>{`${cfg.printer} — ${t('нет в Windows')}`}</option>}
          {printers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="tag-cat">
          {cfg.printer && !printers.includes(cfg.printer)
            ? `${t('Принтер с таким именем в Windows не найден.')} (${cfg.printer})`
            : t('Принтер должен быть установлен в Windows: драйвер — с диска или с сайта производителя.')}
        </div>
      </div>

      <SizePicker value={size} onChange={(s) => set({ w: s.w, h: s.h })} testid="label-size" />

      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="lbl-dpi">{t('Разрешение принтера')}</label>
        <select id="lbl-dpi" value={cfg.dpi} onChange={(e) => set({ dpi: Number(e.target.value) })} data-testid="label-dpi">
          <option value={203}>{t('203 dpi — у большинства')}</option>
          <option value={300}>300 dpi</option>
        </select>
        <div className="tag-cat">{t('Написано в описании принтера. Под него подгоняются полоски штрихкода, чтобы сканер читал с первого раза.')}</div>
      </div>

      <div className="nk-set">
        <div className="nk-set-fields">
          <div className="row">
            <Sdvig label={t('Сдвиг вправо')} value={cfg.dx} onChange={(v) => set({ dx: v })} less={t('Левее')} more={t('Правее')} testid="label-dx" />
            <Sdvig label={t('Сдвиг вниз')} value={cfg.dy} onChange={(v) => set({ dy: v })} less={t('Выше')} more={t('Ниже')} testid="label-dy" />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, margin: '2px 0 8px' }}>
            <input type="checkbox" checked={!!cfg.flip} onChange={(e) => set({ flip: e.target.checked })} style={{ width: 16, height: 16 }} data-testid="label-flip" />
            {t('Перевернуть наклейку (если выходит вверх ногами)')}
          </label>
        </div>
        {obrazec && <NakleykaPreview data={obrazec} frame zoom={1.3} />}
      </div>

      <div className="tag-cat" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        {t('В настройках печати принтера в Windows поставьте тот же размер наклейки.')}{' '}
        {t('Пробная наклейка печатает две наклейки с рамкой. Белые поля вокруг рамки должны быть одинаковыми слева и справа, сверху и снизу: слева уже — сдвиньте вправо, сверху уже — вниз. Вторая наклейка легла на стык — откалибруйте принтер: обычно надо зажать кнопку FEED, пока он не прогонит несколько наклеек.')}
      </div>

      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" disabled={!!busy} onClick={save} data-testid="label-save">{busy === 'save' ? t('Сохранение…') : t('Сохранить')}</button>
        <button className="btn ghost" disabled={!!busy} onClick={probe} data-testid="label-test">{busy === 'test' ? t('Печатаем…') : t('Пробная наклейка')}</button>
      </div>

      {proba && <NakleykiDoc items={probaItems} size={{ w: proba.w, h: proba.h }} frame title={t('Пробная наклейка')} />}
    </div>
  )
}
