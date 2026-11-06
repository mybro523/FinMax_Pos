// ── Кассы магазина без интернета (1.7.0): «Настройки» → «Кассы и устройства» ──
// Главный компьютер — тот, где завели магазин: здесь хранится база, к нему подключаются кассы.
// На главном — список касс (кто на связи), код подключения новой кассы и «Отключить». На кассе —
// связь с главным, сколько своего он ещё не принял, и «Подключить заново», если главный
// отключил кассу или загрузил копию базы. Всё делает основная часть программы
// (desktop/src/gateway.mjs); окно спрашивает и показывает
import { useEffect, useState } from 'react'
import { LuMonitor, LuNetwork, LuPlus, LuRefreshCw, LuShieldAlert, LuStore, LuX } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { refreshDesktopStatus, useDesktopStatus } from '../db/desktopStatus'
import { useT } from '../lib/i18n'
import { fmtShort } from '../lib/time'
import { lanErrorText } from '../lib/lanStatus'
import { mainProblemText, pairLeft, REJOIN } from '../lib/kassy'
import { JoinCard } from './BezInterneta'
import { useDialog, useToast } from './ui'

// ── На экране кассы: главный компьютер её больше не принимает ──
// Кассир работает дальше (продажи сохраняются здесь), но должен сказать владельцу: без нового
// подключения сделанное на кассе на главный не попадёт
export function RegisterAlert() {
  const t = useT()
  const st = useDesktopStatus()
  const m = st?.net?.role === 'register' ? st.net.main : null
  if (!m || !REJOIN.has(m.error)) return null
  return (
    <div className="note warn" role="status" data-testid="register-alert">
      {t('Касса отключена от главного компьютера. Продажи сохраняются здесь — скажите владельцу: кассу нужно подключить заново.')}
    </div>
  )
}

export default function SoloKassyPanel() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const st = useDesktopStatus()
  const net = st?.net
  const [busy, setBusy] = useState('')
  const [now, setNow] = useState(Date.now())
  const [rejoin, setRejoin] = useState(false)

  // Кто на связи, меняется само: пока раздел открыт — спрашиваем каждые 5 секунд; код
  // подключения — отсчёт по секундам
  useEffect(() => {
    refreshDesktopStatus()
    const every = setInterval(() => refreshDesktopStatus(), 5000)
    return () => clearInterval(every)
  }, [])
  const pairing = net?.pairing
  // Сколько коду осталось, главный присылает сам: часы окна и программы могут расходиться
  const [deadline, setDeadline] = useState(0)
  const leftMs = pairing?.leftMs
  const pairCode = pairing?.code
  useEffect(() => {
    setDeadline(pairCode && Number.isFinite(leftMs) ? Date.now() + leftMs : 0)
    setNow(Date.now())
  }, [pairCode, leftMs])
  useEffect(() => {
    if (!pairing) return undefined
    const every = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(every)
  }, [pairing])

  if (!bridge?.standalone?.pairStart || !net) return null

  async function act(name, fn) {
    setBusy(name)
    try {
      const r = await fn()
      await refreshDesktopStatus()
      if (r?.error) toast(t(r.error), 'err')
      return r
    } catch {
      toast(t('Не получилось. Повторите.'), 'err')
      return null
    } finally {
      setBusy('')
    }
  }

  const firewall = (
    <div className="note info lan-firewall">
      <LuShieldAlert size={15} style={{ verticalAlign: '-3px' }} />{' '}
      {t('Если Windows спросит, разрешить ли FinMax POS доступ к сети, отметьте обе галочки — «Частные сети» и «Общедоступные сети» — и нажмите «Разрешить доступ». Кассы, соединённые кабелем напрямую, Windows считает общедоступной сетью.')}
    </div>
  )
  const addresses = st?.lan?.addresses || []

  // ── Касса магазина ──
  if (net.role === 'register') {
    const m = net.main || {}
    const problem = mainProblemText(m.error, t) || (!m.online && m.error ? lanErrorText(m.error, t) : '')
    return (
      <div className="panel mt" style={{ maxWidth: 720 }} data-testid="solo-kassy">
        <h2>
          <span className="h2-title"><span className="ic"><LuNetwork size={17} /></span>{t('Касса магазина')}</span>
          <span className={'badge ' + (m.online ? 'ok' : 'low')}>{m.online ? t('на связи') : t('нет связи')}</span>
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
          {t('Этот компьютер — касса магазина. Базу он получает от главного компьютера и отправляет туда всё сделанное. Без связи с главным касса работает как обычно: сделанное уйдёт, когда связь вернётся.')}
        </p>
        <div className="solo-rows">
          <div><span>{t('Эта касса')}</span><b>{net.name || '—'}</b></div>
          <div><span>{t('Главный компьютер')}</span><b>{m.name || t('Главный компьютер')}{m.address ? ` · ${m.address}${m.port && m.port !== 47810 ? ':' + m.port : ''}` : ''}</b></div>
          <div>
            <span>{t('Связь с главным')}</span>
            <b>{m.online ? t('на связи') : m.seenAt ? `${t('последний обмен')} ${fmtShort(m.seenAt)}` : t('нет связи')}</b>
          </div>
          <div><span>{t('Ждут главного')}</span><b>{net.pending > 0 ? net.pending : t('ничего')}</b></div>
        </div>
        {problem && <div className="note warn" style={{ marginBottom: 12 }} data-testid="solo-main-problem">{problem}</div>}
        {rejoin ? (
          <JoinCard
            again
            compact
            onBack={() => setRejoin(false)}
            onDone={(r) => {
              setRejoin(false)
              refreshDesktopStatus()
              toast(`${t('Касса подключена заново')}: ${r.name || ''}`)
            }}
          />
        ) : (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button className="btn ghost" disabled={!!busy} onClick={() => act('now', () => bridge.lan.now())}>
              <span className={'ic' + (busy === 'now' ? ' spin' : '')}><LuRefreshCw size={16} /></span> {busy === 'now' ? t('Обмен…') : t('Обменяться с главным сейчас')}
            </button>
            <button className={'btn ' + (REJOIN.has(m.error) ? 'gold' : 'ghost')} disabled={!!busy} onClick={() => setRejoin(true)} data-testid="solo-rejoin">
              <span className="ic"><LuStore size={16} /></span> {t('Подключить заново')}
            </button>
          </div>
        )}
        {firewall}
      </div>
    )
  }

  // ── Главный компьютер ──
  const regs = net.registers || []
  const on = regs.filter((r) => r.online).length
  const left = pairing ? pairLeft(deadline, now) : ''
  const unpair = async (r) => {
    const ok = await dialog.confirm({
      title: `${t('Отключить кассу')} «${r.name}»?`,
      message: t('Эта касса больше не будет обмениваться с главным компьютером. Подключить её снова можно новым кодом — то, что она сделала без связи, придёт сюда при подключении.'),
      confirmText: t('Отключить'),
    })
    if (ok) await act('unpair:' + r.deviceId, () => bridge.standalone.unpair(r.deviceId))
  }
  return (
    <div className="panel mt" style={{ maxWidth: 720 }} data-testid="solo-kassy">
      <h2>
        <span className="h2-title"><span className="ic"><LuNetwork size={17} /></span>{t('Кассы магазина')}</span>
        {regs.length > 0 && <span className={'badge ' + (on > 0 ? 'ok' : 'low')}>{`${t('на связи')}: ${on} ${t('из')} ${regs.length}`}</span>}
      </h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Этот компьютер — главный: здесь хранится база магазина. Другие компьютеры подключаются к нему кассами по сети (кабелем или через роутер) и работают и без связи с ним — сделанное придёт сюда, когда связь вернётся. Интернет не нужен.')}
      </p>
      <div className="lan-peers">
        <div className="lan-peer on">
          <span className="lan-peer-ic"><LuMonitor size={17} /></span>
          <div className="lan-peer-main">
            <b>{t('Этот компьютер')}</b>
            <div className="tag-cat">{t('главный компьютер магазина')}</div>
          </div>
        </div>
        {regs.map((r) => (
          <div key={r.deviceId} className={'lan-peer' + (r.online ? ' on' : '')} data-testid="solo-register">
            <span className="lan-peer-ic"><LuMonitor size={17} /></span>
            <div className="lan-peer-main">
              <b>{r.name}</b>
              <div className="tag-cat">
                {r.stopped
                  ? <span className="sync-bad">{t('остановлена: касс больше, чем в коде активации')}</span>
                  : r.error === 'version'
                  ? [r.host, t('другая версия программы — обновите её на этой кассе')].filter(Boolean).join(' · ')
                  : [r.host, r.online ? t('на связи') : r.seenAt ? `${t('последний обмен')} ${fmtShort(r.seenAt)}` : t('ещё не выходила на связь')].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className={'lan-dot' + (r.online ? ' on' : '')} aria-label={r.online ? t('на связи') : t('нет связи')} />
            <button className="btn ghost sm" disabled={!!busy} onClick={() => unpair(r)} title={t('Отключить кассу')}>
              {t('Отключить')}
            </button>
          </div>
        ))}
      </div>
      {regs.length === 0 && !pairing && <div className="tag-cat" style={{ marginBottom: 10 }}>{t('Касс пока нет: магазин работает на одном этом компьютере.')}</div>}
      {/* 1.7.1: число касс — по коду активации (вместе с главным); в пробный срок — без ограничения */}
      {net.limit !== undefined && (
        <div className="tag-cat" style={{ marginBottom: 10 }} data-testid="solo-kassy-limit">
          {net.limit === null
            ? t('Касс можно подключить сколько угодно, пока идёт пробный срок; потом — сколько в коде активации.')
            : `${t('По коду активации касс всего')}: ${net.limit + 1} — ${t('вместе с главным компьютером')}.`}
        </div>
      )}
      {regs.some((r) => r.stopped) && (
        <div className="note warn" style={{ marginBottom: 12 }} data-testid="solo-kassy-stopped">
          {t('Касс подключено больше, чем разрешает код активации: лишние остановлены. Отключите ненужную кассу или попросите у поставщика код на большее число касс.')}
        </div>
      )}
      {net.lanError && (
        <div className="note warn" style={{ marginBottom: 12 }}>
          {t('Входящие подключения на этом компьютере не открылись: кассы не смогут до него дозвониться. Перезапустите программу; если не поможет — проверьте, не занят ли порт другой программой.')}
        </div>
      )}

      {pairing && left ? (
        <div className="pair-box" data-testid="solo-pair-box">
          <div className="tag-cat">{t('Код подключения')}</div>
          <div className="pair-code" data-testid="solo-pair-code">{pairing.code}</div>
          <div className="tag-cat" style={{ lineHeight: 1.6 }}>
            {t('На новой кассе запустите программу, нажмите «Это касса магазина — подключить к главному компьютеру» и введите этот код.')}{' '}
            {t('Код действует ещё')} <b>{left}</b>.
          </div>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn ghost" disabled={!!busy} onClick={() => act('stop', () => bridge.standalone.pairStop())}>
              <span className="ic"><LuX size={16} /></span> {t('Отменить код')}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn gold" disabled={!!busy} onClick={() => act('start', () => bridge.standalone.pairStart())} data-testid="solo-pair-start">
            <span className="ic"><LuPlus size={16} /></span> {busy === 'start' ? t('Открываем…') : t('Подключить кассу')}
          </button>
        </div>
      )}

      {addresses.length > 0 && (
        <div className="lan-here tag-cat">
          {t('Адрес этого компьютера в сети')}: <b>{addresses.join(', ')}</b> · {t('его вписывают на кассе, если она не находит главный компьютер сама')}
        </div>
      )}
      {firewall}
    </div>
  )
}
