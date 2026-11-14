import { LuWifiOff, LuCloudUpload, LuTriangleAlert } from 'react-icons/lu'
import { useConnection, money } from '../db/store'
import { useOfflineSales, dismissRejected } from '../lib/offlineSales'
import { isDesktop } from '../lib/desktop'
import { fmtDateTime } from '../lib/time'
import { useT } from '../lib/i18n'
import './OfflineBar.css'

// ── Полоса «нет связи» сайта и чеки, проданные без неё (14.11.2026) ──
// Касса сайта продаёт и без интернета: чек ложится в очередь браузера и уходит сам,
// когда связь вернётся (lib/offlineSales.js). Здесь кассир видит, что происходит:
// нет связи и сколько чеков ждут; связь вернулась — чеки уходят; сервер чек не принял —
// какой и почему (кнопка «Понятно» убирает его из списка).
// В программе для Windows полосы нет: касса там работает без интернета своим путём, а что
// ушло на сервер, видно в «Настройках»
export default function OfflineBar() {
  const conn = useConnection()
  const q = useOfflineSales()
  const t = useT()
  if (isDesktop) return null
  const offline = conn === 'error'
  const mine = q.pending - q.others
  return (
    <>
      {offline && (
        <div className="conn-banner offline" data-testid="offline-bar" role="status">
          <span className="ic"><LuWifiOff size={15} /></span>
          {q.pending > 0 ? (
            <>
              <b data-testid="offline-count">{t('Нет связи — чеков ждут отправки')}: {q.pending}.</b>
              <span>{t('Касса продаёт, чеки уйдут на сервер сами, когда появится интернет')}</span>
            </>
          ) : (
            <span>{t('Нет связи с интернетом — касса продаёт, чеки уйдут на сервер сами, когда связь вернётся')}</span>
          )}
        </div>
      )}
      {!offline && q.pending > 0 && (
        <div className="conn-banner sending" data-testid="offline-sending" role="status">
          <span className="ic"><LuCloudUpload size={15} /></span>
          {mine > 0 && (
            <span>
              {t('Отправляем чеки, проданные без связи')}: {mine}
            </span>
          )}
          {q.others > 0 && (
            <span>
              {t('Чеки другого кассира, проданные без связи, уйдут, когда он войдёт')}: {q.others}
            </span>
          )}
        </div>
      )}
      {q.rejected.length > 0 && (
        <div className="conn-banner rejected" data-testid="offline-rejected" role="alert">
          {q.rejected.map((r) => (
            <div className="rej-row" key={r.opId}>
              <span className="ic"><LuTriangleAlert size={15} /></span>
              <b>
                {t('Чек, проданный без связи, не принят сервером')}: {fmtDateTime(r.createdAt)} · {money(r.payload?.sale?.total)}
              </b>
              {r.error && <span className="rej-why">— {t(r.error)}</span>}
              <button type="button" className="ok-btn" onClick={() => dismissRejected(r.opId)} data-testid="offline-rejected-ok">
                {t('Понятно')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
