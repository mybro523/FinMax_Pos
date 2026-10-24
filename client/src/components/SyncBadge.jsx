import { useEffect, useState } from 'react'
import { LuBadgeCheck, LuCheck, LuCloudOff, LuRefreshCw, LuTriangleAlert, LuDownload, LuNetwork } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { desktopAction, refreshDesktopStatus, useDesktopStatus } from '../db/desktopStatus'
import { useAuth } from '../db/auth'
import { money } from '../db/store'
import { fmtDate, fmtShort, serverNow } from '../lib/time'
import { useT } from '../lib/i18n'
import { badgeOf, leftText, opTitle, updateBadgeOf, updateText, versionBadgeOf } from '../lib/syncStatus'
import { rejectedDetail } from '../lib/rejected'
import { lanBadgeOf } from '../lib/lanStatus'
import { Modal, useToast } from './ui'
import LanPanel from './LanPanel'

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
  const ver = versionBadgeOf(st, t)
  // Соседние кассы в местной сети — когда у магазина их больше одной
  const lanBadge = lanBadgeOf(st, t)
  const Icon = ICONS[badge.tone]

  return (
    <>
      {ver && (
        <button type="button" className={'sync-badge ver ' + ver.tone} onClick={() => setOpen(true)} title={t('Версия программы')} data-testid="version-badge">
          <span className="ic">{ver.tone === 'busy' ? <LuDownload size={14} /> : <LuBadgeCheck size={14} />}</span>
          <span className="sync-label">{ver.label}</span>
        </button>
      )}
      <button type="button" className={'sync-badge ' + badge.tone} onClick={() => setOpen(true)} title={t('Состояние программы')} data-testid="sync-badge">
        <span className={'ic' + (badge.tone === 'busy' ? ' spin' : '')}><Icon size={15} /></span>
        <span className="sync-label">{badge.label}</span>
      </button>
      {lanBadge && (
        <button type="button" className={'sync-badge lan ' + lanBadge.tone} onClick={() => setOpen(true)} title={t('Кассы в местной сети')} data-testid="lan-badge">
          <span className="ic"><LuNetwork size={14} /></span>
          <span className="sync-label">{lanBadge.label}</span>
        </button>
      )}
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

// Что не так с копией (коды — из основной части программы, desktop/src/restore.mjs)
function problemText(code, t) {
  if (code === 'incomplete') return t('Неполная копия: в ней нет общей базы программы')
  if (code === 'noshop') return t('В копии нет базы этого магазина')
  if (code === 'broken') return t('Копия повреждена')
  if (code === 'newer') return t('Копия от более новой версии программы — сначала обновите программу')
  return ''
}

// Почему не вышло загрузить или сохранить копию
function copyErrorText(r, t) {
  const detail = r?.detail ? `: ${r.detail}` : ''
  if (r?.error === 'rights') return t('Нет прав на резервные копии')
  if (r?.error === 'gone') return t('Копия не найдена. Откройте список заново.')
  if (r?.error === 'foreign') return t('Отметьте, что тот компьютер больше не работает')
  if (r?.error === 'loss') return t('Отметьте, что понимаете: неотправленное уйдёт из программы')
  if (r?.error === 'stage') return t('Не удалось подготовить копию к загрузке') + detail
  if (r?.error === 'safety') return t('Не удалось снять копию нынешнего состояния') + detail
  if (r?.error === 'backup') return t('Копию снять не удалось') + detail
  if (r?.error === 'save') return t('Не получилось сохранить копию') + detail
  return problemText(r?.error, t) || t('Не получилось. Повторите.')
}

// ── Загрузить копию базы ──
// Список копий этой кассы (основная и вторая папка) и копии из папки, которую выберет
// владелец, — например, с флешки сломавшегося компьютера. Что будет и что пропадёт, окно
// говорит до загрузки. Загрузка — с перезапуском программы (desktop/src/restore.mjs)
function RestoreView({ st, onBack }) {
  const t = useT()
  const toast = useToast()
  const [list, setList] = useState(null)
  const [picked, setPicked] = useState([])
  const [sel, setSel] = useState('')
  const [okForeign, setOkForeign] = useState(false)
  const [okLoss, setOkLoss] = useState(false)
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let alive = true
    bridge.backup.copies().then(
      (r) => alive && setList(Array.isArray(r?.copies) ? r.copies : []),
      () => alive && setList([]),
    )
    return () => {
      alive = false
    }
  }, [])

  const copies = [...picked, ...(list || [])]
  const chosen = copies.find((c) => c.id === sel) || null
  const pending = st?.pending || 0
  const ready = !!chosen && !chosen.problem && (!chosen.foreign || okForeign) && (pending === 0 || okLoss) && !busy && !done
  const choose = (c) => {
    setSel(c.id)
    setOkForeign(false)
  }
  const whereText = (c) => (c.where === 'main' ? t('Эта касса') : c.where === 'extra' ? t('Вторая папка') : c.place || t('Из выбранной папки'))

  const pickFolder = async () => {
    setBusy('pick')
    const r = await bridge.backup.pick().catch(() => null)
    setBusy('')
    if (!r || r.canceled) return
    const found = Array.isArray(r.copies) ? r.copies : []
    setPicked(found)
    if (!found.length) return toast(t('В этой папке нет копий базы'), 'err')
    const first = found.find((c) => !c.problem)
    if (first) choose(first)
  }

  const load = async () => {
    setBusy('restore')
    const r = await bridge.backup.restore(chosen.id, { acceptForeign: okForeign, acceptLoss: okLoss }).catch(() => null)
    if (r?.ok) return setDone(true)
    setBusy('')
    toast(copyErrorText(r, t), 'err')
  }

  return (
    <div data-testid="restore-view">
      <div className="tag-cat" style={{ marginBottom: 10 }}>
        {t('Выберите копию. Программа снимет копию нынешнего состояния, загрузит выбранную и перезапустится — войдите снова. Всё, что уже на сервере, останется там: магазин на прошлую дату так не вернуть.')}
      </div>
      {list === null ? (
        <div className="tag-cat">{t('Загружаем список копий…')}</div>
      ) : copies.length ? (
        <div className="restore-list" role="radiogroup" aria-label={t('Копии базы')}>
          {copies.map((c) => (
            <label key={c.id} className={'restore-row' + (sel === c.id ? ' on' : '') + (c.problem ? ' off' : '')} data-testid="restore-copy">
              <input type="radio" name="restore-copy" checked={sel === c.id} disabled={!!c.problem || !!busy || done} onChange={() => choose(c)} />
              <span className="restore-main">
                <b>{c.at ? fmtShort(c.at) : t('время неизвестно')}</b>
                <span className="tag-cat">
                  {whereText(c)}
                  {c.computer ? ` · ${t('компьютер')} ${c.computer}` : ''}
                </span>
                {c.problem ? (
                  <span className="tag-cat sync-bad">{problemText(c.problem, t)}</span>
                ) : (
                  <span className="tag-cat">{c.pending > 0 ? `${t('Не ушло на сервер')}: ${c.pending}` : t('Всё было отправлено на сервер')}</span>
                )}
              </span>
              {c.foreign && !c.problem && <span className="badge low">{t('другой компьютер')}</span>}
            </label>
          ))}
        </div>
      ) : (
        <div className="note info">{t('Копий пока нет — программа сама снимает копию раз в сутки. Или выберите папку с копией.')}</div>
      )}
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn ghost" disabled={!!busy || done} onClick={pickFolder} data-testid="restore-pick">
          {busy === 'pick' ? t('Ищем копии…') : t('Выбрать папку…')}
        </button>
      </div>

      {chosen && !done && (
        <div className="restore-confirm">
          {chosen.foreign && (
            <div className="note warn">
              {t('Это копия другой кассы. Загружайте её, только если тот компьютер больше не работает: эта касса станет той кассой — с её номером, сменой и чеками, которые не ушли на сервер.')}
              <label className="restore-check">
                <input type="checkbox" checked={okForeign} onChange={(e) => setOkForeign(e.target.checked)} data-testid="restore-ok-foreign" />
                {t('Тот компьютер больше не работает')}
              </label>
            </div>
          )}
          {pending > 0 && (
            <div className="note warn">
              {t('На этой кассе не ушло на сервер')}: {pending}.{' '}
              {t('После загрузки копии этого в программе не будет — оно останется в копии нынешнего состояния, которую программа снимет перед загрузкой.')}
              <label className="restore-check">
                <input type="checkbox" checked={okLoss} onChange={(e) => setOkLoss(e.target.checked)} data-testid="restore-ok-loss" />
                {t('Понимаю')}
              </label>
            </div>
          )}
          {!st?.online && (
            <div className="note info">{t('Связи с сервером сейчас нет. Копия загрузится, а смену, остатки и журналы программа сверит с сервером, как только появится интернет.')}</div>
          )}
        </div>
      )}
      {done && (
        <div className="note info" style={{ marginTop: 10 }} data-testid="restore-done">
          {t('Копия загружается. Программа сейчас перезапустится — войдите снова.')}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" disabled={!!busy || done} onClick={onBack}>
          {t('Назад')}
        </button>
        <button className="btn danger" disabled={!ready} onClick={load} data-testid="restore-load">
          {busy === 'restore' ? t('Загружаем…') : t('Загрузить копию')}
        </button>
      </div>
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
  // Окно состояния или его экран «Загрузить копию» — в том же окне, а не вторым поверх:
  // Escape у двух окон сразу закрывал бы не то
  const [view, setView] = useState('main')

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

  // Свежая копия — в папку, которую выберет владелец (флешка, другой диск)
  const saveTo = async () => {
    setBusy('saveTo')
    const r = await bridge.backup.saveTo().catch(() => null)
    setBusy('')
    refreshDesktopStatus()
    if (r?.ok) toast(`${t('Копия сохранена')}: ${r.path}`)
    else if (!r?.canceled) toast(copyErrorText(r, t), 'err')
  }

  if (view === 'restore') {
    return (
      <Modal wide title={t('Загрузить копию базы')} onClose={onClose}>
        <RestoreView st={st} onBack={() => setView('main')} />
      </Modal>
    )
  }

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
        {st?.waiting && pending > 0 && (
          <div className="note warn" style={{ margin: '8px 0' }}>
            {t('Часть операций ссылается на чек или клиента соседней кассы, которых сервер ещё не знает. Они уйдут на сервер сами, как только соседняя касса отправит своё.')}
          </div>
        )}
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

        {/* ── Соседние кассы в местной сети ── */}
        {st?.lan?.enabled && (
          <div className="sync-section lan-section">
            <LanPanel />
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
          {st?.restored?.manual && (
            <div className="note info" style={{ marginBottom: 8 }} data-testid="restored-manual">
              {st.restored.from ? `${t('Загружена копия базы от')} ${fmtShort(st.restored.from)}.` : t('Загружена копия базы.')}{' '}
              {st.restored.foreign ? `${t('Эта касса теперь работает под номером кассы со старого компьютера.')} ` : ''}
              {t('Перед загрузкой программа сохранила копию прежнего состояния — её можно загрузить обратно.')}
            </div>
          )}
          {st?.restored && !st.restored.manual && (
            <div className="note err" style={{ marginBottom: 8 }}>
              {st.restored.from
                ? `${t('Файл базы был повреждён, и программа подняла её из копии от')} ${fmtShort(st.restored.from)}. ${t('Чеки, пробитые после этой копии и не ушедшие на сервер, могли пропасть — сверьте кассу.')}`
                : t('Файл базы был повреждён, а копии не нашлось: данные загружены с сервера заново. Чеки, не ушедшие на сервер, пропали — сверьте кассу.')}
            </div>
          )}
          {backup.restoreError && (
            <div className="note err" style={{ marginBottom: 8 }} data-testid="restore-error">
              {t('Копию загрузить не удалось')}: {backup.restoreError}. {t('Базы остались прежними.')}
            </div>
          )}
          {backup.restoreWarning && (
            <div className="note warn" style={{ marginBottom: 8 }}>
              {t('Копия загружена, но')} {backup.restoreWarning}.
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
          {/* Две кнопки — и всё: сохранить копию в файл (например, на флешку) и загрузить её.
              Копию раз в сутки программа снимает сама */}
          {isFounder && (
            <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              <button className="btn ghost" disabled={!!busy} onClick={saveTo} data-testid="backup-save-to">
                {busy === 'saveTo' ? t('Сохраняем…') : t('Сохранить копию в…')}
              </button>
              <button className="btn ghost" disabled={!!busy} onClick={() => setView('restore')} data-testid="restore-open">
                {t('Загрузить копию')}
              </button>
            </div>
          )}
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
