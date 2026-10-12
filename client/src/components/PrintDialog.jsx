import { useCallback, useEffect, useState } from 'react'
import { LuPrinter, LuFileDown } from 'react-icons/lu'
import { Modal, useToast } from './ui'
import TicketView from './TicketView'
import { bridge } from '../lib/desktop'
import { printConfig, printTicket } from '../lib/print'
import { translate as tr, useT } from '../lib/i18n'

// ── Свой экран печати (программа для Windows) ──
//
// Окно печати Chromium в программе не умеет предпросмотр — так и пишет. Поэтому,
// когда чековый принтер не настроен, программа показывает свой экран: слева чек
// как он будет напечатан, справа — на чём печатать. Лента 58/80 мм уходит на
// выбранный принтер напрямую, строками (ESC/POS, с эмблемой); лист A4 печатается
// как страница; «Сохранить в PDF» кладёт чек файлом — отправить или подшить.
//
// На сайте этого экрана нет: там печатает окно браузера, у него предпросмотр есть.

const BUMAGA_KEY = 'apteka_pechat_bumaga'

// Знаков в строке ленты: 58 мм — 32, 80 мм — 48 (как в настройках чекового принтера)
const PAPERS = [
  { id: '58', label: 'Лента 58 мм', width: 32 },
  { id: '80', label: 'Лента 80 мм', width: 48 },
  { id: 'a4', label: 'Лист A4' },
]

// Печать из чека: на сайте — окно браузера; в программе с настроенным чековым
// принтером — сразу в него, как раньше; иначе — свой экран печати.
// Возвращает { print, dialog }: dialog рисуется рядом с чеком.
export function usePechat() {
  const toast = useToast()
  const [ticket, setTicket] = useState(null)
  const print = useCallback(
    async (tk) => {
      try {
        if (!bridge?.print) {
          window.print()
          return
        }
        const c = await printConfig()
        if (c && c.mode !== 'system') {
          await printTicket(tk)
          return
        }
        setTicket(tk)
      } catch (e) {
        toast(tr(e.message), 'err')
      }
    },
    [toast],
  )
  const dialog = ticket ? <PrintDialog ticket={ticket} onClose={() => setTicket(null)} /> : null
  return { print, dialog }
}

export default function PrintDialog({ ticket, onClose }) {
  const t = useT()
  const toast = useToast()
  const [printers, setPrinters] = useState([])
  const [printer, setPrinter] = useState('')
  const [paper, setPaper] = useState(() => {
    try {
      const p = localStorage.getItem(BUMAGA_KEY)
      return PAPERS.some((x) => x.id === p) ? p : '58'
    } catch {
      return '58'
    }
  })
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    printConfig().then((c) => {
      if (!alive || !c) return
      setPrinters(c.printers || [])
      // Чековому принтеру нужно точное имя — подставляем первое, чтобы не печатать в пустоту
      setPrinter((p) => p || c.name || c.printers?.[0] || '')
    })
    return () => {
      alive = false
    }
  }, [])

  // Пока открыт этот экран, печатается его предпросмотр, а не чек под ним
  useEffect(() => {
    document.body.setAttribute('data-print-dlg', '1')
    return () => document.body.removeAttribute('data-print-dlg')
  }, [])

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
      const lenta = PAPERS.find((p) => p.id === paper && p.width)
      const r = lenta
        ? await bridge.print.raw({ ticket, printer, width: lenta.width })
        : await bridge.print.page({ printer })
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
      const r = await bridge.print.pdf()
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

  const lenta = paper !== 'a4'
  return (
    <Modal className="printable print-dlg" wide title={<><span className="ic"><LuPrinter size={18} /></span>{t('Печать')}</>} onClose={onClose}>
      <div className="print-dlg-body">
        <div className={'print-paper p' + paper}>
          <TicketView ticket={ticket} />
        </div>
        <div className="print-side no-print">
          <div className="field">
            <label htmlFor="pd-paper">{t('Бумага')}</label>
            <select id="pd-paper" value={paper} onChange={(e) => choosePaper(e.target.value)}>
              {PAPERS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pd-printer">{t('Принтер')}</label>
            <select id="pd-printer" value={printer} onChange={(e) => setPrinter(e.target.value)}>
              {!lenta && <option value="">{t('Принтер по умолчанию')}</option>}
              {printers.map((name) => <option key={name} value={name}>{name}</option>)}
              {lenta && printers.length === 0 && <option value="">{t('Принтеров не найдено')}</option>}
            </select>
          </div>
          {lenta && (
            <p className="print-hint">{t('Чек уйдёт на принтер строками, как на чековую ленту — с эмблемой и без полей.')}</p>
          )}
          <div className="print-side-actions">
            <button className="btn" onClick={doPrint} disabled={!!busy || (lenta && !printer)}>
              <span className="ic"><LuPrinter size={16} /></span> {busy === 'print' ? t('Печать…') : t('Печать')}
            </button>
            <button className="btn ghost" onClick={doPdf} disabled={!!busy}>
              <span className="ic"><LuFileDown size={16} /></span> {busy === 'pdf' ? t('Сохранение…') : t('Сохранить в PDF')}
            </button>
            <button className="btn ghost" onClick={onClose} disabled={!!busy}>{t('Отмена')}</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
