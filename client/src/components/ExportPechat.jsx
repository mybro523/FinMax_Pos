import { useState } from 'react'
import { LuFileSpreadsheet, LuPrinter } from 'react-icons/lu'
import { useToast } from './ui'
import { getUser } from '../db/auth'
import { useT, translate as tr } from '../lib/i18n'
import { fmtDateTime } from '../lib/time'

// ── Кнопки «Экспорт Excel» и «Печать» для шапки раздела ──
// Excel собирает страница (onExcel) — библиотека подгружается по клику.
// Печать выводит блок PrintSheet этой же страницы: системное окно печати,
// на бумагу идёт только лист с таблицей.
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
        <span className="ic"><LuFileSpreadsheet size={16} /></span> {busy ? t('Готовим…') : t('Экспорт Excel')}
      </button>
      <button className="btn ghost" data-tour="export.print" onClick={() => window.print()}>
        <span className="ic"><LuPrinter size={16} /></span> {t('Печать')}
      </button>
    </>
  )
}

// ── Печатный лист раздела ──
// На экране не виден; при печати — единственное, что уходит на бумагу:
// название магазина, заголовок, подзаголовок с датой и таблица ЦЕЛИКОМ
// (а не только видимая страница списка). svodka — вторая, короткая таблица под
// основной (например, итоги по статьям)
export function PrintSheet({ zagolovok, podzag, cols, rows, itogi, svodka }) {
  const apt = getUser()?.pharmacy?.name || ''
  return (
    <div className="printable print-sheet">
      <div className="opu-print-head">
        <b>{apt}</b>
        <div>{zagolovok} · {fmtDateTime(new Date())}</div>
        {podzag && <div>{podzag}</div>}
      </div>
      {svodka && <PrintTable cols={svodka.cols} rows={svodka.rows} itogi={svodka.itogi} title={svodka.zagolovok} />}
      <table className="opu-table">
        <thead>
          <tr>{cols.map((c) => <th key={c.key} className={c.money || c.num ? 'num' : ''}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>
              {cols.map((c) => (
                <td key={c.key} className={c.money || c.num ? 'num' : ''}>
                  {c.money ? moneyText(r[c.key]) : String(r[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {itogi && (
            <tr className="opu-b">
              {cols.map((c) => (
                <td key={c.key} className={c.money || c.num ? 'num' : ''}>
                  <b>{c.money && typeof itogi[c.key] === 'number' ? moneyText(itogi[c.key]) : String(itogi[c.key] ?? '')}</b>
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
      <div className="print-sheet-foot">{tr('Строк')}: {rows.length}</div>
    </div>
  )
}

// Короткая таблица над основной: сводка, которую читают первой
function PrintTable({ title, cols, rows, itogi }) {
  return (
    <div className="print-svodka">
      {title && <div className="print-svodka-title">{title}</div>}
      <table className="opu-table">
        <thead>
          <tr>{cols.map((c) => <th key={c.key} className={c.money || c.num ? 'num' : ''}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>
              {cols.map((c) => <td key={c.key} className={c.money || c.num ? 'num' : ''}>{c.money ? moneyText(r[c.key]) : String(r[c.key] ?? '')}</td>)}
            </tr>
          ))}
          {itogi && (
            <tr className="opu-b">
              {cols.map((c) => (
                <td key={c.key} className={c.money || c.num ? 'num' : ''}>
                  <b>{c.money && typeof itogi[c.key] === 'number' ? moneyText(itogi[c.key]) : String(itogi[c.key] ?? '')}</b>
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const moneyText = (v) => (typeof v === 'number' ? v.toLocaleString('ru-RU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) : String(v ?? ''))
