import { useState } from 'react'
import {
  LuShoppingCart, LuPackagePlus, LuCreditCard, LuClipboardList, LuTrendingUp, LuServer, LuRefreshCw,
  LuKeyRound, LuUser, LuPalette, LuLanguages, LuSun, LuMoon, LuDatabaseBackup, LuDownload, LuTriangleAlert,
  LuTags, LuPlus, LuPencil, LuTrash2, LuUpload,
  LuCalendarClock, LuHandCoins, LuQrCode, LuReceiptText, LuMonitorSmartphone, LuWallet,
} from 'react-icons/lu'
import Layout from '../components/Layout'
import { useToast, useDialog, PasswordInput, Modal } from '../components/ui'
import { useCollection, refresh, db, resetStore } from '../db/store'
import { api, LONG_TIMEOUT_MS } from '../db/api'
import { dayKey, fmtDate, serverNow, tjMoment } from '../lib/time'
import { useAuth, useCan, changePassword as apiChangePassword } from '../db/auth'
import { useT, useLang, setLang, LANGS } from '../lib/i18n'
import { useTheme, setTheme } from '../lib/theme'
import DevicesPanel from '../components/DevicesPanel'
import PrintPanel from '../components/PrintPanel'
import ChekPanel from '../components/ChekPanel'
import VesyPanel from '../components/VesyPanel'
import { isDesktop } from '../lib/desktop'

// ── Подписка ──
// Раньше о ней говорила оранжевая полоса над каждым разделом. Владелец сервиса
// убрал её отовсюду: кассир к деньгам за программу отношения не имеет, а полоса
// весь день маячила у него перед глазами.
//
// Но знать, до какого числа оплачено, владелец магазина обязан — и знать заранее,
// потому что в назначенный момент работа прекращается без всякой отсрочки.
// Поэтому блок стоит здесь всегда, а не появляется в последний день: человек
// должен помнить, где посмотреть, ещё до того, как припрёт.
function Podpiska({ t }) {
  const user = useAuth()
  const sub = user?.subscription
  if (!sub) return null

  const soon = sub.warn
  const left = sub.daysLeft

  return (
    <div className="panel mt" data-tour="set.sub" style={{ maxWidth: 640, borderColor: soon ? 'var(--warn)' : undefined }}>
      <h2>
        <span className="h2-title">
          <span className="ic" style={{ color: soon ? 'var(--warn)' : undefined }}>
            <LuCalendarClock size={17} />
          </span>
          {t('Подписка')}
        </span>
      </h2>

      <div className="mini-cards" style={{ marginBottom: 10 }}>
        <div className="mini-card">
          <div className="m-label">{t('Оплачено до')}</div>
          <div className="m-value sm">{tjMoment(sub.paidUntil)}</div>
        </div>
        <div className="mini-card">
          <div className="m-label">{t('Осталось')}</div>
          <div className="m-value sm" style={{ color: soon ? 'var(--warn)' : undefined }}>
            {left > 0 ? `${left} ${t('дн.')}` : t('срок вышел')}
          </div>
        </div>
      </div>

      {sub.message && (
        <div className={'note ' + (sub.canWrite ? 'info' : 'err')}>{sub.message}</div>
      )}

      <div className="tag-cat" style={{ marginTop: 10 }}>
        {t('В назначенный момент работа программы прекращается. Данные магазина при этом сохраняются полностью.')}
      </div>
    </div>
  )
}

export default function Settings() {
  const t = useT()
  const lang = useLang()
  const theme = useTheme()
  const toast = useToast()
  const user = useAuth()
  const products = useCollection('products')
  const sales = useCollection('sales')
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const can = useCan()

  // ── Резервная копия ──
  // Файл со всеми данными магазина скачивается на компьютер владельца. Дата последней
  // копии хранится локально, чтобы система напоминала, если давно не делали.
  // Отметка о копии своя у каждого магазина: общий ключ показывал бы владельцу
  // «копия сделана вчера», когда вчерашняя копия была у соседа. Ошибиться здесь
  // хуже, чем не показывать ничего: на этой строчке держится спокойствие за данные.
  const LAST_BACKUP = 'apteka_last_backup_' + (user?.pharmacy?.code || 'net')
  const [backing, setBacking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [lastBackup, setLastBackup] = useState(() => {
    try { return localStorage.getItem(LAST_BACKUP) || '' } catch { return '' }
  })
  const backupAgeDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000) : null

  async function downloadBackup() {
    if (backing) return
    setBacking(true)
    try {
      const dump = await api.get('/backup', { timeout: LONG_TIMEOUT_MS })
      const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `apteka-kopiya-${dayKey()}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      const now = serverNow().toISOString()
      try { localStorage.setItem(LAST_BACKUP, now) } catch { /* ignore */ }
      setLastBackup(now)
      const c = dump.counts || {}
      toast(`${t('Копия сохранена')}: ${c.products || 0} ${t('товаров')}, ${c.sales || 0} ${t('продаж')}`)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBacking(false)
    }
  }

  const FEATURES = [
    { Icon: LuShoppingCart, text: t('Продажа по сканеру штрихкода и DataMatrix (касса)') },
    { Icon: LuPackagePlus, text: t('Приход товара и учёт остатков (упаковки и поштучно)') },
    { Icon: LuCreditCard, text: t('Оплата: наличные, карта, в долг') },
    { Icon: LuClipboardList, text: t('Авто-заявка на заканчивающиеся товары') },
    { Icon: LuTrendingUp, text: t('Отчёты, аналитика склада, роли сотрудников') },
  ]

  async function reload() {
    await refresh()
    toast(t('Данные обновлены'))
  }

  async function changePassword() {
    if (saving) return
    if (!pw.oldPassword || !pw.newPassword) return toast(t('Заполните пароли'), 'err')
    if (pw.newPassword.length < 6) return toast(t('Новый пароль слишком короткий (мин. 6)'), 'err')
    if (pw.newPassword !== pw.confirm) return toast(t('Пароли не совпадают'), 'err')
    setSaving(true)
    try {
      await apiChangePassword(pw.oldPassword, pw.newPassword)
      toast(t('Пароль изменён'))
      setPw({ oldPassword: '', newPassword: '', confirm: '' })
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  const set = (k, v) => setPw((s) => ({ ...s, [k]: v }))

  // ── Разделы настроек ──
  // Длинная простыня панелей стала шестью разделами: слева список, справа только
  // выбранное. Права решают, какие разделы видны; выбранный запоминается на устройстве
  const RAZDEL_KEY = 'apteka_nastroyki_razdel'
  const razdely = [
    { id: 'profil', label: 'Профиль', Icon: LuUser, show: true },
    { id: 'chek', label: 'Чек и печать', Icon: LuReceiptText, show: can('settings.print') },
    { id: 'kategorii', label: 'Категории товаров', Icon: LuTags, show: can('settings.categories') },
    { id: 'dengi', label: 'Деньги', Icon: LuWallet, show: can('settings.expenseCategories') || can('settings.payServices') },
    { id: 'ustroystva', label: 'Кассы и устройства', Icon: LuMonitorSmartphone, show: can('settings.devices') },
    { id: 'kopiya', label: 'Резервная копия', Icon: LuDatabaseBackup, show: can('settings.backup') },
  ].filter((r) => r.show)
  const [razdel, setRazdel] = useState(() => {
    try {
      return localStorage.getItem(RAZDEL_KEY) || 'profil'
    } catch {
      return 'profil'
    }
  })
  // Права могли сузиться с прошлого раза — чужой раздел не показываем
  const active = razdely.some((r) => r.id === razdel) ? razdel : razdely[0]?.id || 'profil'
  const pick = (id) => {
    setRazdel(id)
    try {
      localStorage.setItem(RAZDEL_KEY, id)
    } catch {
      /* не запомнилось — не страшно */
    }
  }

  return (
    <Layout title={t('Настройки')} subtitle={t('Профиль и система')}>
      <div className="set-wrap">
        <nav className="set-nav" data-tour="set.nav" aria-label={t('Разделы настроек')}>
          {razdely.map((r) => (
            <button
              key={r.id}
              type="button"
              className={'set-nav-btn' + (active === r.id ? ' active' : '')}
              data-tour={'set.nav-' + r.id}
              onClick={() => pick(r.id)}
            >
              <span className="ic"><r.Icon size={17} /></span>
              <span>{t(r.label)}</span>
            </button>
          ))}
        </nav>

        <div className="set-body">
          {active === 'profil' && (
            <>
              <Podpiska t={t} />

              {/* Оформление: язык + тема */}
              <div className="panel mt" style={{ maxWidth: 640 }}>
                <h2><span className="h2-title"><span className="ic"><LuPalette size={17} /></span>{t('Оформление')}</span></h2>
                <div className="field" data-tour="set.lang">
                  <label><LuLanguages size={13} style={{ verticalAlign: '-2px' }} /> {t('Язык')}</label>
                  <div className="chips">
                    {LANGS.map((l) => (
                      <button key={l.key} className={'chip ' + (lang === l.key ? 'active' : '')} onClick={() => setLang(l.key)}>{l.label}</button>
                    ))}
                  </div>
                </div>
                <div className="field" data-tour="set.theme" style={{ marginBottom: 0 }}>
                  <label>{t('Тема')}</label>
                  <div className="chips">
                    <button className={'chip ' + (theme === 'light' ? 'active' : '')} onClick={() => setTheme('light')}><LuSun size={13} style={{ verticalAlign: '-2px' }} /> {t('Светлая')}</button>
                    <button className={'chip ' + (theme === 'dark' ? 'active' : '')} onClick={() => setTheme('dark')}><LuMoon size={13} style={{ verticalAlign: '-2px' }} /> {t('Тёмная')}</button>
                  </div>
                </div>
              </div>

              <div className="panel mt" data-tour="set.profile" style={{ maxWidth: 640 }}>
                <h2><span className="h2-title"><span className="ic"><LuUser size={17} /></span>{t('Мой профиль')}</span></h2>
                <p style={{ fontSize: 14, color: 'var(--muted)' }}>
                  {t('Вы вошли как')} <b>{user?.name}</b> — {user?.role === 'founder' ? t('Основатель') : user?.roleName || t('Кассир')}.
                </p>
              </div>

              <div className="panel mt" data-tour="set.password" style={{ maxWidth: 640 }}>
                <h2><span className="h2-title"><span className="ic"><LuKeyRound size={17} /></span>{t('Смена пароля')}</span></h2>
                <div className="field"><label>{t('Текущий пароль')}</label>
                  <PasswordInput value={pw.oldPassword} onChange={(e) => set('oldPassword', e.target.value)} autoComplete="current-password" />
                </div>
                <div className="row">
                  <div className="field" style={{ flex: 1 }}><label>{t('Новый пароль')}</label>
                    <PasswordInput value={pw.newPassword} onChange={(e) => set('newPassword', e.target.value)} autoComplete="new-password" />
                  </div>
                  <div className="field" style={{ flex: 1 }}><label>{t('Повторите')}</label>
                    <PasswordInput value={pw.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" />
                  </div>
                </div>
                <button className="btn" onClick={changePassword} disabled={saving}>{saving ? t('Сохранение…') : t('Изменить пароль')}</button>
              </div>

              <div className="panel mt" style={{ maxWidth: 640 }}>
                <h2><span className="h2-title"><span className="ic"><LuServer size={17} /></span>{t('О системе')}</span></h2>
                <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7 }}>
                  {t('Данные хранятся на сервере — все устройства видят одну общую базу.')} {t('Время — таджикское (UTC+5).')}{' '}
                  {t('Сейчас в базе')}: <b>{products.length}</b> {t('товаров')}, <b>{sales.length}</b> {t('продаж')}.
                </p>
                <ul style={{ listStyle: 'none', marginTop: 14, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {FEATURES.map((f, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, fontSize: 14 }}>
                      <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-dark)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                        <f.Icon size={16} />
                      </span>
                      {f.text}
                    </li>
                  ))}
                </ul>
                <button className="btn ghost" data-tour="set.reload" style={{ marginTop: 14 }} onClick={reload}><span className="ic"><LuRefreshCw size={16} /></span> {t('Обновить данные')}</button>
              </div>
            </>
          )}

          {active === 'chek' && can('settings.print') && (
            <>
              {/* Что печатается на чеке: адрес, телефон, подпись — на сайте и в программе */}
              <ChekPanel />
              {/* Чековый принтер настраивается на каждом компьютере отдельно — только в программе */}
              {isDesktop && <PrintPanel />}
              {!isDesktop && (
                <div className="note info mt" style={{ maxWidth: 640 }}>
                  {t('Чековый принтер настраивается в программе для Windows — на той кассе, к которой он подключён.')}
                </div>
              )}
            </>
          )}

          {active === 'kategorii' && can('settings.categories') && <CategoriesPanel />}

          {active === 'dengi' && (
            <>
              {can('settings.expenseCategories') && <ExpenseCategoriesPanel />}
              {can('settings.payServices') && <PayServicesPanel />}
            </>
          )}

          {active === 'ustroystva' && can('settings.devices') && (
            <>
              <DevicesPanel />
              {/* Этикетки весов разбирает касса на этом устройстве — настройка здесь же */}
              <VesyPanel />
            </>
          )}

          {active === 'kopiya' && can('settings.backup') && (
            <div className="panel mt" data-tour="set.backup" style={{ maxWidth: 640 }}>
              <h2><span className="h2-title"><span className="ic"><LuDatabaseBackup size={17} /></span>{t('Резервная копия')}</span></h2>
              <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
                {t('Скачайте файл со всеми данными магазина и храните его у себя — на компьютере или флешке. Если с сервером что-то случится, из этого файла всё восстановится.')}
              </p>

              {backupAgeDays === null ? (
                <div className="note err" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                  <LuTriangleAlert size={16} style={{ flexShrink: 0 }} />
                  <span>{t('Копия ещё ни разу не делалась')}</span>
                </div>
              ) : backupAgeDays >= 7 ? (
                <div className="note err" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                  <LuTriangleAlert size={16} style={{ flexShrink: 0 }} />
                  <span>{t('Последняя копия')}: {fmtDate(lastBackup)} — {t('пора сделать новую')}</span>
                </div>
              ) : (
                <div className="note info" style={{ marginBottom: 12 }}>
                  {t('Последняя копия')}: {fmtDate(lastBackup)}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <button className="btn" onClick={downloadBackup} disabled={backing}>
                  <span className="ic"><LuDownload size={16} /></span> {backing ? t('Готовим копию…') : t('Скачать копию')}
                </button>
                <button className="btn ghost" onClick={() => setRestoring(true)}>
                  <span className="ic"><LuUpload size={16} /></span> {t('Восстановить из копии')}
                </button>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted-2)', marginTop: 10, lineHeight: 1.6 }}>
                {t('Совет: делайте копию раз в неделю и храните несколько последних файлов. Пароли сотрудников в копию не попадают.')}
              </p>
            </div>
          )}
        </div>
      </div>

      {restoring && <RestoreBox onClose={() => setRestoring(false)} />}
    </Layout>
  )
}

// ── Восстановление из копии ──
// Самая редкая операция в программе и самая важная: её делают один раз, когда всё
// уже плохо. Раньше её здесь не было вовсе — копию можно было скачать, а поднять
// только запросом к серверу вручную. То есть в тот единственный день, ради которого
// копию и делали, владелец магазина оставался один на один с файлом.
//
// Порядок нарочно медленный: файл сначала разбирается прямо на устройстве и
// показывается владельцу — что за копия, от какого числа, сколько в ней товаров и
// продаж. И только после этого, набрав слово подтверждения, он отправляет её на
// сервер. Ошибиться файлом здесь дороже, чем где бы то ни было ещё.
const CONFIRM_WORD = 'ВОССТАНОВИТЬ'

function RestoreBox({ onClose }) {
  const t = useT()
  const toast = useToast()
  const [fileName, setFileName] = useState('')
  const [dump, setDump] = useState(null)
  const [word, setWord] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function pickFile(e) {
    const f = e.target.files?.[0]
    setDump(null)
    setError('')
    setWord('')
    setFileName(f ? f.name : '')
    if (!f) return
    try {
      const parsed = JSON.parse(await f.text())
      // Ту же проверку делает и сервер. Здесь она нужна, чтобы владелец узнал
      // о неправильном файле сразу, а не после загрузки нескольких мегабайт
      if (!parsed?.data?.products) throw new Error(t('в файле нет данных магазина'))
      setDump(parsed)
    } catch (err) {
      setError(`${t('Это не похоже на копию магазина')}: ${err.message}`)
    }
  }

  async function run() {
    if (!dump || busy) return
    setBusy(true)
    setError('')
    try {
      await api.post('/backup/restore', { dump, confirm: CONFIRM_WORD }, { timeout: LONG_TIMEOUT_MS })
      // На устройстве остался кэш с данными, которых больше нет. Стереть его и
      // перезагрузиться проще и надёжнее, чем чинить каждый открытый экран
      resetStore()
      toast(t('База восстановлена из копии'))
      setTimeout(() => window.location.reload(), 700)
    } catch (err) {
      setError(
        err.status === 413
          ? t('Файл слишком большой для сервера. Увеличьте BODY_LIMIT в настройках сервера и повторите.')
          : err.message,
      )
      setBusy(false)
    }
  }

  const c = dump?.counts || {}
  const ready = !!dump && word.trim() === CONFIRM_WORD && !busy

  return (
    <Modal title={t('Восстановление из копии')} onClose={busy ? undefined : onClose}>
      <div className="note err" style={{ display: 'flex', gap: 9, marginBottom: 14 }}>
        <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t('Все текущие данные магазина будут заменены содержимым файла: товары, продажи, приходы, долги, смены. Отменить это нельзя.')}</span>
      </div>

      <div className="field">
        <label htmlFor="restore-file">{t('Файл копии')}</label>
        <input id="restore-file" type="file" accept="application/json,.json" onChange={pickFile} disabled={busy} />
      </div>

      {error && <div className="note err" style={{ marginBottom: 14 }}>{error}</div>}

      {dump && (
        <>
          <div className="note info" style={{ marginBottom: 12 }}>
            {t('Копия от')} <b>{fmtDate(dump.createdAt)}</b>
            {fileName && <> · {fileName}</>}
          </div>
          <div className="mini-cards" style={{ marginBottom: 14 }}>
            <div className="mini-card"><div className="m-label">{t('Товаров')}</div><div className="m-value sm">{c.products ?? '—'}</div></div>
            <div className="mini-card"><div className="m-label">{t('Продаж')}</div><div className="m-value sm">{c.sales ?? '—'}</div></div>
            <div className="mini-card"><div className="m-label">{t('Клиентов')}</div><div className="m-value sm">{c.customers ?? '—'}</div></div>
            <div className="mini-card"><div className="m-label">{t('Приходов')}</div><div className="m-value sm">{c.arrivals ?? '—'}</div></div>
          </div>

          <div className="field">
            <label htmlFor="restore-word">{t('Для подтверждения наберите слово')}: {CONFIRM_WORD}</label>
            <input
              id="restore-word"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
              disabled={busy}
            />
          </div>

          <p style={{ fontSize: 12.5, color: 'var(--muted-2)', lineHeight: 1.6, marginBottom: 14 }}>
            {t('Пароли сотрудников в копию не попадают: они восстановятся заблокированными, доступ выдайте заново в разделе «Сотрудники».')}
          </p>
        </>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('Отмена')}</button>
        <button className="btn danger" onClick={run} disabled={!ready}>
          {busy ? t('Восстанавливаем…') : t('Восстановить')}
        </button>
      </div>
    </Modal>
  )
}

// ── Сервисы перевода ──
// Через что покупатели переводят деньги: Alif, DC, Эсхата… Кассир выбирает сервис при
// оплате переводом, а в отчётах переводы видны по каждому отдельно — так их сверяют
// с выпиской. Чек хранит сервис названием: убранный сервис в прежних чеках остаётся
function PayServicesPanel() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const services = useCollection('payServices')
  const [name, setName] = useState('')

  function add() {
    const value = name.trim()
    if (!value) return toast(t('Укажите название сервиса'), 'err')
    if (services.some((s) => s.name.toLowerCase() === value.toLowerCase())) {
      return toast(t('Такой сервис уже есть'), 'err')
    }
    db.push('payServices', { name: value })
      .then(() => toast(t('Сервис добавлен')))
      .catch((e) => toast(t(e.message), 'err'))
    setName('')
  }

  async function remove(s) {
    const ok = await dialog.confirm({
      title: t('Убрать сервис?'),
      message: `«${s.name}» ${t('исчезнет из списка на кассе. Прежние чеки по нему останутся как были.')}`,
      danger: true,
      confirmText: t('Убрать'),
    })
    if (!ok) return
    db.remove('payServices', s.id)
      .then(() => toast(t('Сервис убран')))
      .catch((e) => toast(t(e.message), 'err'))
  }

  return (
    <div className="panel mt" data-tour="set.payservices" style={{ maxWidth: 640 }}>
      <h2><span className="h2-title"><span className="ic"><LuQrCode size={17} /></span>{t('Сервисы перевода')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Через что покупатели переводят деньги: Alif, DC, Эсхата… Кассир выбирает сервис при оплате переводом, в отчётах переводы видны по каждому отдельно.')}
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="paySvcName">{t('Новый сервис')}</label>
          <input id="paySvcName" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('Напр. Спитамен')} />
        </div>
        <button className="btn" onClick={add} style={{ marginBottom: 14 }}>
          <span className="ic"><LuPlus size={16} /></span> {t('Добавить')}
        </button>
      </div>
      <table>
        <thead><tr><th>{t('Сервис')}</th><th></th></tr></thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.id}>
              <td><b>{s.name}</b></td>
              <td className="num">
                <button className="btn ghost sm icon" onClick={() => remove(s)} title={t('Убрать')} aria-label={`${t('Убрать')}: ${s.name}`}><LuTrash2 size={15} /></button>
              </td>
            </tr>
          ))}
          {services.length === 0 && <tr><td colSpan="2" className="empty">{t('Сервисов пока нет')}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ── Статьи расходов ──
// Готовый список (аренда, зарплата, налоги…) есть у каждого магазина с самого начала,
// свои статьи владелец добавляет здесь. Расход хранит статью названием, поэтому
// убрать статью можно всегда: прежние расходы остаются с ней и в отчётах не теряются.
function ExpenseCategoriesPanel() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const categories = useCollection('expenseCategories')
  const [name, setName] = useState('')

  function add() {
    const value = name.trim()
    if (!value) return toast(t('Укажите название статьи'), 'err')
    if (categories.some((c) => c.name.toLowerCase() === value.toLowerCase())) {
      return toast(t('Такая статья расходов уже есть'), 'err')
    }
    db.push('expenseCategories', { name: value })
      .then(() => toast(t('Статья добавлена')))
      .catch((e) => toast(t(e.message), 'err'))
    setName('')
  }

  async function remove(c) {
    const ok = await dialog.confirm({
      title: t('Убрать статью расходов?'),
      message: `«${t(c.name)}» ${t('исчезнет из списка для новых расходов. Прежние расходы по ней останутся как были.')}`,
      danger: true,
      confirmText: t('Убрать'),
    })
    if (!ok) return
    db.remove('expenseCategories', c.id)
      .then(() => toast(t('Статья убрана')))
      .catch((e) => toast(t(e.message), 'err'))
  }

  return (
    <div className="panel mt" data-tour="set.expcats" style={{ maxWidth: 640 }}>
      <h2><span className="h2-title"><span className="ic"><LuHandCoins size={17} /></span>{t('Статьи расходов')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('По этим статьям вносятся расходы в разделе «Расходы». Добавьте свои, если готовых не хватает.')}
      </p>

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="expCatName">{t('Новая статья')}</label>
          <input
            id="expCatName"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={t('Напр. Охрана')}
          />
        </div>
        <button className="btn" onClick={add} style={{ marginBottom: 14 }}>
          <span className="ic"><LuPlus size={16} /></span> {t('Добавить')}
        </button>
      </div>

      <table>
        <thead>
          <tr><th>{t('Статья')}</th><th></th></tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td><b>{t(c.name)}</b></td>
              <td className="num">
                <button className="btn ghost sm icon" onClick={() => remove(c)} title={t('Убрать')} aria-label={`${t('Убрать')}: ${t(c.name)}`}><LuTrash2 size={15} /></button>
              </td>
            </tr>
          ))}
          {categories.length === 0 && <tr><td colSpan="2" className="empty">{t('Статей пока нет')}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ── Категории товаров ──
// Список задаёт владелец, и он тут же уходит во все формы, фильтры и приёмку:
// категории живут в общем слое данных и рассылаются на устройства сигналом.
function CategoriesPanel() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const categories = useCollection('categories')
  const products = useCollection('products')
  const [name, setName] = useState('')
  const [noExpiry, setNoExpiry] = useState(false)

  const countIn = (cat) => products.filter((p) => p.category === cat).length

  function add() {
    const value = name.trim()
    if (!value) return toast(t('Укажите название категории'), 'err')
    if (categories.some((c) => c.name.toLowerCase() === value.toLowerCase())) {
      return toast(t('Такая категория уже есть'), 'err')
    }
    // Мгновенно: категория появляется в списке и во всех формах сразу
    db.push('categories', { name: value, noExpiry }).catch((e) => toast(e.message, 'err'))
    setName('')
    setNoExpiry(false)
    toast(t('Категория добавлена'))
  }

  async function rename(c) {
    const r = await dialog.prompt({
      title: t('Переименовать категорию'),
      message: `${t('Товаров в категории')}: ${countIn(c.name)}. ${t('Они переедут в новую категорию автоматически.')}`,
      fields: [{ name: 'name', label: t('Новое название'), defaultValue: c.name }],
      confirmText: t('Переименовать'),
    })
    if (!r || !r.name.trim() || r.name.trim() === c.name) return
    db.update('categories', c.id, { name: r.name.trim() }).catch((e) => toast(e.message, 'err'))
    toast(t('Категория переименована'))
  }

  function toggleExpiry(c) {
    db.update('categories', c.id, { noExpiry: !c.noExpiry }).catch((e) => toast(e.message, 'err'))
  }

  async function remove(c) {
    const used = countIn(c.name)
    if (used > 0) {
      // Товар не должен остаться в категории, которой нет: он пропал бы из
      // фильтров и из охвата пересчёта остатков
      return toast(`${t('В категории')} «${c.name}» ${used} ${t('товар(ов) — сначала перенесите их')}`, 'err')
    }
    const ok = await dialog.confirm({
      title: t('Удалить категорию?'),
      message: `«${c.name}» ${t('будет удалена из списка.')}`,
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    db.remove('categories', c.id).catch((e) => toast(e.message, 'err'))
    toast(t('Категория удалена'))
  }

  return (
    <div className="panel mt" data-tour="set.categories" style={{ maxWidth: 640 }}>
      <h2><span className="h2-title"><span className="ic"><LuTags size={17} /></span>{t('Категории товаров')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 12 }}>
        {t('Категории видны в карточке товара, в фильтрах, на кассе, при приёмке и в пересчёте остатков. Изменения появляются на всех устройствах сразу.')}
      </p>

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>{t('Новая категория')}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={t('Напр. Перевязка')}
          />
        </div>
        <button className="btn" onClick={add} style={{ marginBottom: 14 }}>
          <span className="ic"><LuPlus size={16} /></span> {t('Добавить')}
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--muted)', marginBottom: 14 }}>
        <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} style={{ width: 16, height: 16 }} />
        {t('срок годности не нужен (бинты, вата, приборы)')}
      </label>

      <table>
        <thead>
          <tr><th>{t('Категория')}</th><th className="num">{t('Товаров')}</th><th>{t('Срок годности')}</th><th></th></tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td><b>{c.name}</b></td>
              <td className="num">{countIn(c.name)}</td>
              <td>
                <button className="btn ghost sm" onClick={() => toggleExpiry(c)} title={t('Нажмите, чтобы изменить')}>
                  {c.noExpiry ? t('не нужен') : t('обязателен')}
                </button>
              </td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                <button className="btn ghost sm icon" onClick={() => rename(c)} title={t('Переименовать')}><LuPencil size={15} /></button>{' '}
                <button className="btn ghost sm icon" onClick={() => remove(c)} title={t('Удалить')}><LuTrash2 size={15} /></button>
              </td>
            </tr>
          ))}
          {categories.length === 0 && <tr><td colSpan="4" className="empty">{t('Категорий пока нет')}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
