import { useCallback, useEffect, useState } from 'react'
import { LuMonitor, LuPencil } from 'react-icons/lu'
import { api } from '../db/api'
import { money, onChanged } from '../db/store'
import { fmtShort } from '../lib/time'
import { useT } from '../lib/i18n'
import { useDialog, useToast } from './ui'

// ── Кассы магазина ──
// Программа для Windows на каждом компьютере — отдельная касса: со своей сменой
// и своей очередью чеков, которые уходят на сервер, когда есть интернет. Сервер
// называет кассы сам («Касса 1», «Касса 2»); владелец может назвать по-своему —
// это имя видно в истории смен и в расхождениях.
//
// Раздел появляется, когда есть хотя бы одна касса: магазину, который работает
// только через сайт, он ни к чему.
export default function DevicesPanel() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [list, setList] = useState([])

  const load = useCallback(async () => {
    try {
      const rows = await api.get('/sync/devices')
      setList(Array.isArray(rows) ? rows : [])
    } catch {
      /* связи нет или сервер прежней версии — раздел просто не показывается */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => onChanged((keys) => keys.includes('devices') && load()), [load])

  async function rename(d) {
    const r = await dialog.prompt({
      title: t('Переименовать кассу'),
      message: t('Имя кассы видно в истории смен и в расхождениях.'),
      fields: [{ name: 'name', label: t('Название кассы'), defaultValue: d.name }],
      confirmText: t('Переименовать'),
    })
    const name = r?.name?.trim()
    if (!name || name === d.name) return
    try {
      const saved = await api.patch(`/sync/devices/${d.id}`, { name })
      setList((cur) => cur.map((x) => (x.id === d.id ? { ...x, ...saved } : x)))
      toast(t('Касса переименована'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // Смену кассы обычно закрывает сама касса. Но компьютер может сломаться, программу
  // могут переустановить — и смена осталась бы открытой навсегда. Тогда её закрывает
  // владелец. Сумму «по факту» не вводят (17.11.2026): её считает сервер, она равна ожидаемой
  async function closeShift(d) {
    const ok = await dialog.confirm({
      title: `${t('Закрыть смену')}: ${d.name}`,
      message: `${t('Закрывайте смену отсюда, только если сама касса закрыть её уже не может: компьютер сломался или программу переустановили. Чеки, которые касса ещё пришлёт, попадут в итоги этой смены.')} ${t('Сумма по факту считается сама и равна ожидаемой.')}`,
      confirmText: t('Закрыть смену'),
      danger: true,
    })
    if (!ok) return
    try {
      // Суммы в запросе нет: факт сервер считает сам (server/src/shifts/totals.ts)
      const closed = await api.post(`/sync/devices/${d.id}/close-shift`, {})
      setList((cur) => cur.map((x) => (x.id === d.id ? { ...x, openShift: null } : x)))
      toast(`${t('Смена закрыта')}. ${t('В кассе')}: ${money(closed.expectedCash)}`)
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  if (!list.length) return null

  return (
    <div className="panel mt" style={{ maxWidth: 640 }} data-testid="devices">
      <h2><span className="h2-title"><span className="ic"><LuMonitor size={17} /></span>{t('Кассы')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Компьютеры, на которых стоит программа для Windows. У каждой кассы своя смена; чеки, пробитые без интернета, уходят на сервер сами.')}
      </p>
      {/* На телефоне — карточками: название и «Переименовать» сверху, остальное подписями ниже */}
      <table className="table-cards set-list">
        <thead>
          <tr><th>{t('Касса')}</th><th>{t('Была на связи')}</th><th>{t('Кто работал')}</th><th>{t('Смена')}</th><th>{t('Версия')}</th><th></th></tr>
        </thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.id} data-device={d.id}>
              <td className="cell-main" data-label={t('Касса')}><b>{d.name}</b></td>
              <td data-label={t('Была на связи')}>{fmtShort(d.lastSeenAt)}</td>
              <td data-label={t('Кто работал')}>{d.lastLogin || '—'}</td>
              <td data-label={t('Смена')}>
                {d.openShift ? (
                  // Одной обёрткой: в карточке время и «Закрыть смену» стоят вместе справа от подписи
                  <div className="dev-smena">
                    {t('открыта с')} {fmtShort(d.openShift.openedAt)}
                    <div>
                      <button className="btn ghost sm" onClick={() => closeShift(d)} data-testid="close-device-shift">{t('Закрыть смену')}</button>
                    </div>
                  </div>
                ) : (
                  '—'
                )}
              </td>
              <td data-label={t('Версия')}>{d.appVersion || '—'}</td>
              <td className="num cell-actions">
                <button className="btn ghost sm" onClick={() => rename(d)} title={t('Переименовать')} aria-label={t('Переименовать')}>
                  <LuPencil size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
