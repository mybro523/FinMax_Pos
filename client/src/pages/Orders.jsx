import { useMemo } from 'react'
import { LuClipboardList, LuPackage, LuWallet, LuCircleCheck } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { useCollection, money, stockText } from '../db/store'
import { lowStockProducts } from '../db/ops'
import { fmtDate, serverNow } from '../lib/time'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'
import { useT } from '../lib/i18n'

// Заявку отправляют поставщику файлом Excel или распечатывают: в ней штрихкоды,
// сколько заказать и на какую сумму по закупочной цене

export default function Orders() {
  const products = useCollection('products')
  const t = useT()
  // products в зависимостях намеренно: lowStockProducts() читает список из общего
  // слоя данных сама, и это единственный признак, что данные поменялись
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const low = useMemo(() => lowStockProducts(), [products])
  const pg = usePagination(low, 10)

  const total = low.reduce((s, p) => s + p.cost * p.need, 0)

  // ── Выгрузка и печать заявки ──
  const kop = (x) => Math.round(x * 100) / 100
  const exCols = [
    { header: t('Товар'), key: 'name', width: 34 },
    { header: t('Штрихкод'), key: 'barcode', width: 17 },
    { header: t('Категория'), key: 'cat', width: 16 },
    { header: t('Остаток'), key: 'stock', width: 14 },
    { header: t('Минимум'), key: 'min', width: 10, num: true },
    { header: t('Заказать'), key: 'need', width: 10, num: true },
    { header: t('Ед.'), key: 'unit', width: 8 },
    { header: t('Закупочная'), key: 'cost', width: 13, money: true },
    { header: t('Сумма'), key: 'sum', width: 14, money: true },
  ]
  const exRows = low.map((p) => ({
    name: p.name, barcode: p.barcode || '', cat: p.category || '', stock: stockText(p), min: p.minStock, need: p.need, unit: t(p.unit || ''),
    cost: kop(Number(p.cost) || 0), sum: kop((Number(p.cost) || 0) * p.need),
  }))
  const exItogi = { name: t('Итого'), need: low.reduce((s, p) => s + p.need, 0), sum: kop(total) }
  const exPodzag = `${t('Заявка на товар')} · ${fmtDate(serverNow())} · ${t('Позиций')}: ${low.length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Заявка на товар'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Заявка на товар')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout
      title={t('Авто-заявка')}
      subtitle={t('Товары, которые заканчиваются — система предлагает заказать')}
      actions={<ExportPechat onExcel={exportExcel} />}
    >
      <PrintSheet zagolovok={t('Заявка на товар')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      {low.length === 0 ? (
        <div className="panel" data-tour="ord.list"><div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}><LuCircleCheck size={34} style={{ color: 'var(--green)' }} />{t('Все остатки в норме — заявка не требуется')}</div></div>
      ) : (
        <>
          <div className="cards" data-tour="ord.cards" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
            <Metric label={t('Позиций к заказу')} value={low.length} Icon={LuClipboardList} />
            <Metric label={t('Единиц товара')} value={low.reduce((s, p) => s + p.need, 0)} Icon={LuPackage} />
            <Metric label={t('Сумма заявки')} value={money(total)} Icon={LuWallet} />
          </div>

          <div className="panel" data-tour="ord.list" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr><th>{t('Товар')}</th><th>{t('Категория')}</th><th className="num">{t('Остаток')}</th><th className="num">{t('Минимум')}</th><th className="num">{t('Заказать')}</th><th className="num">{t('Сумма')}</th></tr>
              </thead>
              <tbody>
                {pg.slice.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b><div className="tag-cat">{p.barcode}</div></td>
                    <td>{p.category}</td>
                    <td className="num"><span className="badge low">{stockText(p)}</span></td>
                    <td className="num">{p.minStock}</td>
                    <td className="num"><b>{p.need} {p.unit}</b></td>
                    <td className="num">{money(p.cost * p.need)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pg} />
          </div>
        </>
      )}
    </Layout>
  )
}
