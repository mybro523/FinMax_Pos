import { useState } from 'react'
import { LuFileSpreadsheet, LuPrinter } from 'react-icons/lu'
import { useToast } from './ui'
import PrintDoc, { PrintFoot, PrintHead } from './PrintDoc'
import { useT } from '../lib/i18n'
import { pechat } from '../lib/pechat'

// ── Кнопки «Экспорт Excel» и «Печать» для шапки раздела ──
// Excel собирает страница (onExcel) — библиотека подгружается по клику.
// «Печать» печатает лист PrintSheet этой же страницы: на сайте — окном печати
// браузера, в программе — через её экран печати с предпросмотром (lib/pechat.js).
export default function ExportPechat({ onExcel }) {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <>
      <button
        className="btn ghost"
        data-tour="export.excel"
        disabled={busy}
        title={t('Экспорт Excel')}
        aria-label={t('Экспорт Excel')}
        onClick={async () => {
          setBusy(true)
          try {
            await onExcel()
          } catch (e) {
            toast(t(e.message || 'Не получилось сохранить файл'), 'err')
          } finally {
            setBusy(false)
          }
        }}
      >
        <span className="ic"><LuFileSpreadsheet size={16} /></span> <span className="btn-text">{busy ? t('Готовим…') : t('Экспорт Excel')}</span>
      </button>
      <button className="btn ghost" data-tour="export.print" onClick={() => pechat({ kind: 'sheet' })} title={t('Печать')} aria-label={t('Печать')}>
        <span className="ic"><LuPrinter size={16} /></span> <span className="btn-text">{t('Печать')}</span>
      </button>
    </>
  )
}

// ── Печатный лист раздела ──
// На экране не виден; при печати — то, что уходит на бумагу: тёмно-синяя шапка с
// магазином, названием листа и датой, таблица ЦЕЛИКОМ (а не только видимая страница
// списка) с синей строкой заголовков — она повторяется на каждом листе — и синей
// строкой итога. svodka — короткая таблица над основной (например, итоги по
// статьям); listy — ещё таблицы под основной, каждая со своим заголовком (у панели
// управления — склад, долги, продажи за день)
export function PrintSheet({ zagolovok, podzag, cols, rows, itogi, svodka, listy }) {
  return (
    <PrintDoc prio={1} kind="sheet" title={zagolovok}>
      <PrintHead title={zagolovok} sub={podzag} />
      {svodka && <PrintTable cols={svodka.cols} rows={svodka.rows} itogi={svodka.itogi} title={svodka.zagolovok} className="pd-svodka" />}
      <PrintTable cols={cols} rows={rows} itogi={itogi} className="pd-main" />
      <PrintFoot count={rows.length} />
      {(listy || []).map((l, n) => (
        <PrintTable key={n} className="pd-dop" title={l.zagolovok} cols={l.cols} rows={l.rows} itogi={l.itogi} />
      ))}
    </PrintDoc>
  )
}

// Таблица печатного листа: синяя строка заголовков, светлые строки с лёгкой полосой,
// итог синей строкой. Числа и деньги — по правому краю
function PrintTable({ title, cols, rows, itogi, className }) {
  const right = (c) => (c.money || c.num ? 'num' : undefined)
  return (
    <div className={'pd-block ' + className}>
      {title && <div className="pd-block-title">{title}</div>}
      <table className="pd-table">
        <thead>
          <tr>{cols.map((c) => <th key={c.key} className={right(c)}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>
              {cols.map((c) => (
                <td key={c.key} className={right(c)}>{c.money ? moneyText(r[c.key]) : String(r[c.key] ?? '')}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr className="pd-empty"><td colSpan={cols.length}>—</td></tr>
          )}
          {/* Итог — последней строкой тела, а не в <tfoot>: подвал таблицы браузер
              повторяет внизу каждого листа, а итог нужен один — в конце */}
          {itogi && (
            <tr className="pd-total">
              {cols.map((c) => (
                <td key={c.key} className={right(c)}>
                  {c.money && typeof itogi[c.key] === 'number' ? moneyText(itogi[c.key]) : String(itogi[c.key] ?? '')}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// Минус ноль («изъято −0») печатается просто нулём
const moneyText = (v) => {
  if (typeof v !== 'number') return String(v ?? '')
  const n = v === 0 ? 0 : v
  return n.toLocaleString('ru-RU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })
}
