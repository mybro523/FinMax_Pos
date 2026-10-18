import { useCallback, useEffect, useState } from 'react'
import { LuCircleDollarSign, LuPackagePlus, LuTruck } from 'react-icons/lu'
import { useToast } from '../components/ui'
import { api } from '../db/api'
import { money, onChanged } from '../db/store'
import { useT } from '../lib/i18n'
import { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'

// ── Долги поставщикам ──
// Вкладка раздела «Поставщики»: сколько должны всего, сколько приходов оформлено
// в долг и кому сколько. Числа считает сервер (в программе без связи — сама касса
// по своим данным); карточка открывает поставщика, где долг гасится.
//
// Это не отдельная страница: раньше «Поставщики» и «Долги поставщикам» были двумя
// плитками меню про одно и то же, и люди искали оплату не там.

// enabled — грузить ли вообще: экрану прихода сводка нужна только тому, кому
// разрешены поставщики (остальным сервер её не отдаст, а ошибка всплывала бы зря)
export function useDolgiPostavshikam({ enabled = true } = {}) {
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
    if (enabled) load()
  }, [load, enabled])
  // Долг меняется приходом в долг и оплатой — перечитываем по любому из них
  useEffect(
    () => (enabled ? onChanged((keys) => keys.some((k) => ['suppliers', 'arrivals', 'supplierPayments'].includes(k)) && load()) : undefined),
    [load, enabled],
  )

  const s = svodka || { total: 0, arrivals: 0, suppliers: [] }
  const exCols = [
    { header: t('Поставщик'), key: 'name', width: 36 },
    { header: t('Долг'), key: 'debt', width: 16, money: true },
    { header: t('Приходов в долг'), key: 'arrivals', width: 16, num: true },
  ]
  const exRows = s.suppliers.map((p) => ({ name: p.name, debt: Number(p.debt) || 0, arrivals: p.arrivals }))
  const exItogi = { name: t('Итого'), debt: Number(s.total) || 0, arrivals: s.arrivals }
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Долги поставщикам'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Долги поставщикам')}`, podzag: `${t('Всего должны')}: ${money(s.total)}`, cols: exCols, rows: exRows, itogi: exItogi })

  return { svodka, s, exCols, exRows, exItogi, exportExcel }
}

// onOpen(p) — открыть поставщика (его карточку с оплатой)
export default function SupplierDebtsPanel({ dolgi, onOpen }) {
  const t = useT()
  const { svodka, s, exCols, exRows, exItogi } = dolgi

  return (
    <>
      <PrintSheet zagolovok={t('Долги поставщикам')} podzag={`${t('Всего должны')}: ${money(s.total)}`} cols={exCols} rows={exRows} itogi={exItogi} />
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
            <button key={p.id} type="button" className="supd-card" onClick={() => onOpen?.(p)} title={t('Открыть поставщика')}>
              <span className="supd-name">{p.name}</span>
              <b className="supd-debt">{money(p.debt)}</b>
              <span className="tag-cat">{p.arrivals} {t('приход(ов)')}</span>
            </button>
          ))}
        </div>
        {s.suppliers.length > 0 && (
          <div className="tag-cat" style={{ marginTop: 12 }}>
            {t('Нажмите на карточку — откроется поставщик, где долг гасится кнопкой «Записать оплату».')}
          </div>
        )}
      </div>
    </>
  )
}
