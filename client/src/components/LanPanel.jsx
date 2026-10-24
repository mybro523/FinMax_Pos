import { useState } from 'react'
import { LuNetwork, LuPlus, LuRefreshCw, LuTrash2, LuMonitor, LuShieldAlert } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { refreshDesktopStatus, useDesktopStatus } from '../db/desktopStatus'
import { useT } from '../lib/i18n'
import { fmtShort } from '../lib/time'
import { lanErrorText, lanOnline, lanPeerLine } from '../lib/lanStatus'
import { useToast } from './ui'

// ── Кассы в местной сети ──
// Только в программе для Windows. Кассы одного магазина, стоящие в одной сети (кабель,
// роутер), передают друг другу сделанное без интернета: продажа кассира появляется на
// компьютере владельца, приход владельца меняет остатки на кассе. Обычно кассы находят
// друг друга сами; если нет — здесь вписывают адрес соседнего компьютера.
//
// manage — можно вписывать и убирать адреса (право «Настройки: кассы и устройства»).
export default function LanPanel({ manage = false }) {
  const t = useT()
  const toast = useToast()
  const st = useDesktopStatus()
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState('')
  const lan = st?.lan

  if (!bridge?.lan) return null

  async function act(name, fn, ok) {
    setBusy(name)
    try {
      const r = await fn()
      await refreshDesktopStatus()
      if (ok) ok(r)
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
    } finally {
      setBusy('')
    }
  }

  const add = () =>
    act('add', () => bridge.lan.add(address.trim()), (r) => {
      if (r?.ok) {
        setAddress('')
        toast(t('Адрес добавлен. Программа пробует связаться.'))
      } else if (r?.error === 'address') toast(t('Адрес не похож на адрес компьютера. Пример: 192.168.1.10'), 'err')
      else if (r?.error === 'nokey') toast(t('Сначала нужна связь с сервером: он выдаёт кассам ключ магазина.'), 'err')
      else toast(t('Не получилось. Повторите.'), 'err')
    })

  const peers = lan?.peers || []
  const manual = lan?.manual || []
  const online = lanOnline(lan)

  return (
    <div className="panel mt" data-tour="set.lan" style={{ maxWidth: 720 }}>
      <h2>
        <span className="h2-title"><span className="ic"><LuNetwork size={17} /></span>{t('Кассы в местной сети')}</span>
        {lan?.enabled && <span className={'badge ' + (online > 0 ? 'ok' : 'low')}>{online > 0 ? `${t('на связи')}: ${online}` : t('нет связи')}</span>}
      </h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Кассы магазина, подключённые к одной сети (кабелем или через роутер), передают друг другу продажи, возвраты, приходы, смены, товары и правки и без интернета. Когда интернет появится, каждая касса сама отправит своё на сервер — ничего не задвоится.')}
      </p>

      {!lan?.enabled && (
        <div className="note info" style={{ marginBottom: 12 }}>
          {t('Обмен включится сам, когда у магазина появится вторая касса с программой. Можно включить и сразу — вписав адрес второго компьютера ниже.')}
        </div>
      )}

      {lan?.enabled && lan.error && (
        <div className="note warn" style={{ marginBottom: 12 }}>
          {t('Входящие подключения на этом компьютере не открылись. Он сам будет звонить соседям, а они ему — нет.')}
        </div>
      )}

      {lan?.fromPeers > 0 && (
        <div className="tag-cat" style={{ marginBottom: 10 }}>
          {t('Операций соседних касс, которых сервер ещё не видел')}: <b>{lan.fromPeers}</b>
        </div>
      )}

      {peers.length > 0 && (
        <div className="lan-peers">
          {peers.map((p) => (
            <div key={p.deviceId} className={'lan-peer' + (p.online ? ' on' : '')}>
              <span className="lan-peer-ic"><LuMonitor size={17} /></span>
              <div className="lan-peer-main">
                <b>{p.name || t('Касса')}</b>
                <div className="tag-cat">{lanPeerLine(p, t, fmtShort)}</div>
                {!p.online && p.error && <div className="tag-cat sync-warn">{lanErrorText(p.error, t)}</div>}
              </div>
              <span className={'lan-dot' + (p.online ? ' on' : '')} aria-label={p.online ? t('на связи') : t('нет связи')} />
            </div>
          ))}
        </div>
      )}
      {lan?.enabled && peers.length === 0 && (
        <div className="tag-cat" style={{ marginBottom: 10 }}>{t('Соседние кассы пока не найдены. Включите программу на втором компьютере и проверьте, что оба подключены к одной сети.')}</div>
      )}

      {manage && (
        <>
          <h3 className="lan-sub">{t('Адрес соседнего компьютера вручную')}</h3>
          <div className="tag-cat" style={{ marginBottom: 8 }}>
            {t('Если кассы не нашли друг друга сами, впишите адрес второго компьютера (его видно в его настройках, в этом же разделе) или его имя в сети.')}
          </div>
          <div className="row" style={{ alignItems: 'flex-end', maxWidth: 520 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="lanAddr">{t('Адрес или имя компьютера')}</label>
              <input id="lanAddr" value={address} maxLength={100} placeholder="192.168.1.10" onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && address.trim() && add()} />
            </div>
            <button className="btn" style={{ marginBottom: 14 }} disabled={!address.trim() || !!busy} onClick={add}>
              <span className="ic"><LuPlus size={16} /></span> {busy === 'add' ? t('Связываемся…') : t('Добавить')}
            </button>
          </div>
          {manual.map((m) => (
            <div key={m.address} className="lan-manual">
              <span><b>{m.address}</b>{m.error ? <span className="tag-cat sync-warn"> · {lanErrorText(m.error, t)}</span> : null}</span>
              <button className="btn ghost sm icon" title={t('Убрать')} aria-label={`${t('Убрать')}: ${m.address}`} disabled={!!busy} onClick={() => act('rm', () => bridge.lan.remove(m.address))}>
                <LuTrash2 size={15} />
              </button>
            </div>
          ))}
        </>
      )}

      {lan?.addresses?.length > 0 && (
        <div className="lan-here tag-cat">
          {t('Адрес этого компьютера в сети')}: <b>{lan.addresses.join(', ')}</b>
          {lan.enabled ? (lan.listening ? ` · ${t('принимает подключения на порту')} ${lan.port}` : ` · ${t('сам звонит соседям')}`) : ''}
          {lan.enabled && lan.search ? ` · ${t('поиск в сети включён')}` : ''}
        </div>
      )}

      <div className="note info lan-firewall">
        <LuShieldAlert size={15} style={{ verticalAlign: '-3px' }} />{' '}
        {t('Если Windows спросит, разрешить ли FinMax POS доступ к сети, нажмите «Разрешить доступ». Достаточно разрешить хотя бы на одном из компьютеров.')}
      </div>

      {lan?.enabled && (
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn ghost" disabled={!!busy} onClick={() => act('now', () => bridge.lan.now())}>
            <span className={'ic' + (busy === 'now' ? ' spin' : '')}><LuRefreshCw size={16} /></span> {busy === 'now' ? t('Обмен…') : t('Обменяться с кассами сейчас')}
          </button>
        </div>
      )}
    </div>
  )
}
