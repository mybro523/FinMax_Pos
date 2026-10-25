import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { LuPrinter, LuFileDown, LuChevronLeft, LuChevronRight, LuFileText } from 'react-icons/lu'
import { Modal, useToast } from './ui'
import NumberInput from './NumberInput'
import { printRoot } from './PrintDoc'
import { bridge } from '../lib/desktop'
import { printConfig } from '../lib/print'
import { activeDoc, closePechat, onPechat, pdfName, pechatState, printTitle } from '../lib/pechat'
import { useAuth } from '../db/auth'
import { translate as tr, useT } from '../lib/i18n'

// ── Экран печати программы для Windows ──
//
// Окно печати Windows для программ на этой основе предпросмотр не показывает — так и
// пишет. Поэтому у программы экран свой, как у браузера на сайте: слева страницы
// точно такими, какими их выдаст принтер, справа — на чём и как печатать.
//
// Страницы делает сама программа: печатный слой (PrintDoc) уходит в PDF тем же
// движком, что и на принтер, а здесь PDF рисуется постранично (pdf.js — грузится
// только при первом открытии экрана). Чек на чековой ленте печатается строками
// (ESC/POS), поэтому вместо страниц показывается сама лента — строка в строку, как
// её разложит основная часть программы для принтера.
//
// На сайте этого экрана нет: там печатает окно браузера, и предпросмотр у него есть.

const BUMAGA_KEY = 'apteka_pechat_bumaga'

// Знаков в строке ленты: 58 мм — 32, 80 мм — 48 (как в настройках чекового принтера)
const PAPERS = [
  { id: '58', label: 'Лента 58 мм', width: 32 },
  { id: '80', label: 'Лента 80 мм', width: 48 },
  { id: 'a4', label: 'Лист A4' },
]

// Длинная сторона страницы на экране, в CSS-пикселях: под неё считается чёткость
const PAGE_PX = 1000

function savedPaper() {
  try {
    const p = localStorage.getItem(BUMAGA_KEY)
    return PAPERS.some((x) => x.id === p) ? p : '58'
  } catch {
    return '58'
  }
}

// Один экран на всю программу: «Печать» в любом разделе зовёт pechat() (lib/pechat.js)
export function PechatHost() {
  const req = useSyncExternalStore(onPechat, pechatState, pechatState)
  if (!req || !bridge?.print?.preview) return null
  return <PrintPreview key={req.at} req={req} onClose={closePechat} />
}

// pdf.js — только здесь и только по требованию: сайту он не нужен вовсе.
// Сборка legacy: программа для Windows 7 и 8 работает на старом движке (Chrome 108),
// а обычная сборка pdf.js требует Chrome 119 и новее. legacy работает и на новом движке —
// поэтому путь один для обеих программ
let pdfjsLoad = null
function loadPdfjs() {
  if (!pdfjsLoad) {
    pdfjsLoad = Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })
    pdfjsLoad.catch(() => {
      pdfjsLoad = null
    })
  }
  return pdfjsLoad
}

const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))

function PrintPreview({ req, onClose }) {
  const t = useT()
  const toast = useToast()
  const kind = req.kind || 'sheet'
  const isTicket = kind === 'ticket'
  const roll = kind === 'sticker'
  // Повернуть можно лист раздела и лист этикеток; чек и наклейка — по размеру бумаги
  const canRotate = kind === 'sheet' || kind === 'opu' || kind === 'labels'
  const doc = useMemo(() => activeDoc(printRoot()), [])
  const title = doc?.getAttribute('data-title') || ''
  const shop = useAuth()?.pharmacy?.name || ''

  // Пока экран печати открыт, заголовок окна — «документ — магазин»: программа пишет его в
  // свойства PDF (предпросмотр, печать, «Сохранить в PDF»), и в PDF магазина не попадёт имя
  // программы. Закрыли — прежний
  useEffect(() => {
    const want = printTitle(title, shop)
    if (!want) return undefined
    const old = document.title
    document.title = want
    return () => {
      document.title = old
    }
  }, [title, shop])

  const [paper, setPaper] = useState(() => (isTicket ? savedPaper() : 'a4'))
  // Ширина ленты в знаках; 0 — печать страницами
  const lentaW = isTicket ? PAPERS.find((p) => p.id === paper)?.width || 0 : 0
  const [printers, setPrinters] = useState([])
  const [tillPrinter, setTillPrinter] = useState('')
  // Выбор принтера — свой для ленты и для листа: чековый принтер не должен «перейти»
  // на лист A4, а лазерный — на ленту
  const [picked, setPicked] = useState({ lenta: '', page: '' })
  const [landscape, setLandscape] = useState(false)
  const [copies, setCopies] = useState('1')
  const [pages, setPages] = useState([])
  const [count, setCount] = useState(0)
  const [at, setAt] = useState(0)
  const [state, setState] = useState('loading') // loading · ready · error
  const [tape, setTape] = useState(null)
  const [busy, setBusy] = useState('')

  // Принтеры Windows и чековый принтер из настроек
  useEffect(() => {
    let alive = true
    printConfig(true).then((c) => {
      if (!alive || !c) return
      setPrinters(c.printers || [])
      setTillPrinter(c.name || '')
    })
    return () => {
      alive = false
    }
  }, [])

  // Ленте нужен точный принтер: выбранный здесь или чековый из настроек. Чекового нет —
  // пусть человек выберет сам: строки ESC/POS на обычном принтере вышли бы мусором.
  // Листу — принтер по умолчанию Windows, пока не выбрали другой
  const printer = lentaW
    ? printers.includes(picked.lenta) ? picked.lenta : printers.includes(tillPrinter) ? tillPrinter : ''
    : printers.includes(picked.page) ? picked.page : ''
  const setPrinter = (name) => setPicked((p) => ({ ...p, [lentaW ? 'lenta' : 'page']: name }))

  // ── Страницы ──
  useEffect(() => {
    if (lentaW) return undefined
    let cancelled = false
    const urls = []
    setState('loading')
    setPages([])
    setCount(0)
    setAt(0)
    ;(async () => {
      try {
        if (!doc) throw new Error('Здесь нечего печатать.')
        const r = await bridge.print.preview({ landscape: canRotate && landscape, roll })
        if (!r?.ok) throw new Error(r?.error || 'Не получилось подготовить страницы. Повторите.')
        const pdfjs = await loadPdfjs()
        const pdf = await pdfjs.getDocument({ data: r.pdf, isEvalSupported: false }).promise
        if (cancelled) return pdf.destroy()
        setCount(pdf.numPages)
        const dpr = Math.min(2.5, Math.max(1.5, window.devicePixelRatio || 1))
        for (let i = 1; i <= pdf.numPages && !cancelled; i++) {
          const pg = await pdf.getPage(i)
          const base = pg.getViewport({ scale: 1 })
          const vp = pg.getViewport({ scale: (PAGE_PX * dpr) / Math.max(base.width, base.height) })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(vp.width)
          canvas.height = Math.ceil(vp.height)
          await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
          const blob = await toBlob(canvas)
          if (cancelled || !blob) break
          const url = URL.createObjectURL(blob)
          urls.push(url)
          setPages((prev) => {
            const next = prev.slice()
            next[i - 1] = { url, land: base.width > base.height }
            return next
          })
          if (i === 1) setState('ready')
        }
        pdf.destroy()
      } catch (e) {
        if (cancelled) return
        setState('error')
        toast(tr(e?.message || 'Не получилось подготовить страницы. Повторите.'), 'err')
      }
    })()
    return () => {
      cancelled = true
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
    // Страницы делаются заново, только когда меняется то, что меняет их вид
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lentaW, landscape])

  // ── Лента: строки так, как их разложит основная часть программы ──
  useEffect(() => {
    if (!lentaW) return undefined
    let alive = true
    setTape(null)
    bridge.print
      .tape({ ticket: req.ticket, width: lentaW })
      .then((r) => alive && setTape(r?.ok ? r : { lines: [] }))
      .catch(() => alive && setTape({ lines: [] }))
    return () => {
      alive = false
    }
  }, [lentaW, req.ticket])

  // Листать стрелками: ← → и PageUp/PageDown — если курсор не в поле
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') setAt((a) => Math.min(Math.max(0, count - 1), a + 1))
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') setAt((a) => Math.max(0, a - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count])

  const choosePaper = (id) => {
    setPaper(id)
    try {
      localStorage.setItem(BUMAGA_KEY, id)
    } catch {
      /* не запомнилось — не страшно */
    }
  }

  async function doPrint() {
    if (busy) return
    setBusy('print')
    try {
      const n = Math.max(1, Math.min(99, Math.trunc(Number(copies) || 1)))
      const r = lentaW
        ? await bridge.print.raw({ ticket: req.ticket, printer, width: lentaW, copies: n })
        : await bridge.print.page({ printer, landscape: canRotate && landscape, copies: n, roll })
      if (!r?.ok) throw new Error(r?.error || 'Не удалось отправить задание на принтер.')
      toast(t('Отправлено на принтер'))
      onClose()
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setBusy('')
    }
  }

  async function doPdf() {
    if (busy) return
    setBusy('pdf')
    try {
      const r = await bridge.print.pdf({ landscape: canRotate && landscape, roll, name: pdfName(title || t('Печать')) })
      if (r?.canceled) return
      if (!r?.ok) throw new Error(r?.error || 'Не получилось. Повторите.')
      toast(t('PDF сохранён'))
      onClose()
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setBusy('')
    }
  }

  const page = pages[at]
  return (
    <Modal className="pp" wide title={<><span className="ic"><LuPrinter size={18} /></span>{t('Печать')}</>} onClose={onClose}>
      <div className="pp-body">
        <div className="pp-view">
          <div className="pp-stage" data-testid="pp-stage">
            {lentaW ? (
              <TapeView tape={tape} width={lentaW} />
            ) : state === 'error' ? (
              <div className="pp-msg">{t('Не получилось подготовить страницы. Повторите.')}</div>
            ) : page ? (
              <img className={'pp-page' + (page.land ? ' land' : '')} src={page.url} alt={`${t('стр.')} ${at + 1}`} />
            ) : (
              <div className="pp-msg"><span className="pp-spin" aria-hidden="true" /> {t('Готовим страницы…')}</div>
            )}
          </div>
          {!lentaW && count > 0 && (
            <div className="pp-nav" data-testid="pp-nav">
              <button type="button" className="btn ghost sm icon" onClick={() => setAt((a) => Math.max(0, a - 1))} disabled={at === 0} aria-label={t('Предыдущая страница')} title={t('Предыдущая страница')}>
                <LuChevronLeft size={18} />
              </button>
              <span>
                {t('стр.')} <b>{at + 1}</b> {t('из')} <b>{count}</b>
              </span>
              <button type="button" className="btn ghost sm icon" onClick={() => setAt((a) => Math.min(count - 1, a + 1))} disabled={at >= count - 1} aria-label={t('Следующая страница')} title={t('Следующая страница')}>
                <LuChevronRight size={18} />
              </button>
            </div>
          )}
        </div>

        <div className="pp-side">
          <div className="pp-doc">
            <span className="ic"><LuFileText size={16} /></span>
            <b>{title || t('Печать')}</b>
          </div>
          {isTicket && (
            <div className="field">
              <label htmlFor="pp-paper">{t('Бумага')}</label>
              <select id="pp-paper" value={paper} onChange={(e) => choosePaper(e.target.value)}>
                {PAPERS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="pp-printer">{t('Принтер')}</label>
            <select id="pp-printer" value={printer} onChange={(e) => setPrinter(e.target.value)}>
              {!lentaW && <option value="">{t('Принтер по умолчанию')}</option>}
              {lentaW && !printer && <option value="">{printers.length ? t('Выберите чековый принтер') : t('Принтеров не найдено')}</option>}
              {printers.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          {canRotate && (
            <div className="field">
              <label>{t('Ориентация')}</label>
              <div className="pp-seg" role="group" aria-label={t('Ориентация')}>
                <button type="button" className={'chip' + (!landscape ? ' active' : '')} onClick={() => setLandscape(false)} disabled={busy !== ''}>{t('Книжная')}</button>
                <button type="button" className={'chip' + (landscape ? ' active' : '')} onClick={() => setLandscape(true)} disabled={busy !== ''}>{t('Альбомная')}</button>
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="pp-copies">{t('Копий')}</label>
            <NumberInput id="pp-copies" integer value={copies} onChange={(e) => setCopies(e.target.value)} />
          </div>
          <p className="pp-hint">
            {lentaW
              ? t('Чек уйдёт на чековый принтер строками, как на ленте: название магазина и итог — белым по чёрному.')
              : count > 0
                ? `${t('Страниц')}: ${count}`
                : ''}
          </p>
          <div className="pp-actions">
            <button type="button" className="btn" onClick={doPrint} disabled={!!busy || (lentaW ? !printer : state !== 'ready')}>
              <span className="ic"><LuPrinter size={16} /></span> {busy === 'print' ? t('Печать…') : t('Печать')}
            </button>
            <button type="button" className="btn ghost" onClick={doPdf} disabled={!!busy || !doc}>
              <span className="ic"><LuFileDown size={16} /></span> {busy === 'pdf' ? t('Сохранение…') : t('Сохранить в PDF')}
            </button>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy === 'print'}>{t('Отмена')}</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// Лента чекового принтера: строки ровно так, как их напечатает принтер (моноширинным
// шрифтом, жирные и крупные — как на ленте, название и итог — белым по чёрному)
function TapeView({ tape, width }) {
  if (!tape) return <div className="pp-msg"><span className="pp-spin" aria-hidden="true" /> {tr('Готовим чек…')}</div>
  return (
    <div className="pp-tape" style={{ '--cols': width }} data-testid="pp-tape">
      {tape.lines.map((l, i) => (
        <div key={i} className={'pp-tl' + (l.center ? ' c' : '') + (l.bold ? ' b' : '') + (l.tall ? ' t' : '') + (l.invert ? ' inv' : '')}>
          <span>{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
