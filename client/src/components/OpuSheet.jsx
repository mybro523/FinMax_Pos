import { getUser } from '../db/auth'
import PrintDoc from './PrintDoc'
import { useT } from '../lib/i18n'
import { opuSheet } from '../lib/opu'
import { fmtDate, fmtDateTime } from '../lib/time'

// ── Лист «Отчёт о прибылях и убытках» ──
// На экране не виден; при печати раздела «Отчёт ОПУ» — единственное, что уходит на
// бумагу (в обеих вкладках): рисуется в печатном слое (PrintDoc). Форма — как привычный бумажный отчёт владельца: полоса с
// заголовком, «Наименование | Сумма», разделы тёмно-синими полосами, суммы в белых
// клетках, внизу крупно чистый доход и касса. Цвет — тёмно-синий шапки программы; на
// бумаге он печатается как есть, на любой теме программы (см. index.css, .opu-sheet).
//
// d — расчёт opuFinance (lib/opu.js); from/to — границы периода (to — начало дня после
// последнего; пусто — по сегодня)
const OLD = new Date('2000-01-01T00:00:00Z').getTime()

// Сумма без «сомони» в каждой клетке (валюта — в шапке): целые — без копеек
const NF_INT = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const NF_FRAC = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function amount(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100
  const text = (n % 1 ? NF_FRAC : NF_INT).format(Math.abs(n))
  return n < 0 ? '−' + text : text
}

export default function OpuSheet({ d, from, to }) {
  const t = useT()
  const apt = getUser()?.pharmacy?.name || ''
  const start = from ? new Date(from) : null
  const end = to ? new Date(new Date(to).getTime() - 1) : new Date()
  const period = !start || start.getTime() < OLD ? t('за всё время') : `${fmtDate(start)} — ${fmtDate(end)}`
  return (
    <PrintDoc prio={1} kind="opu" title={t('Отчёт о прибылях и убытках')}>
    <div className="opu-sheet" data-testid="opu-sheet">
      <div className="opu-sheet-page">
        <div className="opu-sheet-title">
          <div className="opu-sheet-h">{t('Отчёт о прибылях и убытках')}</div>
          <div className="opu-sheet-sub">
            {apt ? `${apt} · ` : ''}
            {period}
          </div>
        </div>
        <table className="opu-sheet-table">
          <thead>
            <tr>
              <th>{t('Наименование')}</th>
              <th>
                {t('Сумма')}, {t('сомони')}
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Классы строк — со своей приставкой: «row» в программе уже занят общей
                раскладкой (display: flex) и разломал бы строку таблицы */}
            {opuSheet(d).map((r, n) => {
              if (r.kind === 'gap') return <tr key={n} className="opu-r-gap"><td colSpan={2} /></tr>
              if (r.kind === 'section') return <tr key={n} className="opu-r-section"><td colSpan={2}>{t(r.label)}</td></tr>
              return (
                <tr key={n} className={'opu-r-' + r.kind + ((Number(r.value) || 0) < 0 ? ' neg' : '')}>
                  <td>{t(r.label)}</td>
                  <td className="num">{amount(r.value)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="opu-sheet-foot">
          {/* «FinMax POS» и номер страницы — в нижнем поле листа (PrintPageStyle) */}
          {t('Напечатано')}: {fmtDateTime(new Date())}
        </div>
      </div>
    </div>
    </PrintDoc>
  )
}
