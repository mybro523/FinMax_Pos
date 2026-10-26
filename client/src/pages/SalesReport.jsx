import { useMemo, useState } from 'react'
import { LuWallet, LuTrendingUp, LuBoxes, LuReceipt, LuPrinter } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, PAYMENTS, useToast } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import PrintDoc from '../components/PrintDoc'
import TicketView from '../components/TicketView'
import { PeriodPicker, presetPeriod, periodRange, periodText, useDeepPeriod } from '../components/Period'
import { useCollection, money } from '../db/store'
import { getUser, useAuth } from '../db/auth'
import { fmtDateTime, chekNomer } from '../lib/time'
import { useT } from '../lib/i18n'
import { skachatXlsx } from '../lib/excel'
import { prodazhiPoTovaram, vseProdazhi, spisokChekov, chekPodhodit } from '../lib/otchety'
import { poiskZapros, tovarPodhodit, shtrihkodyPoId } from '../lib/poisk'
import { isOtmena, otmenennyeCheki } from '../lib/otmena'
import { sEdinicami } from '../lib/units'
import { saleTicket } from '../lib/ticket'
import { getRekvizity } from '../lib/rekvizity'
import { pechatTicket } from '../lib/pechat'

// ── Отчёт продажи ──
// Три вкладки. «По товарам» — сколько продано каждого товара, выручка после скидок,
// себестоимость и прибыль: видно, что кормит магазин, а что лежит. «Все продажи» —
// каждая позиция каждого чека: когда, кто продал, что, сколько, скидка и оплата.
// «Чеки» — чек одной строкой; по клику — сам чек, как на бумаге, с кнопкой «Печать»
// (напечатать заново, хоть вчерашний). Карточка «Чеков» тоже открывает эту вкладку.
// Кассир выбирается во всех вкладках: «По товарам» тогда считает только его продажи
// (что продаёт этот сотрудник). Карточки сверху — всегда по всем. Поиск — по названию
// и по штрихкоду, в том числе сканером, а в «Чеках» — ещё по номеру чека и клиенту.
// Чек, отменённый кнопкой «Отмена» в кассе (lib/otmena.js), продажей не считается:
// в «Чеках» он виден с отметкой «Отменён», в остальном отчёте его нет.
// Расчёты — в lib/otchety.js; Excel и печать берут те же строки, что на экране.

const VKLADKA = 'apteka_otchet_prodazh_vkladka'
const payLabel = (p, t) => t(PAYMENTS[p]?.label || 'Наличные')

export default function SalesReport() {
  const t = useT()
  const salesCached = useCollection('sales')
  const products = useCollection('products')
  const [tab, setTabRaw] = useState(() => {
    try {
      const v = localStorage.getItem(VKLADKA)
      return v === 'all' || v === 'cheki' ? v : 'products'
    } catch {
      return 'products'
    }
  })
  const setTab = (v) => {
    setTabRaw(v)
    try {
      localStorage.setItem(VKLADKA, v)
    } catch {
      /* приватный режим */
    }
  }
  const [period, setPeriod] = useState(() => presetPeriod('month'))
  const range = useMemo(() => periodRange(period), [period])
  const { deep, loading } = useDeepPeriod(['sales'], range)
  const sales = deep.sales || salesCached
  // Возвраты — по сегодняшний день: вернуть по чеку могут и после конца периода
  const returnsCached = useCollection('returns')
  const { deep: deepR } = useDeepPeriod(['returns'], range, { untilNow: true })
  const returns = deepR.returns || returnsCached
  // Чеки, отменённые в кассе кнопкой «Отмена», продажами не считаются
  const otmenennye = useMemo(() => otmenennyeCheki(returns), [returns])
  const salesZhivye = useMemo(() => sales.filter((s) => !otmenennye.has(s.id)), [sales, otmenennye])

  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [cashier, setCashier] = useState('')
  const [pay, setPay] = useState('')

  const poTov = useMemo(() => prodazhiPoTovaram({ sales: salesZhivye, products, from: range.from, to: range.to, t }), [salesZhivye, products, range, t])
  const vse = useMemo(() => vseProdazhi({ sales: salesZhivye, products, from: range.from, to: range.to, t }), [salesZhivye, products, range, t])
  // «По товарам» у одного кассира — та же сводка, только по его чекам
  const poTovKassira = useMemo(
    () => (cashier ? prodazhiPoTovaram({ sales: salesZhivye.filter((s) => (s.user?.name || '') === cashier), products, from: range.from, to: range.to, t }) : poTov),
    [cashier, salesZhivye, products, range, t, poTov],
  )
  // «Чеки» — все чеки периода, и отменённые тоже (с отметкой, без итогов)
  const cheki = useMemo(() => spisokChekov({ sales, returns, from: range.from, to: range.to }), [sales, returns, range])
  const kody = useMemo(() => shtrihkodyPoId(products), [products])
  const [otkryt, setOtkryt] = useState(null) // чек, открытый в окне

  const z = useMemo(() => poiskZapros(q), [q])
  const tovRows = useMemo(
    () => poTovKassira.rows.filter((r) => tovarPodhodit(z, r.name, r.barcode) && (!cat || r.category === cat)),
    [poTovKassira.rows, z, cat],
  )
  const vseRows = useMemo(
    () =>
      vse.rows.filter(
        (r) =>
          tovarPodhodit(z, r.name, r.barcode) &&
          (!cashier || r.cashier === cashier) &&
          (!pay || r.payment === pay),
      ),
    [vse.rows, z, cashier, pay],
  )
  const chekRows = useMemo(
    () =>
      cheki.rows.filter(
        (r) =>
          chekPodhodit(z, r, chekNomer(r.date), kody) &&
          (!cashier || r.cashier === cashier) &&
          (!pay || r.payment === pay),
      ),
    [cheki.rows, z, kody, cashier, pay],
  )
  const reset = `${tab}|${q.trim()}|${cat}|${cashier}|${pay}|${period.from}|${period.to}`
  const pgT = usePagination(tovRows, 20, reset)
  const pgV = usePagination(vseRows, 20, reset)
  const pgC = usePagination(chekRows, 20, reset)

  const categories = useMemo(() => [...new Set(poTov.rows.map((r) => r.category).filter(Boolean))].sort(), [poTov.rows])
  // Кассиры — по всем чекам периода, и по отменённым тоже
  const cashiers = useMemo(() => [...new Set(cheki.rows.map((r) => r.cashier).filter(Boolean))].sort(), [cheki.rows])

  const sum = (rows, k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100
  const tovItogo = { revenue: sum(tovRows, 'revenue'), cost: sum(tovRows, 'cost'), profit: sum(tovRows, 'profit') }
  const vseItogo = { sum: sum(vseRows, 'sum'), discount: sum(vseRows, 'discount') }
  // Итог чеков — без отменённых: продажи не было
  const chekiZhivye = chekRows.filter((r) => !r.otmena)
  const chekItogo = { cheki: chekiZhivye.length, sum: sum(chekiZhivye, 'total') }
  const chekMark = (r) => (r.otmena ? t('Отменён') : r.vozvrat > 0 ? `${t('Возврат')} ${money(r.vozvrat)}` : '')

  // ── Excel и печать: активная вкладка, с учётом фильтров ──
  // Выбран кассир — он виден и в подзаголовке листа: иначе цифры выглядели бы общими
  const podzag = periodText(period, t) + (cashier ? ` · ${t('Кассир')}: ${cashier}` : '')
  const ex =
    tab === 'cheki'
      ? {
          fayl: t('Чеки'),
          title: t('Чеки'),
          cols: [
            { header: t('Чек'), key: 'chek', width: 13 },
            { header: t('Дата'), key: 'date', width: 17 },
            { header: t('Кассир'), key: 'cashier', width: 14 },
            { header: t('Оплата'), key: 'pay', width: 16 },
            { header: t('Клиент'), key: 'customer', width: 18 },
            { header: t('Позиций'), key: 'positions', width: 9, num: true },
            { header: t('Сумма'), key: 'total', width: 13, money: true },
            { header: t('Отметка'), key: 'mark', width: 20 },
          ],
          rows: chekRows.map((r) => ({
            chek: chekNomer(r.date), date: fmtDateTime(r.date), cashier: r.cashier || '—',
            pay: payLabel(r.payment, t) + (r.payVia ? ` · ${r.payVia}` : ''), customer: r.customer || '',
            positions: r.positions, total: r.total, mark: chekMark(r),
          })),
          itogi: { chek: t('Итого'), positions: '', total: chekItogo.sum, mark: `${t('Чеков')}: ${chekItogo.cheki}` },
        }
      : tab === 'products'
      ? {
          fayl: t('Продажи по товарам'),
          title: t('Продажи по товарам'),
          cols: [
            { header: t('Товар'), key: 'name', width: 40 },
            { header: t('Категория'), key: 'category', width: 18 },
            { header: t('Продано'), key: 'qty', width: 16 },
            { header: t('Выручка'), key: 'revenue', width: 14, money: true },
            { header: t('Себестоимость'), key: 'cost', width: 14, money: true },
            { header: t('Прибыль'), key: 'profit', width: 14, money: true },
            { header: t('Маржа, %'), key: 'margin', width: 10, num: true },
          ],
          rows: tovRows.map((r) => ({ name: r.name, category: r.category ? t(r.category) : '—', qty: r.qty, revenue: r.revenue, cost: r.cost, profit: r.profit, margin: r.margin })),
          itogi: { name: t('Итого'), revenue: tovItogo.revenue, cost: tovItogo.cost, profit: tovItogo.profit },
        }
      : {
          fayl: t('Все продажи'),
          title: t('Все продажи'),
          cols: [
            { header: t('Дата'), key: 'date', width: 17 },
            { header: t('Чек'), key: 'chek', width: 13 },
            { header: t('Кассир'), key: 'cashier', width: 14 },
            { header: t('Товар'), key: 'name', width: 36 },
            { header: t('Кол-во'), key: 'qty', width: 14 },
            { header: t('Цена'), key: 'price', width: 12, money: true },
            { header: t('Скидка'), key: 'discount', width: 11, money: true },
            { header: t('Сумма'), key: 'sum', width: 13, money: true },
            { header: t('Оплата'), key: 'pay', width: 14 },
          ],
          rows: vseRows.map((r) => ({
            date: fmtDateTime(r.date), chek: chekNomer(r.date), cashier: r.cashier || '—', name: r.name, qty: r.qty,
            price: r.price, discount: r.discount, sum: r.sum, pay: payLabel(r.payment, t) + (r.payVia ? ` · ${r.payVia}` : ''),
          })),
          itogi: { date: t('Итого'), discount: vseItogo.discount, sum: vseItogo.sum },
        }
  const exportExcel = () =>
    skachatXlsx({ fayl: ex.fayl, zagolovok: `${getUser()?.pharmacy?.name || ''} — ${ex.title}`, podzag, cols: ex.cols, rows: ex.rows, itogi: ex.itogi })

  return (
    <Layout title={t('Отчёт продажи')} subtitle={podzag} actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={ex.title} podzag={podzag} cols={ex.cols} rows={ex.rows} itogi={ex.itogi} />

      <div className="chips" data-tour="sr.tabs" style={{ marginBottom: 14 }}>
        <button className={'chip ' + (tab === 'products' ? 'active' : '')} data-tour="sr.tab-products" onClick={() => setTab('products')}>{t('По товарам')}</button>
        <button className={'chip ' + (tab === 'all' ? 'active' : '')} data-tour="sr.tab-all" onClick={() => setTab('all')}>{t('Все продажи')}</button>
        <button className={'chip ' + (tab === 'cheki' ? 'active' : '')} data-tour="sr.tab-cheki" data-testid="sr-tab-cheki" onClick={() => setTab('cheki')}>{t('Чеки')}</button>
      </div>

      <PeriodPicker value={period} onChange={setPeriod} tour="sr.period" />

      <div className="cards" data-tour="sr.cards" style={{ margin: '14px 0 16px' }}>
        <Metric label={t('Выручка')} value={money(poTov.itogo.revenue)} Icon={LuWallet} />
        <Metric label={t('Себестоимость')} value={money(poTov.itogo.cost)} Icon={LuBoxes} />
        <Metric label={t('Прибыль')} value={money(poTov.itogo.profit)} Icon={LuTrendingUp} good />
        <Metric label={t('Чеков')} value={vse.itogo.cheki} sub={`${poTov.itogo.positions} ${t('наименований')}`} Icon={LuReceipt} onClick={() => setTab('cheki')} title={t('Показать чеки')} />
      </div>

      <div className="panel" data-tour="sr.table" style={{ padding: 0 }}>
        <div style={{ padding: '16px 16px 0' }}>
          <div className="toolbar">
            <input className="search" data-tour="sr.search" placeholder={tab === 'cheki' ? t('Номер чека, товар или клиент…') : t('Поиск по товару или штрихкоду…')} value={q} onChange={(e) => setQ(e.target.value)} />
            {tab === 'products' && (
              <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('Категория')} style={{ maxWidth: 220 }}>
                <option value="">{t('Все категории')}</option>
                {categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}
              </select>
            )}
            <select value={cashier} onChange={(e) => setCashier(e.target.value)} aria-label={t('Кассир')} data-tour="sr.cashier" style={{ maxWidth: 200 }}>
              <option value="">{t('Все кассиры')}</option>
              {cashiers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {tab !== 'products' && (
              <select value={pay} onChange={(e) => setPay(e.target.value)} aria-label={t('Оплата')} style={{ maxWidth: 200 }}>
                <option value="">{t('Любая оплата')}</option>
                {Object.entries(PAYMENTS).map(([k, m]) => <option key={k} value={k}>{t(m.label)}</option>)}
              </select>
            )}
            {loading && <span className="tag-cat">{t('загружаем…')}</span>}
          </div>
        </div>

        <div className="table-cards-wrap">
          {tab === 'cheki' ? (
            <table className="table-cards" data-testid="sr-cheki">
              <thead>
                <tr>
                  <th>{t('Чек')}</th><th>{t('Дата')}</th><th>{t('Кассир')}</th><th>{t('Оплата')}</th><th>{t('Клиент')}</th>
                  <th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th>
                </tr>
              </thead>
              <tbody>
                {pgC.slice.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    tabIndex={0}
                    title={t('Открыть чек')}
                    onClick={() => setOtkryt(r)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOtkryt(r) } }}
                  >
                    <td className="cell-main">
                      <b>{chekNomer(r.date)}</b>
                      {chekMark(r) && <div className="tag-cat" style={{ color: r.otmena ? 'var(--danger)' : 'var(--warn)' }}>{chekMark(r)}</div>}
                    </td>
                    <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                    <td data-label={t('Кассир')}>{r.cashier || '—'}</td>
                    <td data-label={t('Оплата')}>{payLabel(r.payment, t)}{r.payVia ? <span className="tag-cat"> · {r.payVia}</span> : null}</td>
                    <td data-label={t('Клиент')}>{r.customer || '—'}</td>
                    <td className="num" data-label={t('Позиций')}>{r.positions}</td>
                    <td className="num" data-label={t('Сумма')}>
                      <b style={r.otmena ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{money(r.total)}</b>
                    </td>
                  </tr>
                ))}
                {chekRows.length === 0 && <tr><td colSpan="7" className="empty">{loading ? t('Загружаем…') : t('За этот период чеков нет')}</td></tr>}
              </tbody>
              {chekRows.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="5">{t('Итого')} · {t('Чеков')}: {chekItogo.cheki}</td>
                    <td></td>
                    <td className="num">{money(chekItogo.sum)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : tab === 'products' ? (
            <table className="table-cards">
              <thead>
                <tr>
                  <th>{t('Товар')}</th><th className="num">{t('Продано')}</th><th className="num">{t('Выручка')}</th>
                  <th className="num">{t('Себестоимость')}</th><th className="num">{t('Прибыль')}</th><th className="num">{t('Маржа')}</th>
                </tr>
              </thead>
              <tbody>
                {pgT.slice.map((r) => (
                  <tr key={r.key}>
                    <td className="cell-main"><b>{r.name}</b>{r.category ? <div className="tag-cat">{t(r.category)}</div> : null}</td>
                    <td className="num" data-label={t('Продано')}>{r.qty}</td>
                    <td className="num" data-label={t('Выручка')}><b>{money(r.revenue)}</b></td>
                    <td className="num" data-label={t('Себестоимость')}>{money(r.cost)}</td>
                    <td className="num" data-label={t('Прибыль')} style={{ color: r.profit < 0 ? 'var(--danger)' : 'var(--green)' }}>{money(r.profit)}</td>
                    <td className="num" data-label={t('Маржа')}>{String(r.margin).replace('.', ',')}%</td>
                  </tr>
                ))}
                {tovRows.length === 0 && <tr><td colSpan="6" className="empty">{loading ? t('Загружаем…') : t('За этот период продаж нет')}</td></tr>}
              </tbody>
              {tovRows.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="2">{t('Итого')}</td>
                    <td className="num">{money(tovItogo.revenue)}</td>
                    <td className="num">{money(tovItogo.cost)}</td>
                    <td className="num">{money(tovItogo.profit)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table className="table-cards">
              <thead>
                <tr>
                  <th>{t('Дата')}</th><th>{t('Чек')}</th><th>{t('Кассир')}</th><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th>
                  <th className="num">{t('Цена')}</th><th className="num">{t('Скидка')}</th><th className="num">{t('Сумма')}</th><th>{t('Оплата')}</th>
                </tr>
              </thead>
              <tbody>
                {pgV.slice.map((r, n) => (
                  <tr key={r.saleId + ':' + n}>
                    <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.date)}</td>
                    <td data-label={t('Чек')} className="tag-cat">{chekNomer(r.date)}</td>
                    <td data-label={t('Кассир')}>{r.cashier || '—'}</td>
                    <td className="cell-main"><b>{r.name}</b></td>
                    <td className="num" data-label={t('Кол-во')}>{r.qty}</td>
                    <td className="num" data-label={t('Цена')}>{money(r.price)}</td>
                    <td className="num" data-label={t('Скидка')}>{r.discount > 0 ? '−' + money(r.discount) : '—'}</td>
                    <td className="num" data-label={t('Сумма')}><b>{money(r.sum)}</b></td>
                    <td data-label={t('Оплата')}>{payLabel(r.payment, t)}{r.payVia ? <span className="tag-cat"> · {r.payVia}</span> : null}</td>
                  </tr>
                ))}
                {vseRows.length === 0 && <tr><td colSpan="9" className="empty">{loading ? t('Загружаем…') : t('За этот период продаж нет')}</td></tr>}
              </tbody>
              {vseRows.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="6">{t('Итого')}</td>
                    <td className="num">{vseItogo.discount > 0 ? '−' + money(vseItogo.discount) : '—'}</td>
                    <td className="num">{money(vseItogo.sum)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
        {tab === 'cheki' ? <Pagination {...pgC} /> : tab === 'products' ? <Pagination {...pgT} /> : <Pagination {...pgV} />}
      </div>

      {otkryt && <ChekOkno row={otkryt} products={products} onClose={() => setOtkryt(null)} />}
    </Layout>
  )
}

// ── Окно чека из отчёта ──
// Чек в том же виде, что на бумаге (lib/ticket.js), и «Печать» — тот же чек ещё раз:
// на чековый принтер или через экран печати. Строк «Получено» и «Сдача» в повторе нет —
// программа их не хранит, они есть только на первом чеке. Если чек отменили или по нему
// был возврат — об этом сказано над чеком
function ChekOkno({ row, products, onClose }) {
  const t = useT()
  const auth = useAuth()
  const toast = useToast()
  // У строк продажи с сервера нет единицы (кг, л…) — она берётся из карточки товара
  const s = { ...row.sale, items: sEdinicami(row.sale.items, products) }
  const ticket = saleTicket(s, {
    t,
    money,
    when: fmtDateTime,
    pharmacy: auth?.pharmacy?.name,
    cashier: s.user?.name || '',
    rekvizity: getRekvizity(auth?.pharmacy?.code),
    nomer: chekNomer(s.date),
    // Повтор отменённого чека — с пометкой: продажи по нему больше нет
    pometka: row.otmena ? `${t('Чек отменён')} ${fmtDateTime(row.otmena.date)}` : '',
  })
  const print = () => pechatTicket(ticket).catch((e) => toast(t(e.message), 'err'))
  const vozvraty = (row.vozvraty || []).filter((r) => !isOtmena(r))
  return (
    <Modal title={<><span className="ic"><LuReceipt size={18} /></span>{t('Чек')} № {chekNomer(s.date)}</>} onClose={onClose}>
      {row.otmena && (
        <div className="note err" style={{ marginBottom: 12 }}>
          {t('Чек отменён')} {fmtDateTime(row.otmena.date)}{row.otmena.user?.name ? ` · ${row.otmena.user.name}` : ''} —{' '}
          {s.payment === 'debt' ? t('товар вернулся на склад, долг клиента уменьшен.') : t('товар вернулся на склад, деньги возвращены.')}
        </div>
      )}
      {vozvraty.map((r) => (
        <div className="note info" style={{ marginBottom: 12 }} key={r.id}>
          {t('Возврат по чеку')}: {fmtDateTime(r.date)} — {money(r.total)}
        </div>
      ))}
      <TicketView ticket={ticket} />
      {/* На бумагу — этот же чек, из печатного слоя */}
      <PrintDoc prio={2} kind="ticket" title={t('Чек продажи')}><TicketView ticket={ticket} /></PrintDoc>
      <div className="modal-actions">
        <button className="btn ghost" data-testid="chek-print" onClick={print}><span className="ic"><LuPrinter size={16} /></span> {t('Печать')}</button>
        <button className="btn" onClick={onClose}>{t('Закрыть')}</button>
      </div>
    </Modal>
  )
}

function Metric({ label, value, sub, Icon, good, onClick, title }) {
  // Карточка с действием — кнопка: и мышью, и с клавиатуры
  const act = onClick
    ? { role: 'button', tabIndex: 0, title, onClick, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } }
    : {}
  return (
    <div className={'metric' + (onClick ? ' clickable' : '')} {...act}>
      <div className="metric-head">
        <div className="label">{label}</div>
        <div className="ic-box" style={good ? { background: 'var(--green-soft, var(--accent-soft))', color: 'var(--green)' } : undefined}><Icon size={19} /></div>
      </div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}
