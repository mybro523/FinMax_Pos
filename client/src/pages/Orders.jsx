import { useEffect, useMemo, useState } from 'react'
import { LuClipboardList, LuPackage, LuWallet, LuCircleCheck } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import StickyBar from '../components/StickyBar'
import { Modal } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useCollection, useCollectionIf, money, stockText } from '../db/store'
import { api } from '../db/api'
import { lowStockProducts } from '../db/ops'
import { fmtDate, serverNow } from '../lib/time'
import { skachatXlsx } from '../lib/excel'
import { getUser, useCan } from '../db/auth'
import { useT } from '../lib/i18n'
import KameraKnopka from '../components/KameraKnopka'
import { poiskZapros } from '../lib/poisk'
import { BEZ_POSTAVSHIKA, otborZayavki, postavshikiTovarov, sPostavshikom, spisokKategoriy, spisokPostavshikov } from '../lib/zayavka'

// Заявку отправляют поставщику файлом Excel или распечатывают: в ней штрихкоды,
// сколько заказать и на какую сумму по закупочной цене.
// С 1.7.2 у каждой строки — поставщик (последний приход этого товара) и отбор: поиск,
// поставщик, категория. Карточки, Excel и печать считают только отобранное — так заявку
// делают одному поставщику, и его имя стоит в заголовке листа.

export default function Orders() {
  const products = useCollection('products')
  // Журнал приходов — только тому, кому он разрешён: без права сервер отказывал бы на каждом
  // опросе. Без него поставщиков знает только сервер (GET /products/suppliers)
  const can = useCan()
  const arrivals = useCollectionIf('arrivals', can('arrivals.view'))
  const suppliers = useCollection('suppliers')
  const t = useT()
  // Поставщики товаров с сервера — по приходам за всё время. Нет ответа (нет связи,
  // сервер прежней версии) — по журналу приходов этого устройства
  const [server, setServer] = useState(null)
  useEffect(() => {
    let alive = true
    api.get('/products/suppliers').then(
      (rows) => alive && Array.isArray(rows) && setServer(rows),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])

  const [q, setQ] = useState('')
  const [sup, setSup] = useState('')
  const [cat, setCat] = useState('')
  const z = useMemo(() => poiskZapros(q), [q])

  const map = useMemo(() => postavshikiTovarov({ arrivals, server, suppliers }), [arrivals, server, suppliers])
  // products в зависимостях намеренно: lowStockProducts() читает список из общего
  // слоя данных сама, и это единственный признак, что данные поменялись
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const low = useMemo(() => sPostavshikom(lowStockProducts(), map), [products, map])
  const sups = useMemo(() => spisokPostavshikov(low), [low])
  const cats = useMemo(() => spisokKategoriy(low), [low])
  // Выбранный поставщик или категория пропали из заявки (товар пришёл) — отбор снимается
  const supOk = !sup || (sup === BEZ_POSTAVSHIKA ? sups.none > 0 : sups.list.some((s) => s.key === sup))
  const catOk = !cat || cats.some((c) => c.name === cat)
  const rows = useMemo(
    () => otborZayavki(low, { z, sup: supOk ? sup : '', cat: catOk ? cat : '' }),
    [low, z, sup, cat, supOk, catOk],
  )
  const pg = usePagination(rows, 10, `${q}|${sup}|${cat}`)
  // Карточки открывают подробности той же заявки (с теми же фильтрами)
  const [okno, setOkno] = useState(null)

  const total = rows.reduce((s, p) => s + p.cost * p.need, 0)
  const units = rows.reduce((s, p) => s + p.need, 0)
  const supName = supOk && sup ? (sup === BEZ_POSTAVSHIKA ? t('Без поставщика') : sups.list.find((s) => s.key === sup)?.name || '') : ''
  const filtered = !!(z || (supOk && sup) || (catOk && cat))

  // ── Выгрузка и печать заявки — то, что отобрано ──
  const kop = (x) => Math.round(x * 100) / 100
  const exCols = [
    { header: t('Товар'), key: 'name', width: 34 },
    { header: t('Штрихкод'), key: 'barcode', width: 17 },
    { header: t('Поставщик'), key: 'supplier', width: 22 },
    { header: t('Категория'), key: 'cat', width: 16 },
    { header: t('Остаток'), key: 'stock', width: 14 },
    { header: t('Минимум'), key: 'min', width: 10, num: true },
    { header: t('Заказать'), key: 'need', width: 10, num: true },
    { header: t('Ед.'), key: 'unit', width: 8 },
    { header: t('Закупочная'), key: 'cost', width: 13, money: true },
    { header: t('Сумма'), key: 'sum', width: 14, money: true },
  ]
  const exRows = rows.map((p) => ({
    name: p.name, barcode: p.barcode || '', supplier: p.supplier || '—', cat: p.category || '', stock: stockText(p), min: p.minStock, need: p.need, unit: t(p.unit || ''),
    cost: kop(Number(p.cost) || 0), sum: kop((Number(p.cost) || 0) * p.need),
  }))
  const exItogi = { name: t('Итого'), need: units, sum: kop(total) }
  const exZag = supName && sup !== BEZ_POSTAVSHIKA ? `${t('Заявка на товар')} — ${supName}` : t('Заявка на товар')
  const exPodzag = [
    `${t('Заявка на товар')} · ${fmtDate(serverNow())} · ${t('Позиций')}: ${rows.length}`,
    supName && `${t('Поставщик')}: ${supName}`,
    catOk && cat && `${t('Категория')}: ${t(cat)}`,
    z && `${t('Поиск')}: ${q.trim()}`,
  ].filter(Boolean).join(' · ')
  const exportExcel = () =>
    skachatXlsx({ fayl: exZag, zagolovok: `${getUser()?.pharmacy?.name || ''} — ${exZag}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout
      title={t('Авто-заявка')}
      subtitle={t('Товары, которые заканчиваются — система предлагает заказать')}
      actions={<ExportPechat onExcel={exportExcel} />}
    >
      <PrintSheet zagolovok={exZag} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      {low.length === 0 ? (
        <div className="panel" data-tour="ord.list"><div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}><LuCircleCheck size={34} style={{ color: 'var(--green)' }} />{t('Все остатки в норме — заявка не требуется')}</div></div>
      ) : (
        <>
          <div className="cards three" data-tour="ord.cards" style={{ marginBottom: 16 }}>
            <Metric label={t('Позиций к заказу')} value={rows.length} Icon={LuClipboardList} sub={filtered ? `${t('из')} ${low.length}` : t('подробнее')} onClick={() => setOkno('pozicii')} testid="card-ord-pozicii" />
            <Metric label={t('Единиц товара')} value={units} Icon={LuPackage} sub={t('подробнее')} onClick={() => setOkno('edinicy')} testid="card-ord-edinicy" />
            <Metric label={t('Сумма заявки')} value={money(total)} Icon={LuWallet} sub={t('по поставщикам')} onClick={() => setOkno('summa')} testid="card-ord-summa" />
          </div>
          {okno && <ZayavkaOkno vid={okno} rows={rows} total={total} units={units} onClose={() => setOkno(null)} />}

          <div className="panel" data-tour="ord.list" style={{ padding: 0 }}>
            <StickyBar panel pad="16px 16px 14px">
              <div className="toolbar tools-wrap" data-tour="ord.filters">
                <div className="search kamera-pole">
                  <input
                    data-testid="ord-search"
                    placeholder={t('Название или штрихкод…')}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    aria-label={t('Поиск')}
                  />
                  <KameraKnopka onCode={setQ} testid="kamera-orders" />
                </div>
                <select value={supOk ? sup : ''} onChange={(e) => setSup(e.target.value)} aria-label={t('Поставщик')} data-testid="ord-sup" style={{ maxWidth: 260 }}>
                  <option value="">{t('Все поставщики')}</option>
                  {sups.list.map((s) => <option key={s.key} value={s.key}>{s.name} ({s.count})</option>)}
                  {sups.none > 0 && <option value={BEZ_POSTAVSHIKA}>{t('Без поставщика')} ({sups.none})</option>}
                </select>
                <select value={catOk ? cat : ''} onChange={(e) => setCat(e.target.value)} aria-label={t('Категория')} data-testid="ord-cat" style={{ maxWidth: 220 }}>
                  <option value="">{t('Все категории')}</option>
                  {cats.map((c) => <option key={c.name} value={c.name}>{t(c.name)} ({c.count})</option>)}
                </select>
                {filtered && (
                  <button className="btn ghost sm" onClick={() => { setQ(''); setSup(''); setCat('') }}>{t('Сбросить')}</button>
                )}
              </div>
            </StickyBar>
            <div className="table-cards-wrap">
              <table className="table-cards" data-testid="ord-table">
                <thead>
                  <tr>
                    <th>{t('Товар')}</th><th>{t('Поставщик')}</th><th>{t('Категория')}</th><th className="num">{t('Остаток')}</th>
                    <th className="num">{t('Минимум')}</th><th className="num">{t('Заказать')}</th><th className="num">{t('Сумма')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.slice.map((p) => (
                    <tr key={p.id}>
                      <td className="cell-main"><b>{p.name}</b><div className="tag-cat">{p.barcode}</div></td>
                      <td data-label={t('Поставщик')}>{p.supplier || <span className="tag-cat">{t('Без поставщика')}</span>}</td>
                      <td data-label={t('Категория')}>{p.category ? t(p.category) : '—'}</td>
                      <td className="num" data-label={t('Остаток')}><span className="badge low">{stockText(p)}</span></td>
                      <td className="num" data-label={t('Минимум')}>{p.minStock}</td>
                      <td className="num" data-label={t('Заказать')}><b>{p.need} {t(p.unit || '')}</b></td>
                      <td className="num" data-label={t('Сумма')}>{money(p.cost * p.need)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan="7" className="empty">{t('Ничего не найдено')}</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination {...pg} />
          </div>
        </>
      )}
    </Layout>
  )
}

// ── Окно карточки заявки ──
// «Позиций» и «Единиц» — те же товары заявки (по сумме или по количеству),
// «Сумма» — сколько заказать у каждого поставщика
function ZayavkaOkno({ vid, rows, total, units, onClose }) {
  const t = useT()
  if (vid === 'summa') {
    const m = new Map()
    for (const p of rows) {
      const k = p.supplier || ''
      const x = m.get(k) || { name: p.supplier || t('Без поставщика'), count: 0, need: 0, sum: 0 }
      x.count += 1
      x.need += p.need
      x.sum += p.cost * p.need
      m.set(k, x)
    }
    const list = [...m.values()].sort((a, b) => b.sum - a.sum)
    return (
      <Modal wide title={t('Сумма заявки по поставщикам')} onClose={onClose}>
        <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
          <table data-testid="ord-okno">
            <thead><tr><th>{t('Поставщик')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Заказать')}</th><th className="num">{t('Сумма')}</th></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.name}><td><b>{x.name}</b></td><td className="num">{x.count}</td><td className="num">{x.need}</td><td className="num">{money(x.sum)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="total-row big"><span>{t('Сумма заявки')}</span><span>{money(total)}</span></div>
        <div className="modal-actions"><button className="btn" onClick={onClose}>{t('Закрыть')}</button></div>
      </Modal>
    )
  }
  const list = [...rows].sort(vid === 'edinicy' ? (a, b) => b.need - a.need : (a, b) => b.cost * b.need - a.cost * a.need)
  return (
    <Modal wide title={vid === 'edinicy' ? t('Единиц товара к заказу') : t('Позиций к заказу')} onClose={onClose}>
      <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
        <table data-testid="ord-okno">
          <thead><tr><th>{t('Товар')}</th><th>{t('Поставщик')}</th><th className="num">{t('Остаток')}</th><th className="num">{t('Заказать')}</th><th className="num">{t('Сумма')}</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b>{p.barcode ? <div className="tag-cat">{p.barcode}</div> : null}</td>
                <td>{p.supplier || <span className="tag-cat">{t('Без поставщика')}</span>}</td>
                <td className="num">{stockText(p)}</td>
                <td className="num"><b>{p.need} {t(p.unit || '')}</b></td>
                <td className="num">{money(p.cost * p.need)}</td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan="5" className="empty">{t('Ничего не найдено')}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="total-row big"><span>{t('Итого')} · {units} {t('ед.')}</span><span>{money(total)}</span></div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>{t('Закрыть')}</button></div>
    </Modal>
  )
}
