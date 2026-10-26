import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getUser, useAuth } from '../db/auth'
import { fmtDateTime } from '../lib/time'
import { translate as tr } from '../lib/i18n'
import { activeDoc, cssString, printTitle } from '../lib/pechat'

// ── Печатный слой ──
// Всё, что идёт на бумагу, рисуется сюда — в отдельный блок прямо в <body>, рядом со
// страницей, а не внутри неё. При печати страница убирается целиком, и на бумагу идёт
// только этот слой. Раньше лист раздела печатался поверх невидимой страницы, а та
// всё равно занимала место — и в конце выходили пустые листы.
//
// Документов в слое бывает несколько: лист раздела и открытое поверх него окно (чек,
// этикетки). Печатается один — с бóльшим prio (окна: 2, листы разделов: 1), из равных —
// открытый последним (index.css, «Печатный слой»; то же правило — lib/pechat.js,
// activeDoc). На экране слоя не видно вовсе.
let root = null
export function printRoot() {
  if (typeof document === 'undefined') return null
  if (!root || !root.isConnected) {
    root = document.querySelector('body > .print-root')
    if (!root) {
      root = document.createElement('div')
      root.className = 'print-root'
      document.body.appendChild(root)
    }
  }
  return root
}

// kind — вид документа: sheet (лист раздела), opu, ticket (чек), labels (этикетки),
// sticker (наклейки на принтере этикеток — страница размера наклейки, components/Nakleyka.jsx).
// От вида зависят поля страницы и номера страниц.
// title — название документа: экран печати пишет его в заголовке и в имени PDF
export default function PrintDoc({ prio = 1, kind = 'sheet', title = '', children }) {
  const host = printRoot()
  if (!host) return null
  return createPortal(
    <div className={'print-doc pd-' + kind} data-prio={prio} data-title={title}>
      {children}
    </div>,
    host,
  )
}

// ── Шапка печатного листа ──
// Как у «Отчёта о прибылях и убытках»: тёмно-синяя полоса — магазин, название листа
// крупно, ниже дата и подробности. Эмблемы программы нет: лист — бумага магазина.
// Цвета заданы прямо: на бумаге они одинаковы при любой теме программы
export function PrintHead({ title, sub }) {
  const apt = getUser()?.pharmacy?.name || ''
  return (
    <div className="pd-band">
      <div className="pd-band-text">
        {apt && <div className="pd-band-shop">{apt}</div>}
        <div className="pd-band-title">{title}</div>
        <div className="pd-band-sub">
          {fmtDateTime(new Date())}
          {sub ? ` · ${sub}` : ''}
        </div>
      </div>
    </div>
  )
}

// Подпись внизу листа: сколько строк и когда напечатано (номера страниц — в поле листа)
export function PrintFoot({ count }) {
  return (
    <div className="pd-foot">
      {count !== undefined && count !== null ? `${tr('Строк')}: ${count} · ` : ''}
      {tr('Напечатано')}: {fmtDateTime(new Date())}
    </div>
  )
}

// ── Поля страницы и номера страниц ──
// Номер «стр. 1 из 3» и название магазина печатаются в нижнем поле каждого листа: бумага
// магазина несёт его имя, а не имя программы (у владельца сервиса, вне магазина, —
// «FinMax POS»). Слова переводятся вместе с интерфейсом, поэтому правила страницы
// собираются здесь, а не лежат готовыми в index.css. Чек, этикетки и наклейка — со своими
// полями и без номеров. Пустое верхнее поле задано намеренно: так браузер не печатает
// поверх листа свои колонтитулы — дату и заголовок вкладки (нижние он и так уступает
// номерам страниц)
export function PrintPageStyle() {
  const pharmacy = useAuth()?.pharmacy
  const shop = String(pharmacy?.name || '').trim()
  // Имя программы — только вне магазина (у владельца сервиса); у магазина без названия — пусто
  const foot = pharmacy ? shop : 'FinMax POS'

  // На время печати заголовок страницы — «документ — магазин»: из него браузер предлагает
  // имя PDF и пишет его в свойства файла (Ctrl+P тоже сюда). После печати — прежний
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let saved = null
    const before = () => {
      const want = printTitle(activeDoc(printRoot())?.getAttribute('data-title') || '', shop)
      if (!want || saved !== null) return
      saved = document.title
      document.title = want
    }
    const after = () => {
      if (saved === null) return
      document.title = saved
      saved = null
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
      after()
    }
  }, [shop])

  const host = printRoot()
  if (!host) return null
  const words = `"${tr('стр.')} " counter(page) " ${tr('из')} " counter(pages)`
  // Фон страницы — белый явно: иначе программа залила бы поля листа фоном своего окна
  const css = `
@page { margin: 12mm 11mm 14mm; background: #fff;
  @top-center { content: ""; }
  @bottom-left { content: ${cssString(foot)}; font: 600 8.5pt Inter, Arial, sans-serif; color: #4a5576; }
  @bottom-right { content: ${words}; font: 8.5pt Inter, Arial, sans-serif; color: #4a5576; } }
@page ticket { margin: 6mm 5mm; background: #fff; @top-center { content: "" } @bottom-left { content: "" } @bottom-right { content: "" } }
@page labels { margin: 8mm; background: #fff; @top-center { content: "" } @bottom-left { content: "" } @bottom-right { content: "" } }
@page sticker { margin: 0; background: #fff; @top-center { content: "" } @bottom-left { content: "" } @bottom-right { content: "" } }
`
  return createPortal(<style className="pd-page-style">{css}</style>, host)
}
