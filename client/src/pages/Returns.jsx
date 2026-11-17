import { useState, useMemo, useCallback, useLayoutEffect, useRef } from 'react'
import { LuUndo2, LuSearch, LuTriangleAlert, LuCircleCheck, LuPrinter } from 'react-icons/lu'
import Layout from '../components/Layout'
import StickyBar, { useTelefon } from '../components/StickyBar'
import { Modal, useToast, PayBadge } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter, periodText } from '../components/JournalFilter'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { useCollection, money } from '../db/store'
import { returnGoods } from '../db/ops'
import { fmtDateTime, dayKey, chekNomer } from '../lib/time'
import { useT } from '../lib/i18n'
import KameraKnopka from '../components/KameraKnopka'
import { poiskZapros, kodyPodhodyat, shtrihkodyPoId } from '../lib/poisk'
import { useCategories, needsExpiry } from '../lib/categories'
import NumberInput from '../components/NumberInput'
import VesInput from '../components/VesInput'
import { uppOf, lineUnits as soldUnits, isVesovoy, kgText, edinica, vozvratSumma } from '../lib/units'
import { returnTicket } from '../lib/ticket'
import { isOtmena } from '../lib/otmena'
import TicketView from '../components/TicketView'
import PrintDoc from '../components/PrintDoc'
import { pechatTicket } from '../lib/pechat'
import { getRekvizity } from '../lib/rekvizity'
import { useAuth, useCan, getUser } from '../db/auth'
import { useModul } from '../lib/useModul'

// Чем вернули деньги — подписи те же, что в форме возврата
const REFUND = { cash: 'Наличными из кассы', card: 'Возврат на карту', transfer: 'Возврат переводом', debt: 'Уменьшить долг клиента' }
// Сколько последних чеков показывать на телефоне, пока поиск пуст. Карточка чека высокая
// (около 215 px): из сорока чеков список выходил на дюжину экранов, и до «Истории возвратов»
// приходилось долго листать. Остальные — по кнопке «Показать все» или поиском
const KOROTKO = 5

// ── Возврат товара ──
// Кассир находит чек, отмечает что и сколько возвращают и решает по каждой позиции:
// вернуть в продажу (упаковка целая) или списать (вскрытая).
//
// Товару, который возвращается в продажу, нужен срок годности: без него он выпал бы
// из контроля сроков. Из какой партии была продана пачка, программа не знает, поэтому
// сама ставит самый ранний из возможных сроков. Точный срок напечатан на коробке — её
// кассир держит в руках и может вписать его в поле «Срок на упаковке».

export default function Returns() {
  const can = useCan()
  // Модуль «Срок годности» выключен у магазина — срок с упаковки не спрашиваем
  const srokOn = useModul('expiry')
  const sales = useCollection('sales')
  // Журнал возвратов общий со сменой и отчётами: там от него зависят деньги в кассе
  const returns = useCollection('returns')
  const products = useCollection('products')
  const categories = useCategories()
  // Отдельный срез для истории: со своим поиском и периодом
  // Поиск в истории и чека — по товару, кассиру или штрихкоду товара (в том числе сканером)
  const kodPoId = useMemo(() => shtrihkodyPoId(products), [products])
  const journal = useJournalFilter('returns', {
    textOf: (r) => (r.items || []).map((i) => i.name).join(' ') + ' ' + (r.user?.name || ''),
    codesOf: (r) => (r.items || []).map((i) => kodPoId.get(i.productId)),
  })
  const t = useT()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [sale, setSale] = useState(null) // выбранный чек
  const [lines, setLines] = useState([]) // {productId, name, max, units, restock}
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null)
  const [refund, setRefund] = useState('cash') // чем возвращаем деньги
  const [refundVia, setRefundVia] = useState('') // через какой сервис, если переводом
  const payServices = useCollection('payServices')
  const [failed, setFailed] = useState(null) // возврат не записался на сервер
  // Телефон (окно до 600 px): своя разметка в нескольких местах — ниже у каждого сказано, где.
  // На компьютере и в программе всё как было
  const phone = useTelefon()
  const [vse, setVse] = useState(false) // на телефоне: показать все найденные чеки, а не пять

  // Последние продажи для поиска чека
  const found = useMemo(() => {
    const list = sales.filter((s) => s && Array.isArray(s.items))
    const z = poiskZapros(q)
    if (!z) return list.slice(0, 40)
    return list
      .filter(
        (s) =>
          s.items.some((i) => (i.name || '').toLowerCase().includes(z.text)) ||
          money(s.total).includes(z.text) ||
          kodyPodhodyat(z, s.items.map((i) => kodPoId.get(i.productId))),
      )
      .slice(0, 40)
  }, [sales, q, kodPoId])
  const korotko = phone && !q.trim() && !vse && found.length > KOROTKO
  const shown = korotko ? found.slice(0, KOROTKO) : found

  // Что по чеку уже вернули: отменён ли он, на какую сумму вернули, сколько штук каждого товара.
  // На телефоне это пометка в карточке чека: по чеку, где всё уже вернули, «Выбрать» открывало
  // позиции с нулями и неактивной кнопкой — лишнее нажатие, и непонятно почему
  const vozvratyChekov = useMemo(() => {
    const map = new Map()
    for (const r of returns) {
      if (!r || !r.saleId) continue
      const x = map.get(r.saleId) || { otmena: false, sum: 0, units: {} }
      if (isOtmena(r)) x.otmena = true
      else x.sum += Number(r.total) || 0
      for (const i of r.items || []) x.units[i.productId] = (x.units[i.productId] || 0) + (i.units || 0)
      map.set(r.saleId, x)
    }
    return map
  }, [returns])
  // Пометка чека: { text, color, nechego } — nechego: возвращать по чеку больше нечего
  const pometka = (s) => {
    const x = vozvratyChekov.get(s.id)
    if (!x) return null
    if (x.otmena) return { text: t('Отменён'), color: 'var(--danger)', nechego: true }
    // Тот же счёт, что при выборе чека (pickSale): продано минус уже возвращённое
    const ostalos = s.items.some((i) => i.productId && soldUnits(i) - (x.units[i.productId] || 0) > 0)
    if (!ostalos) return { text: t('Возвращён полностью'), color: 'var(--warn)', nechego: true }
    return x.sum > 0 ? { text: `${t('Возврат')} ${money(x.sum)}`, color: 'var(--warn)', nechego: false } : null
  }

  // На телефоне после «Выбрать» форма встаёт на место списка, а экран оставался прокрученным
  // вниз: «Что возвращают» уходило выше экрана, и казалось, что кнопка не сработала. Поднимаем
  // форму к верху экрана — до отрисовки, без рывка. Отступ сверху — scroll-margin (m-smena.css)
  const formRef = useRef(null)
  const saleId = sale?.id
  useLayoutEffect(() => {
    const el = formRef.current
    if (!phone || !saleId || !el) return
    if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' })
  }, [phone, saleId])
  // Подсветка тура на телефоне — только у первой позиции чека: позиции стоят разными
  // карточками, и общая рамка вокруг всех перечёркивала их полосой
  const tourFirst = (key, n) => (!phone || n === 0 ? key : undefined)

  // Сколько уже возвращено по конкретному чеку — больше него отдать нельзя.
  // Считаем по переданному чеку, а не по выбранному в state: на момент выбора
  // state ещё старый, и максимум получался от предыдущего чека (а на первом —
  // вообще без учёта прошлых возвратов, из-за чего сервер отклонял возврат).
  const returnedFor = useCallback(
    (saleId) => {
      const map = {}
      returns
        .filter((r) => r.saleId === saleId)
        .forEach((r) => r.items.forEach((i) => { map[i.productId] = (map[i.productId] || 0) + i.units }))
      return map
    },
    [returns],
  )

  function pickSale(s) {
    const already = returnedFor(s.id)
    setSale(s)
    // По умолчанию возвращаем тем же способом, каким платили
    setRefund(s.payment === 'debt' && !s.customerId ? 'cash' : s.payment)
    setRefundVia(s.payVia || '')
    setLines(
      s.items.map((i, n) => ({
        // Товар могли удалить из базы уже после продажи: в чеке остаётся только
        // название, а ссылки на товар нет. Вернуть такую позицию некуда — склад
        // её не примет. Помечаем и не даём выбрать количество, остальные позиции
        // чека при этом возвращаются как обычно.
        key: i.productId || 'gone_' + n,
        productId: i.productId || null,
        deleted: !i.productId,
        name: i.name,
        unitsPerPack: uppOf(i),
        // Весовой товар возвращается в килограммах (внутри — граммы)
        ves: isVesovoy(products.find((p) => p.id === i.productId) || i),
        unit: (products.find((p) => p.id === i.productId) || i).unit || '',
        max: i.productId ? Math.max(0, soldUnits(i) - (already[i.productId] || 0)) : 0,
        // Сколько штук уже вернули раньше: сначала возвращаются отдельные штуки по своей цене
        already: i.productId ? already[i.productId] || 0 : 0,
        units: 0,
        restock: true,
        expiry: '', // срок с упаковки, если кассир его вписал
      })),
    )
  }

  const total = useMemo(
    () =>
      lines.reduce((s, l) => {
        const item = sale?.items.find((i) => i.productId === l.productId)
        if (!item || !l.units) return s
        // Единица строки — снимком чека (1.5.12); у прежних строк — из карточки: своя цена
        // весового в мешке — за килограмм, и без единицы её не прочесть
        return s + vozvratSumma({ ...item, unit: item.unit || l.unit }, l.units, l.already)
      }, 0),
    [lines, sale],
  )

  // Уменьшить долг можно не больше, чем клиент должен: иначе он ушёл бы в минус.
  // Сервер такое отклоняет, поэтому предупреждаем сразу и не даём отправить.
  // Нужен ли товару срок годности: у бытовой химии и техники его нет — и спрашивать незачем
  const wantsExpiry = (l) => needsExpiry(products.find((p) => p.id === l.productId)?.category, categories)
  // Срок спрашиваем только у того, что возвращается в продажу
  const asksExpiry = (l) => srokOn && l.restock && l.units > 0 && !l.deleted && wantsExpiry(l)
  const today = dayKey()

  const customerDebt = Number(sale?.customer?.debt || 0)
  const debtShort = refund === 'debt' && total > customerDebt + 0.005
  const canSubmit = lines.some((l) => l.units > 0 && !l.deleted) && !debtShort
  // В чеке не осталось ни одной позиции, которую можно вернуть
  const allGone = lines.length > 0 && lines.every((l) => l.deleted)

  // Сколько денег приходится на каждую возвращаемую позицию — для чека возврата
  function amountOf(l) {
    const item = sale?.items.find((i) => i.productId === l.productId)
    if (!item || !l.units) return 0
    return vozvratSumma({ ...item, unit: item.unit || l.unit }, l.units, l.already)
  }

  function submit() {
    if (saving || !canSubmit) return
    // Товар с истёкшим сроком в продажу не возвращают. Сервер ответил бы тем же —
    // но позже, когда на экране уже «возврат оформлен»
    if (lines.some((l) => asksExpiry(l) && l.expiry && l.expiry < today)) {
      toast(t('Срок на упаковке уже истёк — такой товар в продажу не возвращают. Выберите «Списать».'), 'err')
      return
    }
    setSaving(true)
    const snapshot = { sale, lines, refund } // на случай, если запись не пройдёт
    try {
      // Возврат оформляется мгновенно: товар возвращается на склад, деньги — в журнал.
      // Запись уходит в фоне, покупатель у кассы не ждёт.
      const { ret, synced } = returnGoods({
        saleId: sale.id,
        refund,
        refundVia: refund === 'transfer' ? refundVia || sale.payVia || payServices[0]?.name || '' : '',
        customerId: sale.customerId || sale.customer?.id || null,
        total,
        lines: lines.map((l) => ({
          ...l,
          // Срок уходит только у того, у чего его спрашивали: строку могли сначала
          // заполнить, а потом переключить на «списать»
          expiry: asksExpiry(l) ? l.expiry : '',
          price: sale.items.find((i) => i.productId === l.productId)?.price || 0,
          amount: amountOf(l),
        })),
      })
      setDone(ret)
      setSale(null)
      setLines([])
      toast(t('Возврат оформлен'))
      // Деньги нельзя терять молча: если запись не прошла — показываем окно и возвращаем чек
      synced.catch((e) => setFailed({ message: e.message, ...snapshot }))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  const pg = usePagination(journal.rows, 10, journal.controls.period + journal.controls.q)

  // ── Выгрузка и печать: история возвратов, как она отобрана (период, поиск) ──
  const itemsText = (r) =>
    (r.items || [])
      .map((i) => {
        const prod = products.find((p) => p.id === i.productId)
        const drob = isVesovoy({ unit: i.unit }) || isVesovoy(prod)
        return `${i.name} ×${drob ? `${kgText(i.units)} ${t(isVesovoy({ unit: i.unit }) ? i.unit : edinica(prod))}` : i.units}`
      })
      .join(', ') + ((r.items || []).some((i) => !i.restock) ? ` (${t('часть списана')})` : '') + (isOtmena(r) ? ` (${t('Отмена чека')})` : '')
  const exCols = [
    { header: t('Дата'), key: 'date', width: 18 },
    { header: t('Товары'), key: 'items', width: 46, wrap: true },
    { header: t('Чем вернули'), key: 'refund', width: 22 },
    { header: t('Кассир'), key: 'who', width: 14 },
    { header: t('Возвращено'), key: 'total', width: 14, money: true },
  ]
  const exRows = journal.rows.map((r) => ({
    date: fmtDateTime(r.date),
    items: itemsText(r),
    refund: t(REFUND[r.refund] || REFUND.cash) + (r.refund === 'transfer' && r.refundVia ? ` · ${r.refundVia}` : ''),
    who: r.user?.name || '',
    total: Number(r.total) || 0,
  }))
  const exItogi = { date: t('Итого'), total: Math.round(exRows.reduce((s, r) => s + r.total, 0) * 100) / 100 }
  const exPodzag = [
    `${t('Период')}: ${periodText(journal.controls)}`,
    journal.controls.q.trim() ? `${t('Поиск')}: «${journal.controls.q.trim()}»` : '',
    `${t('Записей')}: ${journal.rows.length}`,
  ].filter(Boolean).join(' · ')
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Возвраты'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Возвраты')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout title={t('Возврат товара')} subtitle={t('Возврат денег покупателю по чеку')} actions={<ExportPechat onExcel={exportExcel} />}>
      {/* Пока открыт чек возврата, на бумагу идёт он, а не история */}
      {!done && <PrintSheet zagolovok={t('Возвраты')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />}

      {!sale ? (
        // Полоса поиска чека держится, пока виден список найденных чеков: ниже — история
        // возвратов со своей полосой, и две полосы наехали бы друг на друга
        <div className="stick-scope">
          <StickyBar>
            <div className="toolbar">
              <div className="search kamera-pole">
                <input
                  data-tour="ret.search"
                  // На телефоне подсказка короче: длинная обрезалась на «…штрихко», и не было
                  // видно главного — что чек ищется и по сумме
                  placeholder={phone ? t('Товар, штрихкод, сумма…') : t('Поиск чека: товар, штрихкод или сумма…')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <KameraKnopka onCode={setQ} testid="kamera-vozvrat" />
              </div>
            </div>
          </StickyBar>
          <div className="panel" style={{ padding: 0 }}>
            {/* На телефоне чеки — карточками (index.css, .table-cards): вбок ничего не листается */}
            <div className="table-cards-wrap">
            <table className="table-cards ret-found">
              <thead>
                <tr><th>{t('Время')}</th><th>{t('Товары')}</th><th className="num">{t('Сумма')}</th><th>{t('Оплата')}</th><th></th></tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const tovary = s.items.map((i) => i.name).join(', ')
                  // На телефоне — пометка, если по чеку уже возвращали; вернуть нечего — не «Выбрать»
                  const pm = phone ? pometka(s) : null
                  return (
                    <tr key={s.id}>
                      <td data-label={t('Время')}>{fmtDateTime(s.date)}</td>
                      {/* На телефоне товары — заголовок карточки, и места хватает на все названия:
                          обрезка на полуслове («Бинт сте») бросалась в глаза */}
                      <td className="cell-main">
                        {phone ? tovary : tovary.slice(0, 50)}
                        {pm && <div className="tag-cat" style={{ color: pm.color }}>{pm.text}</div>}
                      </td>
                      <td className="num" data-label={t('Сумма')}><b>{money(s.total)}</b></td>
                      <td data-label={t('Оплата')}><PayBadge type={s.payment} /></td>
                      <td className="num cell-actions">
                        {can('returns.create') && !pm?.nechego && (
                          <button className="btn ghost sm" data-tour="ret.pick" onClick={() => pickSale(s)}>
                            <LuSearch size={14} /> {t('Выбрать')}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {found.length === 0 && <tr><td colSpan="5" className="empty">{t('Чеки не найдены')}</td></tr>}
              </tbody>
            </table>
            {korotko && (
              <button type="button" className="btn ghost ret-more" data-testid="ret-more" onClick={() => setVse(true)}>
                {t('Показать все')} ({found.length})
              </button>
            )}
            </div>
          </div>
        </div>
      ) : (
        <div className="panel ret-sale" ref={formRef} style={{ maxWidth: 900 }}>
          <h2>
            <span className="h2-title"><span className="ic"><LuUndo2 size={17} /></span>{t('Что возвращают')}</span>
            <span className="tag-cat">{fmtDateTime(sale.date)} · {money(sale.total)}</span>
          </h2>
          {/* На телефоне позиции — карточками: название, сколько продано, поле «Вернуть» и выбор
              «Что с товаром» во всю ширину карточки (styles/m-smena.css, .ret-lines) */}
          <table className="table-cards ret-lines">
            <thead>
              <tr>
                <th>{t('Товар')}</th>
                <th className="num">{t('Продано, шт')}</th>
                <th style={{ width: 130 }}>{t('Вернуть, шт')}</th>
                <th style={{ width: 190 }}>{t('Что с товаром')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, n) => (
                <tr key={l.key}>
                  <td className="cell-main">
                    <b>{l.name}</b>
                    {l.deleted && <div className="tag-cat" style={{ color: 'var(--warn)' }}>{t('товар удалён из базы')}</div>}
                  </td>
                  {/* Число — сколько ещё можно вернуть (продано минус уже возвращённое). Подпись
                      карточки на телефоне так и говорит; заголовок колонки на компьютере прежний */}
                  <td className="num" data-label={t('Можно вернуть, шт')}>{l.deleted ? '—' : l.ves ? `${kgText(l.max)} ${t(edinica(l))}` : l.max}</td>
                  <td data-label={t('Вернуть, шт')} data-tour={tourFirst('ret.lines', n)}>
                    {l.ves ? (
                      <VesInput
                        className="disc-input"
                        grams={l.units || 0}
                        disabled={l.deleted}
                        placeholder="0"
                        onGrams={(g) => {
                          const v = Math.max(0, Math.min(l.max, g))
                          setLines((ls) => ls.map((x, i) => (i === n ? { ...x, units: v } : x)))
                        }}
                      />
                    ) : (
                      <NumberInput
                        integer className="disc-input"
                        value={l.units || ''}
                        placeholder="0"
                        disabled={l.deleted}
                        title={l.deleted ? t('Этот товар удалён из базы — вернуть его на склад некуда') : undefined}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(l.max, Math.trunc(Number(e.target.value) || 0)))
                          setLines((ls) => ls.map((x, i) => (i === n ? { ...x, units: v } : x)))
                        }}
                      />
                    )}
                  </td>
                  <td className="cell-wide" data-label={t('Что с товаром')} data-tour={tourFirst('ret.restock', n)}>
                    {phone ? (
                      // На телефоне — два крупных переключателя вместо списка: в поле шириной в
                      // карточку «Списать (вскрыта/повреждена)» обрезалось, а по-таджикски — и
                      // «Вернуть в продажу». Надпись переключателя переносится, а не режется
                      <div className="ret-restock" role="radiogroup" aria-label={t('Что с товаром')}>
                        {[[true, t('Вернуть в продажу')], [false, t('Списать (вскрыта/повреждена)')]].map(([v, text]) => (
                          <label key={String(v)} className={'ret-restock-opt' + (l.restock === v ? ' on' : '') + (v ? '' : ' spisat')}>
                            <input
                              type="radio"
                              name={'ret-restock-' + n}
                              checked={l.restock === v}
                              disabled={l.deleted || !l.units}
                              onChange={() => setLines((ls) => ls.map((x, i) => (i === n ? { ...x, restock: v } : x)))}
                            />
                            <span>{text}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <select
                        value={l.restock ? 'stock' : 'off'}
                        disabled={l.deleted || !l.units}
                        onChange={(e) => setLines((ls) => ls.map((x, i) => (i === n ? { ...x, restock: e.target.value === 'stock' } : x)))}
                      >
                        <option value="stock">{t('Вернуть в продажу')}</option>
                        <option value="off">{t('Списать (вскрыта/повреждена)')}</option>
                      </select>
                    )}
                    {asksExpiry(l) && (
                      <div className="ret-expiry" data-tour={!phone || n === lines.findIndex(asksExpiry) ? 'ret.expiry' : undefined}>
                        <label htmlFor={'ret-expiry-' + n}>{t('Срок на упаковке')}</label>
                        <input
                          id={'ret-expiry-' + n}
                          type="date"
                          value={l.expiry}
                          min={today}
                          // Год — не длиннее четырёх цифр: «20266» вместо «2026» — частая опечатка
                          max="9999-12-31"
                          onChange={(e) => setLines((ls) => ls.map((x, i) => (i === n ? { ...x, expiry: e.target.value } : x)))}
                        />
                        <div className="tag-cat">{t('Пусто — программа поставит срок сама')}</div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {allGone && (
            <div className="note err" style={{ marginTop: 14 }}>
              {t('Все товары из этого чека удалены из базы — вернуть по нему нечего.')}
            </div>
          )}

          <div className="total-row big" style={{ marginTop: 16 }}>
            <span>{t('Вернуть покупателю')}</span>
            <span>{money(total)}</span>
          </div>
          <div className="field" data-tour="ret.refund" style={{ maxWidth: 340, marginTop: 14 }}>
            <label>{t('Чем возвращаем деньги')}</label>
            <select value={refund} onChange={(e) => setRefund(e.target.value)}>
              <option value="cash">{t('Наличными из кассы')}</option>
              <option value="card">{t('Возврат на карту')}</option>
              <option value="transfer">{t('Возврат переводом')}</option>
              {sale.customerId && <option value="debt">{t('Уменьшить долг клиента')}</option>}
            </select>
          </div>
          {refund === 'transfer' && (
            <div className="field" style={{ maxWidth: 340 }}>
              <label>{t('Через какой сервис')}</label>
              <select value={refundVia || sale.payVia || payServices[0]?.name || ''} onChange={(e) => setRefundVia(e.target.value)}>
                {[...new Set([sale.payVia, ...payServices.map((s) => s.name)].filter(Boolean))].map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          )}

          <div className={'note ' + (debtShort ? 'err' : 'info')} style={{ marginTop: 8 }}>
            {refund === 'debt'
              ? debtShort
                ? `${t('Долг клиента')} ${money(customerDebt)} — ${t('это меньше суммы возврата. Верните деньги наличными или картой.')}`
                : `${t('Долг клиента уменьшится на')} ${money(total)}. ${t('Наличные не выдаются.')}`
              : refund === 'transfer'
                ? t('Деньги вернутся покупателю переводом — из кассы ничего не выдаётся.')
                // Возврат на карту наличные смены не трогает (Shift.jsx: refundCash — только
                // 'cash'). Прежде здесь стояла подпись про кассу, и кассир мог выдать наличные
                : refund === 'card'
                  ? t('Деньги вернутся покупателю на карту — из кассы ничего не выдаётся.')
                  : t('Деньги возвращаются покупателю из кассы — эта сумма учтётся при закрытии смены.')}
          </div>

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => { setSale(null); setLines([]) }} disabled={saving}>{t('Отмена')}</button>
            <button className="btn danger" data-tour="ret.submit" onClick={submit} disabled={!canSubmit || saving}>
              <span className="ic"><LuUndo2 size={16} /></span> {saving ? t('Оформляем…') : t('Оформить возврат')}
            </button>
          </div>
        </div>
      )}

      <div className="panel mt" data-tour="ret.history" style={{ padding: 0 }}>
        <h2 style={{ padding: '16px 16px 0' }}>
          <span className="h2-title"><span className="ic"><LuUndo2 size={17} /></span>{t('История возвратов')}</span>
        </h2>
        {/* На телефоне подсказка короче: «Товар, штрихкод или ка…» обрезалась; штрихкод
            ищется и так — рядом кнопка камеры */}
        <JournalFilter controls={journal.controls} placeholder={phone ? t('Товар или кассир…') : t('Товар, штрихкод или кассир…')} kamera="kamera-vozvrat-zhurnal" />
        <div style={{ padding: '0 16px' }}>
          <JournalCount rows={journal.rows.length} loading={journal.loading} />
        </div>
        {/* Своя прокрутка вбок: на телефоне панель её не даёт — иначе полоса поиска не держалась бы.
            На телефоне строки — карточками, и листать вбок уже нечего */}
        <div className="table-scroll table-cards-wrap">
        <table className="table-cards ret-history">
          <thead>
            <tr><th>{t('Дата')}</th><th>{t('Товары')}</th><th>{t('Кассир')}</th><th className="num">{t('Возвращено')}</th></tr>
          </thead>
          <tbody>
            {pg.slice.map((r) => (
              <tr key={r.id}>
                <td data-label={t('Дата')}>{fmtDateTime(r.date)}</td>
                <td className="cell-main">
                  {/* На телефоне — все товары: это заголовок карточки, места хватает */}
                  {r.items
                    .map((i) => {
                      const prod = products.find((p) => p.id === i.productId)
                      const drob = isVesovoy({ unit: i.unit }) || isVesovoy(prod)
                      return `${i.name} ×${drob ? `${kgText(i.units)} ${t(isVesovoy({ unit: i.unit }) ? i.unit : edinica(prod))}` : i.units}`
                    })
                    .join(', ')
                    .slice(0, phone ? undefined : 60)}
                  {r.items.some((i) => !i.restock) && (
                    <div className="tag-cat" style={{ color: 'var(--warn)' }}>{t('часть списана')}</div>
                  )}
                  {/* Отмена только что проведённой продажи кнопкой «Отмена» в окне чека */}
                  {isOtmena(r) && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('Отмена чека')}</div>}
                </td>
                <td data-label={t('Кассир')}>{r.user?.name || '—'}</td>
                <td className="num" data-label={t('Возвращено')}><b>{money(r.total)}</b></td>
              </tr>
            ))}
            {journal.rows.length === 0 && !journal.loading && (
              <tr><td colSpan="4" className="empty">{returns.length ? t('За выбранный период ничего не найдено') : t('Возвратов ещё не было')}</td></tr>
            )}
          </tbody>
        </table>
        </div>
        <Pagination {...pg} />
      </div>

      {failed && (
        <Modal
          title={<><span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>{t('Возврат не записан')}</>}
          onClose={() => setFailed(null)}
        >
          <div className="note err" style={{ marginBottom: 12 }}>{failed.message}</div>
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
            {t('Товар снят со склада обратно, деньги в журнал не попали. Проверьте связь и оформите возврат заново.')}
          </p>
          <div className="modal-actions">
            <button
              className="btn"
              onClick={() => {
                setSale(failed.sale)
                setLines(failed.lines)
                setRefund(failed.refund)
                setDone(null)
                setFailed(null)
              }}
            >
              {t('Вернуть чек на экран')}
            </button>
          </div>
        </Modal>
      )}

      {done && <ReturnReceipt ret={done} sales={sales} onClose={() => setDone(null)} />}
    </Layout>
  )
}
// ── Чек возврата ──
// Покупателю на руки: что вернули, сколько денег и как. Собирается в общий вид
// чека (lib/ticket.js) — экран, лента, окно печати и PDF совпадают строка в строку
function ReturnReceipt({ ret, sales, onClose }) {
  const t = useT()
  const auth = useAuth()
  const toast = useToast()
  const print = (tk) => pechatTicket(tk).catch((e) => toast(t(e.message), 'err'))
  // Номер чека продажи, по которому оформлен возврат, — чтобы их сверять друг с другом
  const saleDate = sales.find((s) => s.id === ret.saleId)?.date
  const ticket = returnTicket(ret, {
    t,
    money,
    when: fmtDateTime,
    pharmacy: auth?.pharmacy?.name,
    cashier: auth?.name,
    rekvizity: getRekvizity(auth?.pharmacy?.code),
    nomer: chekNomer(ret.date),
    saleNomer: saleDate ? chekNomer(saleDate) : '',
  })
  return (
    // ret-chek-okno — правила для телефона (styles/m-smena.css)
    <Modal className="ret-chek-okno" title={<><span className="ic" style={{ color: 'var(--green)' }}><LuCircleCheck size={18} /></span>{t('Возврат оформлен')}</>} onClose={onClose}>
      <TicketView ticket={ticket} />
      <PrintDoc prio={2} kind="ticket" title={t('Чек возврата')}><TicketView ticket={ticket} /></PrintDoc>
      <div className="modal-actions">
        <button className="btn ghost" onClick={() => print(ticket)}><span className="ic"><LuPrinter size={16} /></span> {t('Печать')}</button>
        <button className="btn" onClick={onClose}>{t('Готово')}</button>
      </div>
    </Modal>
  )
}
