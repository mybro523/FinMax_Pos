import { useMemo } from 'react'
import { LuDownload, LuClipboardList, LuPackage, LuWallet, LuCircleCheck } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import { useToast } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { useCollection, money, stockText } from '../db/store'
import { lowStockProducts } from '../db/ops'
import { fmtDate, dayKey, serverNow } from '../lib/time'
import { useT } from '../lib/i18n'

export default function Orders() {
  const products = useCollection('products')
  const t = useT()
  const toast = useToast()
  // products в зависимостях намеренно: lowStockProducts() читает список из общего
  // слоя данных сама, и это единственный признак, что данные поменялись
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const low = useMemo(() => lowStockProducts(), [products])
  const pg = usePagination(low, 10)

  const total = low.reduce((s, p) => s + p.cost * p.need, 0)

  function exportOrder() {
    const lines = low.map((p) => `${p.name}\t${p.barcode}\t${p.need} ${p.unit}\t${p.cost} сомони`)
    const text = `ЗАЯВКА НА ТОВАР — ${fmtDate(serverNow())}\n\nТовар\tШтрихкод\tКол-во\tЗакуп.\n${lines.join('\n')}\n\nИтого: ${money(total)}`
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Заявка_${dayKey()}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast(t('Заявка выгружена'))
  }

  return (
    <Layout
      title={t('Авто-заявка')}
      subtitle={t('Товары, которые заканчиваются — система предлагает заказать')}
      actions={low.length > 0 && <button className="btn" data-tour="ord.export" onClick={exportOrder}><span className="ic"><LuDownload size={16} /></span> {t('Выгрузить заявку')}</button>}
    >
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
