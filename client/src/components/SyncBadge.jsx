import { useEffect, useState } from 'react'
import { LuCheck, LuCloudOff, LuRefreshCw, LuTriangleAlert, LuDownload } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { desktopAction, refreshDesktopStatus, useDesktopStatus } from '../db/desktopStatus'
import { useAuth } from '../db/auth'
import { money } from '../db/store'
import { fmtDate, fmtShort, serverNow } from '../lib/time'
import { useT } from '../lib/i18n'
import { badgeOf, leftText, opTitle, updateBadgeOf, updateText } from '../lib/syncStatus'
import { rejectedDetail } from '../lib/rejected'
import { Modal, useToast } from './ui'

// ── Значок состояния программы ──
// Только в программе для Windows. Касса там работает и без интернета, и человек
// за ней должен в любой момент видеть главное: сохранено ли то, что он сделал.
// Интернет пропал — чек не пропал: он лежит на этом компьютере и уйдёт сам.
//
// Значок короткий; подробности — по нажатию: когда был последний обмен, сколько
// ждёт отправки, сколько ещё можно работать без связи, когда снята копия базы,
// нет ли новой версии программы.

const ICONS = { ok: LuCheck, busy: LuRefreshCw, warn: LuCloudOff, bad: LuTriangleAlert }

export default function SyncBadge() {
  const t = useT()
  const st = useDesktopStatus()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    refreshDesktopStatus()
  }, [])

  const badge = badgeOf(st, t)
  if (!badge) return null
  const update = updateBadgeOf(st, t)
  const Icon = ICONS[badge.tone]

  return (
    <>
      <button type="button" className={'sync-badge ' + badge.tone} onClick={() => setOpen(true)} title={t('Состояние программы')} data-testid="sync-badge">
        <span className={'ic' + (badge.tone === 'busy' ? ' spin' : '')}><Icon size={15} /></span>
        <span className="sync-label">{badge.label}</span>
      </button>
      {update && (
        <button type="button" className="sync-badge busy" onClick={() => setOpen(true)} data-testid="update-badge">
          <span className="ic"><LuDownload size={15} /></span>
          <span className="sync-label">{update.label}</span>
        </button>
      )}
      {open && <StatusModal st={st} onClose={() => setOpen(false)} />}
    </>
  )
}

// Что было в отвергнутой операции: оплата, клиент, все позиции. В журналах кассы её
// уже нет — разобрать её владелец может только здесь
function RejectedDetail({ r }) {
  const t = useT()
  const { facts, lines } = rejectedDetail(r, t, money, { when: fmtShort, day: fmtDate })
  if (!facts.length && !lines.length) return null
  return (
    <details className="rej-detail" data-testid="rejected-detail">
      <summary>{t('Что было в операции')}</summary>
      {facts.map((f) => (
        <div key={f.label} className="rej-line">
          <span>{f.label}</span>
          <span>{f.value}</span>
        </div>
      ))}
      {lines.map((l, n) => (
        <div key={n} className="rej-line">
          <span>{l.name}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </details>
  )
}

// Строка «подпись — значение»
function Row({ label, children, tone }) {
  return (
    <div className="total-row">
      <span>{label}</span>
      <span className={tone ? 'sync-' + tone : undefined}>{children}</span>
    </div>
  )
}

function StatusModal({ st, onClose }) {
  const t = useT()
  const toast = useToast()
  const user = useAuth()
  const isFounder = user?.role === 'founder'
  const [busy, setBusy] = useState('')
  const [rejected, setRejected] = useState([])

  // Что сервер не принял — подробности видит только владелец
  const rejectedCount = st?.rejected || 0
  useEffect(() => {
    let alive = true
    if (isFounder && rejectedCount > 0) {
      bridge.sync.rejected().then((list) => alive && setRejected(Array.isArray(list) ? list : []), () => {})
    } else setRejected([])
    return () => {
      alive = false
    }
  }, [isFounder, rejectedCount])

  // Одно действие за раз: пока идёт обмен, вторая кнопка не нажимается
  const run = (name, fn, done) => async () => {
    setBusy(name)
    const next = await desktopAction(fn)
    setBusy('')
    if (done) done(next)
  }

  const lic = st?.licence
  const backup = st?.backup || {}
  const update = st?.update || {}
  const pending = st?.pending || 0

  return (
    <Modal wide title={t('Состояние программы')} onClose={onClose}>
      <div data-testid="status-modal">
        {/* ── Главное: сохранено ли сделанное ── */}
        <div className={'note ' + (st?.online ? 'info' : 'warn')} style={{ marginBottom: 12 }}>
          {st?.online
            ? pending > 0
              ? t('Связь с сервером есть. Сделанное на этой кассе отправляется.')
              : t('Связь с сервером есть. Всё, что сделано на этой кассе, отправлено.')
            : t('Связи с сервером нет. Касса работает: чеки сохраняются на этом компьютере и уйдут на сервер сами, когда появится интернет.')}
        </div>
        {/* Часам компьютера верить нельзя, а сервер ещё не ответил: время в чеках неточное */}
        {st?.clockDoubt && (
          <div className="note warn" style={{ marginBottom: 12 }} data-testid="clock-doubt">
            {t('Дата и время на этом компьютере неверные: они раньше того, что программа уже видела, или слишком далеко впереди. Время в чеках может быть неточным. Поправьте дату и время на компьютере — программа возьмёт их сразу. Когда появится связь, время сверится с сервером.')}
          </div>
        )}
        {/* Время идёт по часам компьютера и с сервером не сверено. Показываем его: если в
            дате опечатка, человек должен её увидеть — и поправить, не дожидаясь связи */}
        {st?.clockUnsure && !st?.clockDoubt && (
          <div className="note info" style={{ marginBottom: 12 }} data-testid="clock-unsure">
            {t('Время программы взято с часов этого компьютера и с сервером не сверено. Сейчас на них')}: {fmtShort(serverNow())}.{' '}
            {t('Если дата или время неверные, поправьте их на компьютере.')}
          </div>
        )}

        <Row label={t('Ждут отправки')} tone={pending > 0 ? 'warn' : 'ok'}>{pending > 0 ? pending : t('ничего')}</Row>
        <Row label={t('Последний обмен с сервером')}>{st?.syncedAt ? fmtShort(st.syncedAt) : '—'}</Row>
        {st?.blocked && pending > 0 && (
          <div className="note warn" style={{ margin: '8px 0' }}>
            {t('Часть чеков пробил сотрудник, чей вход на этом компьютере больше не действует. Они уйдут на сервер, когда войдёт он сам или владелец.')}
          </div>
        )}
        {st?.refused && (
          <div className="note err" style={{ margin: '8px 0' }}>
            {t('Сервер на связи, но данные с этой кассы не принимает. Чеки целы и ждут. Обновите программу или обратитесь к поставщику.')}
            <div className="tag-cat" style={{ marginTop: 4 }}>{st.refused}</div>
          </div>
        )}
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn ghost" disabled={!!busy} onClick={run('sync', () => bridge.sync.now())}>
            {busy === 'sync' ? t('Обмен…') : t('Обменяться сейчас')}
          </button>
        </div>

        {/* ── Не принято сервером ── */}
        {rejectedCount > 0 && (
          <div className="sync-section">
            <h4>{t('Не принято сервером')} <span className="badge low">{rejectedCount}</span></h4>
            {!isFounder && <div className="note err">{t('Сервер не принял часть операций этой кассы. Сообщите владельцу — он увидит подробности.')}</div>}
            {isFounder && (
              <div className="tag-cat" style={{ marginBottom: 8 }}>
                {t('Эти операции сняты с учёта: в журналах кассы их нет, а остаток и долг — как на сервере. Если операция была настоящей, оформите её заново.')}
              </div>
            )}
            {isFounder &&
              rejected.map((r) => (
                <div key={r.id} className="rash-row">
                  <div className="rash-main">
                    <div className="rash-title">
                      {opTitle(r.type, t)}
                      {r.sum !== null && r.sum !== undefined ? ` · ${money(r.sum)}` : ''}
                    </div>
                    {r.title && <div className="rash-what">{r.title}</div>}
                    <div className="tag-cat">{fmtShort(r.createdAt)}{r.by ? ` · ${r.by}` : ''}</div>
                    <div className="tag-cat sync-bad">{t(r.error)}</div>
                    <RejectedDetail r={r} />
                  </div>
                  <button
                    className="btn ghost"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy('dismiss')
                      const ok = await bridge.sync.dismiss(r.id).catch(() => false)
                      setBusy('')
                      if (ok) setRejected((cur) => cur.filter((x) => x.id !== r.id))
                      else toast(t('Не получилось. Повторите.'), 'err')
                    }}
                  >
                    {t('Разобрался')}
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* ── Сколько можно работать без связи ── */}
        {lic && (
          <div className="sync-section">
            <h4>{t('Работа без связи')}</h4>
            <Row label={t('Без связи программа работает')}>{lic.offlineDays} {t('дн.')}</Row>
            <Row label={t('Сервер подтвердил подписку')}>{lic.checkedAt ? fmtShort(lic.checkedAt) : '—'}</Row>
            <Row label={t('Без связи можно работать ещё')} tone={lic.expired ? 'bad' : lic.warn ? 'warn' : undefined}>
              {leftText(lic.leftMs, t)}
              {lic.until ? ` (${t('до')} ${fmtShort(lic.until)})` : ''}
            </Row>
            {(st?.clockDoubt || st?.clockUnsure) && (
              <div className="tag-cat" style={{ marginTop: 4 }}>
                {t('Пока время не сверено с сервером, срок уменьшается и за время, пока компьютер был выключен. Сколько именно, программе узнать не у кого — она считает по тому, как этот компьютер работает обычно.')}
              </div>
            )}
            {lic.warn && !lic.expired && !st?.online && (
              <div className="note warn" style={{ marginTop: 6 }}>
                {t('Подключите интернет хотя бы на минуту — программа проверит подписку, и срок начнётся заново.')}
              </div>
            )}
          </div>
        )}

        {/* ── Копия базы ── */}
        <div className="sync-section">
          <h4>{t('Копия базы')}</h4>
          {st?.restored && (
            <div className="note err" style={{ marginBottom: 8 }}>
              {st.restored.from
                ? `${t('Файл базы был повреждён, и программа подняла её из копии от')} ${fmtShort(st.restored.from)}. ${t('Чеки, пробитые после этой копии и не ушедшие на сервер, могли пропасть — сверьте кассу.')}`
                : t('Файл базы был повреждён, а копии не нашлось: данные загружены с сервера заново. Чеки, не ушедшие на сервер, пропали — сверьте кассу.')}
            </div>
          )}
          <Row label={t('Последняя копия')} tone={backup.at ? undefined : 'warn'}>{backup.at ? fmtShort(backup.at) : t('ещё не снималась')}</Row>
          <div className="tag-cat">{t('Программа сама снимает копию раз в сутки и хранит семь последних.')}</div>
          {backup.error && <div className="note err" style={{ marginTop: 6 }}>{t('Копию снять не удалось')}: {backup.error}</div>}
          {backup.skipped?.length > 0 && (
            <div className="note warn" style={{ marginTop: 6 }}>
              {t('В последнюю копию не попали базы')}: {backup.skipped.join(', ')}. {t('Файл такой базы повреждён или занят. Её прежняя копия сохранена.')}
            </div>
          )}
          {isFounder && (
            <Row label={t('Вторая папка для копий')} tone={backup.extraOk === false ? 'bad' : undefined}>
              {backup.extraDir || t('не выбрана')}
              {backup.extraOk === false ? ` — ${t('недоступна')}` : ''}
            </Row>
          )}
          {isFounder && !backup.extraDir && (
            <div className="tag-cat">{t('Копия на том же диске спасает от испорченного файла, но не от сломанного диска. Выберите папку на другом диске или флешке.')}</div>
          )}
          <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button className="btn ghost" disabled={!!busy} onClick={run('backup', () => bridge.backup.now(), (next) => next && !next.backup?.error && toast(t('Копия снята')))}>
              {busy === 'backup' ? t('Снимаем копию…') : t('Снять копию сейчас')}
            </button>
            {isFounder && (
              <button className="btn ghost" disabled={!!busy} onClick={run('folder', () => bridge.backup.chooseFolder())}>
                {t('Выбрать вторую папку')}
              </button>
            )}
            {isFounder && backup.extraDir && (
              <button className="btn ghost" disabled={!!busy} onClick={run('clear', () => bridge.backup.clearFolder())}>
                {t('Убрать вторую папку')}
              </button>
            )}
            {isFounder && (
              <button className="btn ghost" disabled={!!busy} onClick={() => bridge.backup.open().catch(() => {})}>
                {t('Открыть папку с копиями')}
              </button>
            )}
          </div>
        </div>

        {/* ── Обновление ── */}
        <div className="sync-section">
          <h4>{t('Обновление программы')}</h4>
          <Row label={t('Версия программы')}>{st?.version || '—'}</Row>
          <div className={update.state === 'ready' ? 'note info' : 'tag-cat'} style={{ margin: '6px 0' }}>{updateText(update, t)}</div>
          <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {update.state === 'ready' && (
              <button
                className="btn"
                disabled={!!busy}
                onClick={async () => {
                  setBusy('install')
                  const ok = await bridge.update.install().catch(() => false)
                  if (!ok) {
                    setBusy('')
                    toast(t('Не получилось. Повторите.'), 'err')
                  }
                }}
              >
                {busy === 'install' ? t('Перезапускаем…') : t('Перезапустить и обновить')}
              </button>
            )}
            {update.state && update.state !== 'off' && update.state !== 'ready' && (
              <button className="btn ghost" disabled={!!busy || update.state !== 'idle'} onClick={run('check', () => bridge.update.check())}>
                {busy === 'check' ? t('Проверяем…') : t('Проверить обновление')}
              </button>
            )}
          </div>
        </div>

        {/* ── Для поддержки ── */}
        {isFounder && (
          <div className="sync-section">
            <h4>{t('Если данные на кассе выглядят неверно')}</h4>
            <div className="tag-cat">{t('Программа заново загрузит с сервера товары, остатки и журналы. Сделанное на этой кассе не потеряется: оно сначала уйдёт на сервер.')}</div>
            <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
              <button
                className="btn ghost"
                disabled={!!busy || !st?.online}
                onClick={run('resync', () => bridge.sync.resync(), (next) => toast(next?.online ? t('Данные загружены заново') : t('Не получилось. Повторите.'), next?.online ? 'ok' : 'err'))}
              >
                {busy === 'resync' ? t('Загружаем…') : t('Загрузить всё заново')}
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('Закрыть')}</button>
        </div>
      </div>
    </Modal>
  )
}
