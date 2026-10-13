import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LuCircleDollarSign, LuPackagePlus, LuTruck } from 'react-icons/lu'
import Layout from '../components/Layout'
import { useToast } from '../components/ui'
import { api } from '../db/api'
import { money, onChanged } from '../db/store'
import { useT } from '../lib/i18n'

// ── Долги поставщикам ──
// Сводка одним экраном: сколько аптека должна всего, сколько приходов оформлено
// в долг и кому сколько. Числа считает сервер (в программе без связи — сама касса
// по своим данным), карточка ведёт в «Поставщиков», где долг гасится.

export default function SupplierDebts() {
  const t = useT()
  const toast = useToast()
  const [svodka, setSvodka] = useState(null)

  const load = useCallback(async () => {
    try {
      setSvodka(await api.get('/suppliers/debts'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }, [toast])
  useEffect(() => {
    load()
  }, [load])
  // Долг меняется приходом в долг и оплатой — перечитываем по любому из них
  useEffect(() => onChanged((keys) => keys.some((k) => ['suppliers', 'arrivals', 'supplierPayments'].includes(k)) && load()), [load])

  const s = svodka || { total: 0, arrivals: 0, suppliers: [] }

  return (
    <Layout title={t('Долги поставщикам')} subtitle={`${t('Всего должны')}: ${money(s.total)}`}>
      <div className="mini-cards supd-cards" data-tour="supd.cards">
        <div className="mini-card">
          <div className="m-label">{t('Всего должны')}</div>
          <div className="m-value" style={{ color: s.total > 0 ? 'var(--danger)' : undefined }}>{money(s.total)}</div>
        </div>
        <div className="mini-card">
          <div className="m-label">{t('Приходов в долг')}</div>
          <div className="m-value"><span className="ic supd-ic"><LuPackagePlus size={16} /></span>{s.arrivals}</div>
        </div>
        <div className="mini-card">
          <div className="m-label">{t('Поставщиков с долгом')}</div>
          <div className="m-value"><span className="ic supd-ic"><LuTruck size={16} /></span>{s.suppliers.length}</div>
        </div>
      </div>

      <div className="panel mt" data-tour="supd.grid">
        <h2><span className="h2-title"><span className="ic"><LuCircleDollarSign size={17} /></span>{t('Кому сколько')}</span></h2>
        {svodka && s.suppliers.length === 0 && (
          <div className="empty">{t('Долгов нет — все приходы оплачены.')}</div>
        )}
        <div className="supd-grid">
          {s.suppliers.map((p) => (
            <Link key={p.id} to="/suppliers" className="supd-card" title={t('Открыть поставщиков')}>
              <span className="supd-name">{p.name}</span>
              <b className="supd-debt">{money(p.debt)}</b>
              <span className="tag-cat">{p.arrivals} {t('приход(ов)')}</span>
            </Link>
          ))}
        </div>
        {s.suppliers.length > 0 && (
          <div className="tag-cat" style={{ marginTop: 12 }}>
            {t('Долг гасится в разделе «Поставщики» — кнопкой «Оплатить» у поставщика.')}
          </div>
        )}
      </div>
    </Layout>
  )
}
