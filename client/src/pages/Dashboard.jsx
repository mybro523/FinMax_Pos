import { useMemo, useState, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import {
  LuWallet, LuTrendingUp, LuBoxes, LuReceipt, LuTruck, LuShoppingCart, LuChevronRight, LuBanknote,
} from 'react-icons/lu'

// Диаграммы — самая тяжёлая часть страницы, поэтому грузятся отдельно и уже
// после карточек: цифры и таблицы видны сразу, графики подрисовываются следом.
const DashboardCharts = lazy(() => import('../components/DashboardCharts'))
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import Discrepancies from '../components/Discrepancies'
import { Modal, PayBadge } from '../components/ui'
import { useCollection, money, stockText } from '../db/store'
import { isDivisible, stockUnits, stockValue, stockCost as stockCostOf, unitPrice, lineUnits } from '../lib/units'
import { dayKey, lastNDayKeys, fmtShort, fmtDayMonth, startOfDay } from '../lib/time'
import { expiringProducts } from '../lib/expiry'
import { periodFinance } from '../lib/finance'
import { LuTriangleAlert } from 'react-icons/lu'
import { useT, translate as tr } from '../lib/i18n'
import { useCan } from '../db/auth'

// Формулы упаковок и штук — общие, из lib/units
const unitsOf = stockUnits
const valueOf = stockValue

// Мини-карточка (кликабельная, если задан onClick)
function MC({ label, v, color, onClick }) {
  return (
    <div className={'mini-card' + (onClick ? ' clickable' : '')} onClick={onClick}>
      <div className="m-label">{label}</div>
      <div className="m-value sm" style={color ? { color } : undefined}>{v}</div>
    </div>
  )
}

// Таблица товаров для модалок аналитики
function ProductTable({ list, showValue }) {
  if (!list.length) return <div className="empty">{tr('Нет товаров')}</div>
  return (
    <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
      <table>
        <thead><tr><th>{tr('Товар')}</th><th>{tr('Категория')}</th><th className="num">{tr('Остаток')}</th><th className="num">{showValue ? tr('Стоимость') : tr('Цена')}</th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td><b>{p.name}</b>{p.dosage ? <span className="tag-cat"> · {p.dosage}</span> : null}</td>
              <td>{p.category}</td>
              <td className="num">{stockText(p)}</td>
              <td className="num">{money(showValue ? valueOf(p) : p.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SalesTable({ list }) {
  if (!list.length) return <div className="empty">{tr('Продаж нет')}</div>
  return (
    <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
      <table>
        <thead><tr><th>{tr('Время')}</th><th>{tr('Товары')}</th><th className="num">{tr('Сумма')}</th><th>{tr('Оплата')}</th></tr></thead>
        <tbody>
          {list.map((s) => {
            const names = s.items.map((i) => i.name).join(', ')
            return (
              <tr key={s.id}>
                <td>{fmtShort(s.date)}</td>
                <td>{names.slice(0, 40)}{names.length > 40 ? '…' : ''}</td>
                <td className="num"><b>{money(s.total)}</b></td>
                <td><PayBadge type={s.payment} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function Dashboard() {
  const sales = useCollection('sales')
  const products = useCollection('products')
  const customers = useCollection('customers')
  // Долги поставщикам — рядом с долгами клиентов: это деньги, которые аптеке ещё платить
  const suppliers = useCollection('suppliers')
  // Возвраты и списания за сегодня — иначе выручка и прибыль на панели завышены
  const returns = useCollection('returns')
  const writeOffs = useCollection('writeoffs')
  const t = useT()
  const can = useCan()
  const [modal, setModal] = useState(null)
  const close = () => setModal(null)

  const stats = useMemo(() => {
    const today = dayKey()
    const safe = sales.filter((s) => s && s.date && Array.isArray(s.items))
    const todayList = safe.filter((s) => dayKey(s.date) === today)
    // Итоги дня считаем теми же правилами, что и Отчёты: продажи минус
    // возвращённые покупателям деньги и минус списанный товар
    const fin = periodFinance({ sales: safe, returns, writeOffs, from: startOfDay() })
    const salesToday = fin.revenue
    const profitToday = fin.profit
    const costToday = fin.cost
    const todayByPay = { cash: 0, card: 0, transfer: 0, debt: 0 }
    todayList.forEach((s) => { if (s.payment in todayByPay) todayByPay[s.payment] += s.total || 0 })

    const stockValue = products.reduce((s, p) => s + valueOf(p), 0)
    const stockCost = products.reduce((s, p) => s + stockCostOf(p), 0)
    const stockUnits = products.reduce((s, p) => s + (p.stock || 0), 0)
    const debtTotal = customers.reduce((s, c) => s + (c.debt || 0), 0)
    const debtors = customers.filter((c) => (c.debt || 0) > 0).sort((a, b) => b.debt - a.debt)
    const supplierDebt = suppliers.reduce((s, x) => s + (Number(x.debt) || 0), 0)
    const creditors = suppliers.filter((x) => (Number(x.debt) || 0) > 0).sort((a, b) => Number(b.debt) - Number(a.debt))
    const lowList = products.filter((p) => p.stock <= p.minStock).sort((a, b) => a.stock - b.stock)
    const outList = products.filter((p) => unitsOf(p) <= 0)
    const margin = stockValue > 0 ? Math.round(((stockValue - stockCost) / stockValue) * 100) : 0

    const catMap = {}
    products.forEach((p) => {
      const k = p.category || 'Прочее'
      catMap[k] = catMap[k] || { cat: k, count: 0, value: 0 }
      catMap[k].count += 1
      catMap[k].value += valueOf(p)
    })
    const categories = Object.values(catMap).sort((a, b) => b.value - a.value)

    // Неликвид — товары без единой продажи
    const soldIds = new Set(), soldNames = new Set()
    safe.forEach((s) => s.items.forEach((i) => { if (i.productId) soldIds.add(i.productId); if (i.name) soldNames.add(i.name) }))
    const deadStock = products.filter((p) => !soldIds.has(p.id) && !soldNames.has(p.name))

    // График за 10 дней (с ключом дня для детализации).
    // Возвраты вычитаем из того дня, когда деньги вернули: иначе график
    // показывал бы продажи, которых по факту не было.
    const keys = lastNDayKeys(10)
    const byDay = Object.fromEntries(keys.map((k) => [k, 0]))
    safe.forEach((s) => { const k = dayKey(s.date); if (k in byDay) byDay[k] += s.total || 0 })
    returns.forEach((r) => { const k = dayKey(r.date); if (k in byDay) byDay[k] -= r.total || 0 })
    const chart = keys.map((k) => ({ key: k, day: fmtDayMonth(k + 'T12:00:00+05:00'), sum: byDay[k] }))

    // Топ товаров по штукам — тоже за вычетом возвращённого,
    // иначе возвращённый товар выглядел бы ходовым
    const top = {}
    safe.forEach((s) => s.items.forEach((i) => {
      const units = lineUnits(i)
      top[i.name] = top[i.name] || { name: i.name, qty: 0, sum: 0 }
      top[i.name].qty += units
      // Выручка — чистая (за вычетом скидки), как s.total
      top[i.name].sum += Math.max(0, unitPrice(i) * units - (i.discount || 0))
    }))
    returns.forEach((r) => (r.items || []).forEach((i) => {
      const t = top[i.name]
      if (!t) return
      t.qty -= i.units || 0
      t.sum -= Number(i.amount) || 0
    }))
    const topProducts = Object.values(top).filter((p) => p.qty > 0).sort((a, b) => b.sum - a.sum).slice(0, 6)
    const recent = safe.slice(0, 8)

    return {
      salesToday, profitToday, costToday, todayByPay, todayList, todayCount: todayList.length, fin,
      stockValue, stockCost, stockUnits, debtTotal, debtors, supplierDebt, creditors, lowList, outList, margin, categories, deadStock,
      chart, topProducts, recent, expiring: expiringProducts(products).length,
    }
  }, [sales, products, customers, suppliers, returns, writeOffs])


  function renderModal() {
    if (modal.type === 'sales') {
      return (
        <Modal wide title={t('Продажи за сегодня')} onClose={close}>
          <div className="mini-cards">
            <MC label={t('Продано на')} v={money(stats.fin.revenueGross)} />
            {stats.fin.refunds > 0 && <MC label={t('Возвраты')} v={'−' + money(stats.fin.refunds)} color="var(--danger)" />}
            <MC label={t('Выручка')} v={money(stats.salesToday)} />
            <MC label={t('Чеков')} v={stats.todayCount} />
            <MC label={t('Наличные')} v={money(stats.todayByPay.cash)} />
            <MC label={t('Карта')} v={money(stats.todayByPay.card)} />
            <MC label={t('Перевод')} v={money(stats.todayByPay.transfer)} />
            <MC label={t('В долг')} v={money(stats.todayByPay.debt)} />
          </div>
          <SalesTable list={stats.todayList} />
        </Modal>
      )
    }
    if (modal.type === 'profit') {
      const f = stats.fin
      return (
        <Modal title={t('Прибыль за сегодня')} onClose={close}>
          <div className="total-row"><span>{t('Продано на')}</span><span>{money(f.revenueGross)}</span></div>
          <div className="total-row"><span>{t('Себестоимость проданного')}</span><span>−{money(f.cost)}</span></div>
          <div className="total-row"><span>{t('Прибыль с продаж')}</span><span>{money(f.profitGross)}</span></div>
          {f.refunds > 0 && (
            <div className="total-row">
              <span>{t('Возвращено покупателям')} <span className="tag-cat">· {f.refundCount}</span></span>
              <span style={{ color: 'var(--danger)' }}>−{money(f.refunds)}</span>
            </div>
          )}
          {f.returnedCost > 0 && (
            <div className="total-row">
              <span>{t('Товар вернулся на склад (закупочная)')}</span>
              <span style={{ color: 'var(--green)' }}>+{money(f.returnedCost)}</span>
            </div>
          )}
          {f.writeOffCost > 0 && (
            <div className="total-row">
              <span>{t('Списано (просрочка, бой, недостача)')} <span className="tag-cat">· {f.writeOffCount}</span></span>
              <span style={{ color: 'var(--danger)' }}>−{money(f.writeOffCost)}</span>
            </div>
          )}
          <div className="total-row big"><span>{t('Осталось прибыли')}</span><span style={{ color: 'var(--green)' }}>{money(f.profit)}</span></div>
          <div className="total-row"><span>{t('Маржа')}</span><span>{f.margin}%</span></div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
            {t('За сегодня')} {stats.todayCount} {t('чек(ов)')}.{' '}
            {t('Товар, вернувшийся на полку, прибыль не уменьшает — потеряны только деньги за него.')}
          </p>
        </Modal>
      )
    }
    if (modal.type === 'stock') {
      return (
        <Modal wide title={t('Склад — детали')} onClose={close}>
          <div className="mini-cards">
            <MC label={t('Стоимость')} v={money(stats.stockValue)} />
            <MC label={t('Наименований')} v={products.length} />
            <MC label={t('Заканчивается')} v={stats.lowList.length} color={stats.lowList.length ? 'var(--warn)' : undefined} />
            <MC label={t('Нет в наличии')} v={stats.outList.length} color={stats.outList.length ? 'var(--danger)' : undefined} />
          </div>
          <h2 style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('Заканчивается')}</h2>
          <div style={{ maxHeight: '44vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('Товар')}</th><th>{t('Категория')}</th><th className="num">{t('Остаток')}</th></tr></thead>
              <tbody>
                {stats.lowList.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b></td>
                    <td>{p.category}</td>
                    <td className="num"><span className={'badge ' + (unitsOf(p) <= 0 ? 'debt' : 'low')}>{stockText(p)}</span></td>
                  </tr>
                ))}
                {stats.lowList.length === 0 && <tr><td colSpan="3" className="empty">{t('Все остатки в норме')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            <Link to="/orders" className="btn" onClick={close}>{t('Открыть авто-заявку')}</Link>
          </div>
        </Modal>
      )
    }
    if (modal.type === 'suppliers') {
      return (
        <Modal wide title={t('Долги поставщикам')} onClose={close}>
          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('Поставщик')}</th><th>{t('Телефон')}</th><th className="num">{t('Долг')}</th></tr></thead>
              <tbody>
                {stats.creditors.map((s) => (
                  <tr key={s.id}><td><b>{s.name}</b></td><td className="tag-cat">{s.phone || '—'}</td><td className="num"><span className="badge debt">{money(s.debt)}</span></td></tr>
                ))}
                {stats.creditors.length === 0 && <tr><td colSpan="3" className="empty">{t('Долгов нет')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="modal-actions"><Link to="/suppliers" className="btn ghost" onClick={close}>{t('Все поставщики')}</Link></div>
        </Modal>
      )
    }
    if (modal.type === 'debts') {
      return (
        <Modal wide title={t('Долги клиентов')} onClose={close}>
          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('Клиент')}</th><th>{t('Телефон')}</th><th className="num">{t('Долг')}</th></tr></thead>
              <tbody>
                {stats.debtors.map((c) => (
                  <tr key={c.id}><td><b>{c.name}</b></td><td className="tag-cat">{c.phone || '—'}</td><td className="num"><span className="badge debt">{money(c.debt)}</span></td></tr>
                ))}
                {stats.debtors.length === 0 && <tr><td colSpan="3" className="empty">{t('Долгов нет')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="modal-actions"><Link to="/debts" className="btn ghost" onClick={close}>{t('Все клиенты')}</Link></div>
        </Modal>
      )
    }
    if (modal.type === 'day') {
      const list = sales.filter((s) => s && s.date && Array.isArray(s.items) && dayKey(s.date) === modal.key)
      const sum = list.reduce((a, s) => a + (s.total || 0), 0)
      return (
        <Modal wide title={`${t('Продажи за')} ${modal.label}`} onClose={close}>
          <div className="mini-cards"><MC label={t('Выручка')} v={money(sum)} /><MC label={t('Чеков')} v={list.length} /></div>
          <SalesTable list={list} />
        </Modal>
      )
    }
    if (modal.type === 'product') {
      const name = modal.name
      let units = 0, revenue = 0
      sales.forEach((s) => Array.isArray(s.items) && s.items.forEach((i) => {
        if (i.name === name) {
          const un = lineUnits(i)
          units += un
          revenue += Math.max(0, unitPrice(i) * un - (i.discount || 0)) // чистая выручка
        }
      }))
      const prod = products.find((p) => p.name === name)
      return (
        <Modal title={name} onClose={close}>
          <div className="mini-cards">
            <MC label={t('Продано')} v={units + ' ' + t('шт')} />
            <MC label={t('Выручка')} v={money(revenue)} />
            <MC label={t('Остаток')} v={prod ? stockText(prod) : '—'} />
          </div>
          {prod && (
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              {t('Цена')} {money(prod.price)}{isDivisible(prod) ? ` · ${money(unitPrice(prod))}/${t('шт')}` : ''} · {t('закуп.')} {money(prod.cost)}
            </p>
          )}
        </Modal>
      )
    }
    // ── Модалки аналитики склада ──
    if (modal.type === 'topvalue') {
      const list = [...products].sort((a, b) => valueOf(b) - valueOf(a))
      return (
        <Modal wide title={t('Стоимость склада — по товарам')} onClose={close}>
          <div className="mini-cards"><MC label={t('Итого')} v={money(stats.stockValue)} /><MC label={t('Наименований')} v={products.length} /></div>
          <ProductTable list={list} showValue />
        </Modal>
      )
    }
    // Куда ушли деньги: сверху то, где их заморожено больше всего. Владелец
    // открывает эту таблицу, когда денег нет, а товар вроде бы есть
    if (modal.type === 'invested') {
      const list = [...products].filter((p) => stockCostOf(p) > 0).sort((a, b) => stockCostOf(b) - stockCostOf(a))
      return (
        <Modal wide title={t('Вложено в товар — по товарам')} onClose={close}>
          <div className="mini-cards">
            <MC label={t('Вложено')} v={money(stats.stockCost)} />
            <MC label={t('Выручу за всё')} v={money(stats.stockValue)} />
            <MC label={t('Будущая прибыль')} v={money(stats.stockValue - stats.stockCost)} color="var(--green)" />
          </div>
          <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t('Товар')}</th>
                  <th className="num">{t('Остаток')}</th>
                  <th className="num">{t('Закуп.')}</th>
                  <th className="num">{t('Вложено')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b>{p.dosage ? <span className="tag-cat"> · {p.dosage}</span> : null}</td>
                    <td className="num">{stockText(p)}</td>
                    <td className="num">{money(p.cost || 0)}</td>
                    <td className="num"><b>{money(stockCostOf(p))}</b></td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan="4" className="empty">{t('Нет товаров')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="tag-cat" style={{ marginTop: 8 }}>
            {t('Закупочная — средняя по всем поставкам этого товара: продавая упаковку, не узнать, из какой она партии.')}
          </div>
        </Modal>
      )
    }
    if (modal.type === 'positions') {
      const list = [...products].sort((a, b) => a.name.localeCompare(b.name))
      return <Modal wide title={t('Все наименования')} onClose={close}><ProductTable list={list} /></Modal>
    }
    if (modal.type === 'low') {
      return (
        <Modal wide title={t('Заканчивается')} onClose={close}>
          <ProductTable list={stats.lowList} showValue />
          <div className="modal-actions"><Link to="/orders" className="btn" onClick={close}>{t('Открыть авто-заявку')}</Link></div>
        </Modal>
      )
    }
    if (modal.type === 'out') {
      return <Modal wide title={t('Нет в наличии')} onClose={close}><ProductTable list={stats.outList} showValue /></Modal>
    }
    if (modal.type === 'margin') {
      const list = [...products].map((p) => ({ ...p, _m: p.price ? Math.round(((p.price - p.cost) / p.price) * 100) : 0 })).sort((a, b) => a._m - b._m)
      return (
        <Modal wide title={t('Маржа склада')} onClose={close}>
          <div className="mini-cards"><MC label={t('Ср. маржа')} v={stats.margin + '%'} /><MC label={t('Стоимость')} v={money(stats.stockValue)} /></div>
          <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>{t('Товар')}</th><th className="num">{t('Закуп.')}</th><th className="num">{t('Продажа')}</th><th className="num">{t('Маржа')}</th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}><td><b>{p.name}</b></td><td className="num">{money(p.cost)}</td><td className="num">{money(p.price)}</td>
                    <td className="num" style={{ color: p._m < 20 ? 'var(--danger)' : 'var(--green)' }}>{p._m}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )
    }
    if (modal.type === 'dead') {
      return (
        <Modal wide title={t('Неликвид (без продаж)')} onClose={close}>
          <div className="note info" style={{ marginBottom: 12 }}>{t('Товары, которые ещё ни разу не продавались.')}</div>
          <ProductTable list={stats.deadStock} showValue />
        </Modal>
      )
    }
    if (modal.type === 'category') {
      const list = products.filter((p) => (p.category || 'Прочее') === modal.cat).sort((a, b) => valueOf(b) - valueOf(a))
      return <Modal wide title={`${t('Категория')}: ${modal.cat}`} onClose={close}><ProductTable list={list} showValue /></Modal>
    }
    return null
  }

  return (
    <Layout title={t('Панель управления')} subtitle={t('Обзор аптеки (время таджикское, UTC+5)')}
      actions={can('pos.sell') && <Link to="/pos" className="btn" data-tour="dash.open-pos"><span className="ic"><LuShoppingCart size={16} /></span> {t('Открыть кассу')}</Link>}>

      {stats.expiring > 0 && (
        <Link to="/expiry" className="note err" data-tour="dash.expiring" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, textDecoration: 'none' }}>
          <LuTriangleAlert size={18} style={{ flexShrink: 0 }} />
          <span><b>{stats.expiring}</b> {t('товар(ов) с истекающим или истёкшим сроком годности — проверьте раздел «Срок годности»')}</span>
        </Link>
      )}

      {/* Появляется, только когда касса без интернета прислала то, что не сошлось с базой */}
      <Discrepancies />

      {/* Ячеек шесть — три в ряд, как в отчётах */}
      <div className="cards six">
        <Metric tour="dash.sales" label={t('Продажи за сегодня')} value={money(stats.salesToday)} Icon={LuWallet} tint="accent"
          sub={stats.fin.refunds > 0 ? `${stats.todayCount} ${t('чек(ов)')} · ${t('возвраты')} −${money(stats.fin.refunds)}` : `${stats.todayCount} ${t('чек(ов) · подробнее')}`}
          warn={stats.fin.refunds > 0} onClick={() => setModal({ type: 'sales' })} />
        <Metric tour="dash.profit" label={t('Прибыль за сегодня')} value={money(stats.profitToday)} Icon={LuTrendingUp} tint="green"
          sub={stats.fin.writeOffCost > 0 ? `${t('списано')} −${money(stats.fin.writeOffCost)}` : t('нажмите для деталей')}
          warn={stats.fin.writeOffCost > 0} onClick={() => setModal({ type: 'profit' })} />
        {/* ── Две цены одного и того же склада ──
            Одни и те же упаковки стоят по-разному, смотря о чём спрашивать.
            «Вложено» — деньги владельца, которые сейчас лежат на полке.
            «Остаток» — сколько он за них выручит, когда всё продаст; разница
            между числами и есть будущая прибыль.
            Раньше была только вторая ячейка, и владелец читал её как «столько
            у меня добра», хотя половина этой суммы ещё не заработана. Поэтому
            у обеих подписано, по какой цене считается: без подписи два разных
            числа про один склад выглядят как ошибка. */}
        <Metric tour="dash.invested" label={t('Вложено в товар')} value={money(stats.stockCost)} Icon={LuBanknote} tint="accent"
          sub={t('по закупочной цене')} onClick={() => setModal({ type: 'invested' })} />
        <Metric tour="dash.stock" label={t('Остаток на складе')} value={money(stats.stockValue)} Icon={LuBoxes} tint="blue"
          sub={stats.lowList.length
            ? `${stats.stockUnits} ${t('уп')} · ${stats.lowList.length} ${t('заканчивается')}`
            : `${stats.stockUnits} ${t('уп')} · ${t('по цене продажи')}`}
          warn={stats.lowList.length > 0} onClick={() => setModal({ type: 'stock' })} />
        <Metric tour="dash.debts" label={t('Долги клиентов')} value={money(stats.debtTotal)} Icon={LuReceipt} tint={stats.debtTotal > 0 ? 'danger' : 'accent'}
          sub={stats.debtors.length ? `${stats.debtors.length} ${t('клиент(ов) с долгом')}` : t('долгов нет')} onClick={() => setModal({ type: 'debts' })} />
        <Metric tour="dash.suppliers" label={t('Долги поставщикам')} value={money(stats.supplierDebt)} Icon={LuTruck} tint={stats.supplierDebt > 0 ? 'danger' : 'accent'}
          sub={stats.creditors.length ? `${stats.creditors.length} ${t('поставщик(ов) с долгом')}` : t('долгов нет')} onClick={() => setModal({ type: 'suppliers' })} />
      </div>

      <div className="grid-2 mt">
        <Suspense fallback={<><div className="panel chart-skeleton" /><div className="panel chart-skeleton" /></>}>
          <DashboardCharts
            chart={stats.chart}
            topProducts={stats.topProducts}
            onDay={(pt) => setModal({ type: 'day', key: pt.key, label: pt.day })}
            onProduct={(name) => setModal({ type: 'product', name })}
          />
        </Suspense>
      </div>

      {/* ── Аналитика склада (кликабельная) ── */}
      <div className="panel mt" data-tour="dash.analytics">
        <h2><span className="h2-title"><span className="ic"><LuBoxes size={17} /></span>{t('Аналитика склада')}</span><span className="tag-cat">{t('карточки и категории кликабельны')}</span></h2>
        <div className="mini-cards">
          <MC label={t('Стоимость склада')} v={money(stats.stockValue)} onClick={() => setModal({ type: 'topvalue' })} />
          <MC label={t('Наименований')} v={products.length} onClick={() => setModal({ type: 'positions' })} />
          <MC label={t('Заканчивается')} v={stats.lowList.length} color={stats.lowList.length ? 'var(--warn)' : undefined} onClick={() => setModal({ type: 'low' })} />
          <MC label={t('Нет в наличии')} v={stats.outList.length} color={stats.outList.length ? 'var(--danger)' : undefined} onClick={() => setModal({ type: 'out' })} />
          <MC label={t('Ср. маржа склада')} v={stats.margin + '%'} onClick={() => setModal({ type: 'margin' })} />
          <MC label={t('Неликвид (без продаж)')} v={stats.deadStock.length} onClick={() => setModal({ type: 'dead' })} />
        </div>
        <h2 data-tour="dash.categories" style={{ fontSize: 14, margin: '18px 0 10px' }}>{t('Стоимость по категориям')} <span className="tag-cat">— {t('клик по категории')}</span></h2>
        {stats.categories.slice(0, 8).map((c) => {
          const pct = stats.stockValue ? Math.round((c.value / stats.stockValue) * 100) : 0
          return (
            <div key={c.cat} className="cat-row" style={{ marginBottom: 11, cursor: 'pointer' }} onClick={() => setModal({ type: 'category', cat: c.cat })}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span>{c.cat} <span className="tag-cat">· {c.count} {t('поз.')}</span></span>
                <span><b>{money(c.value)}</b> · {pct}%</span>
              </div>
              <div style={{ height: 7, background: 'var(--track)', borderRadius: 6 }}>
                <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', borderRadius: 6 }} />
              </div>
            </div>
          )
        })}
        {stats.categories.length === 0 && <div className="empty">{t('Товаров нет')}</div>}
      </div>

      <div className="panel mt" data-tour="dash.recent">
        <h2>
          <span className="h2-title"><span className="ic"><LuReceipt size={17} /></span>{t('Последние продажи')}</span>
          <Link to="/reports" className="linklike">{t('смотреть все')} <LuChevronRight size={14} /></Link>
        </h2>
        <table>
          <thead><tr><th>{t('Время')}</th><th>{t('Товары')}</th><th className="num">{t('Сумма')}</th><th>{t('Оплата')}</th></tr></thead>
          <tbody>
            {stats.recent.map((s) => {
              const names = s.items.map((i) => i.name).join(', ')
              return (
                <tr key={s.id}>
                  <td>{fmtShort(s.date)}</td>
                  <td>{names.slice(0, 50)}{names.length > 50 ? '…' : ''} <span className="tag-cat">({s.items.reduce((a, i) => a + lineUnits(i), 0)} {t('шт')})</span></td>
                  <td className="num"><b>{money(s.total)}</b></td>
                  <td><PayBadge type={s.payment} /></td>
                </tr>
              )
            })}
            {stats.recent.length === 0 && <tr><td colSpan="4" className="empty">{t('Продаж пока нет')}</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && renderModal()}
    </Layout>
  )
}
