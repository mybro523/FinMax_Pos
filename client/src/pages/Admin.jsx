import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  LuPlus, LuLogOut, LuRefreshCw, LuTriangleAlert, LuKeyRound,
  LuBanknote, LuPause, LuPlay, LuLogIn, LuScrollText, LuTrash2, LuPencil, LuCheck,
  LuPhone, LuSettings, LuSun, LuMoon,
} from 'react-icons/lu'
import { Modal, useToast, useDialog } from '../components/ui'
import NumberInput from '../components/NumberInput'
import { api, LONG_TIMEOUT_MS } from '../db/api'
import { money } from '../db/store'
import { logout, useAuth, enterPharmacy } from '../db/auth'
import { onService, onlineCodes } from '../db/realtime'
import { fmtDate, fmtDateTime, tjMoment, tjDate, tjTime, serverNow } from '../lib/time'
import { useT, useLang, setLang, LANGS } from '../lib/i18n'
import { useTheme, setTheme } from '../lib/theme'
import emblem from '../assets/brand/emblem-64.png'

// Библиотека диаграмм весит около 370 КБ — грузим её после того, как показаны
// числа и список аптек
const RevenueChart = lazy(() => import('../components/RevenueChart'))

// ── Настройки панели ──
// Тема и язык у панели свои, отдельные от аптечных: владелец может держать
// панель на русском и в тёмной, а аптеке показывать таджикский и светлую.
// Настройка помнится на этом устройстве — в браузере, не на сервере.
function Nastroyki({ onClose }) {
  const t = useT()
  const theme = useTheme()
  const lang = useLang()

  return (
    <Modal className="admin-modal" title={<><span className="ic"><LuSettings size={18} /></span>{t('Настройки панели')}</>} onClose={onClose}>
      <div className="field">
        <label>{t('Тема')}</label>
        <div className="chips">
          <button className={'chip ' + (theme === 'light' ? 'active' : '')} onClick={() => setTheme('light')}>
            <LuSun size={13} style={{ verticalAlign: '-2px' }} /> {t('Светлая')}
          </button>
          <button className={'chip ' + (theme === 'dark' ? 'active' : '')} onClick={() => setTheme('dark')}>
            <LuMoon size={13} style={{ verticalAlign: '-2px' }} /> {t('Тёмная')}
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t('Язык')}</label>
        <div className="chips">
          {LANGS.map((l) => (
            <button key={l.key} className={'chip ' + (lang === l.key ? 'active' : '')} onClick={() => setLang(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tag-cat" style={{ marginTop: 4 }}>
        {t('Настройка запоминается на этом устройстве и не влияет на то, что видят аптеки')}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t('Готово')}</button>
      </div>
    </Modal>
  )
}

// ── Панель владельца сервиса ──
// Здесь обслуживают аптеки-клиентов. У этой страницы своё оформление, а не общее
// с аптекой: там боковое меню кассы, склада и смен, и владельцу сервиса нечего
// в нём делать — своей аптеки у него нет вовсе.
//
// Главный экран отвечает на один вопрос: кому сегодня звонить. Поэтому аптеки
// с заканчивающейся или просроченной оплатой стоят отдельно и первыми, а не тонут
// в общем списке.

// Состояние подписки считается из даты и двух признаков, а не хранится отдельно:
// хранимое поле пришлось бы обновлять по расписанию, и в первый же день, когда
// задача не отработала, оно разошлось бы с датой оплаты. Те же ступени, что
// и на сервере (src/admin/subscription.ts).
// ── За сколько дней клиент поднимается наверх ──
// Было семь. Владелец сервиса выбрал два: список «кому звонить сегодня» должен
// быть коротким, иначе в него перестают смотреть. Просроченные и в отсрочке
// поднимаются в любом случае, так что никто не теряется — сверху оказываются
// только те, у кого срок истекает завтра-послезавтра.
const WARN_DAYS = 2

// Сколько дней без единого чека считаем тревогой. Столько же на сервере (SILENT_DAYS)
const SILENT_DAYS = 7

// Те же правила, что на сервере (src/admin/subscription.ts). Считаем по МОМЕНТУ,
// а не по календарным суткам: срок назначается с точностью до часа, и «до конца
// дня» превратило бы 17:00 в 23:59.
function statusOf(p) {
  // По часам СЕРВЕРА, а не рабочего компьютера. Часы на местах запросто уходят
  // на минуты, и пока срок мерялся сутками, это было незаметно. Теперь он мерится
  // часами, и расхождение показало бы владельцу не тот остаток.
  const leftMs = new Date(p.paidUntil).getTime() - serverNow().getTime()
  const left = Math.ceil(leftMs / 86400000)
  if (p.blocked) return { key: 'Приостановлена', cls: 'debt', left, urgent: true }
  if (leftMs <= 0) return { key: 'Срок вышел', cls: 'debt', left, urgent: true }
  if (p.trial) return { key: 'Пробный период', cls: 'low', left, days: left, urgent: left <= WARN_DAYS }
  if (left <= WARN_DAYS) return { key: 'Оплачена', cls: 'low', left, days: left, urgent: true }
  return { key: 'Оплачена', cls: 'ok', left, urgent: false }
}

// Сколько дней аптека не пробивала чеков. null — сервер ещё не успел посмотреть
function silentDays(p) {
  if (!p.lastSaleSeen) return null
  if (!p.lastSaleAt) return null
  return Math.floor((serverNow().getTime() - new Date(p.lastSaleAt).getTime()) / 86400000)
}

// Те же правила, что на сервере (src/admin/pharmacies.service.ts). Проверяем здесь
// не из недоверия к серверу, а потому что окно теперь закрывается сразу: отказ,
// пришедший через полминуты после закрытия формы, унёс бы с собой всё введённое.
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

const emptyPay = { months: '1', amount: '', method: 'cash', note: '' }
const emptyNew = {
  code: '', name: '', ownerName: '', phone: '', city: '',
  trialDays: '14', ownerLogin: '', ownerPassword: '', demo: false,
}

export default function Admin() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const me = useAuth()

  const [list, setList] = useState([])
  // Сводка по сервису: деньги и клиенты. Считается на сервере одним запросом
  // к базе панели, без походов в схемы аптек.
  const [sum, setSum] = useState(null)
  // Какая карточка сводки раскрыта и платежи для её расшифровки. Платежи тянем
  // только когда понадобились: список аптек нужен всегда, а они — по нажатию.
  const [pick, setPick] = useState(null)
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null) // заведение новой
  const [created, setCreated] = useState(null) // логин и пароль, показываются один раз
  const [openId, setOpenId] = useState(null) // открытая карточка
  const [journal, setJournal] = useState(null) // журнал по всему сервису
  const [nastroyki, setNastroyki] = useState(false) // тема и язык панели
  // Аптеки, которые прямо сейчас заводятся. Создание идёт около пятнадцати секунд —
  // это настоящая работа базы, двадцать таблиц с индексами, — и всё это время
  // владелец сервиса не должен сидеть перед замершим окном.
  const [pending, setPending] = useState([])
  // Кто из аптек сейчас за кассой. Приходит по связи и меняется сам —
  // это единственный способ увидеть, живой клиент или молчит вторую неделю.
  const [online, setOnline] = useState(() => onlineCodes())
  // Счётчик работы в открытой аптеке: пробили чек — карточка обновилась сама
  const [beat, setBeat] = useState(0)

  const load = useCallback(async () => {
    try {
      // Список и сводку берём вместе: два запроса, но параллельно — и оба
      // приходят к одному кадру, без подёргивания страницы
      const [rows, s] = await Promise.all([api.get('/admin/pharmacies'), api.get('/admin/pharmacies/summary')])
      setList(rows)
      setSum(s)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  // ── Панель обновляется сама ──
  // Владелец сервиса держит её открытой весь день. Раньше список показывал то,
  // что было на момент загрузки: аптеку завели с другого устройства — не видно,
  // клиент заплатил и его разблокировали — не видно. Кнопка «Обновить» осталась,
  // но нажимать её больше незачем.
  const openRow = useMemo(() => list.find((p) => p.id === openId), [list, openId])
  const openCode = openRow?.code
  useEffect(
    () =>
      onService((e) => {
        if (e.what === 'presence') setOnline(e.online || [])
        else if (e.what === 'pharmacies') load()
        // Работа идёт в открытой карточке — обновим её счётчики. Остальные аптеки
        // торгуют весь день, и дёргать из-за них страницу незачем.
        else if (e.what === 'activity' && e.code && e.code === openCode) setBeat((n) => n + 1)
      }),
    [load, openCode],
  )

  // ── Пока аптека заводится, уходить со страницы нельзя ──
  // Пароль владельца приходит только вместе с ответом сервера и показывается один
  // раз. Закрыл вкладку на пятнадцатой секунде — пароль потерян навсегда, и его
  // придётся задавать заново. Раньше об этом можно было не думать: окно висело
  // и не пускало. Теперь оно закрывается сразу, и предупредить обязаны мы.
  useEffect(() => {
    if (!pending.length) return
    const hold = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [pending.length])

  // Кому звонить сегодня: просроченные и заканчивающиеся — наверх
  const { urgent, rest } = useMemo(() => {
    const withStatus = list.map((p) => ({ ...p, _s: statusOf(p) }))
    const byDate = (a, b) => a._s.left - b._s.left
    return {
      urgent: withStatus.filter((p) => p._s.urgent).sort(byDate),
      rest: withStatus.filter((p) => !p._s.urgent).sort(byDate),
    }
  }, [list])

  // Заведение аптеки — единственное место в панели, где работа идёт долго:
  // создать схему, прогнать миграции, настроить, завести владельца. Держать окно
  // открытым всё это время незачем — оно закрывается сразу, а работа продолжается.
  //
  // Раньше запрос обрывался на пятнадцатой секунде и показывал «Сервер не отвечает»,
  // хотя аптека к тому моменту уже создавалась. Худший вид ошибки: она врёт, а
  // повторное нажатие даёт «аптека с таким кодом уже заведена».
  function startCreate() {
    const body = {
      code: form.code.trim().toLowerCase(),
      name: form.name.trim(),
      ownerName: form.ownerName.trim() || undefined,
      phone: form.phone.trim() || undefined,
      city: form.city.trim() || undefined,
      trialDays: Number(form.trialDays) || undefined,
      ownerLogin: form.ownerLogin.trim() || undefined,
      ownerPassword: form.ownerPassword.trim() || undefined,
      demo: form.demo || undefined,
    }

    setForm(null)
    const mark = { key: 'new_' + Date.now(), code: body.code, name: body.name, city: body.city, demo: !!body.demo }
    setPending((list) => [mark, ...list])

    api
      .post('/admin/pharmacies', body, { timeout: LONG_TIMEOUT_MS })
      .then(async (res) => {
        setPending((list) => list.filter((x) => x.key !== mark.key))
        await load()
        // Логин и пароль всплывают сами: пароль показывается один раз, и потерять
        // его из-за того, что владелец сервиса отвлёкся, нельзя
        setCreated(res)
      })
      .catch((e) => {
        setPending((list) => list.filter((x) => x.key !== mark.key))
        toast(`${t('Аптеку завести не удалось')}: ${e.message}`, 'err')
      })
  }

  async function openJournal() {
    try {
      setJournal(await api.get('/admin/audit?limit=200'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const head = (
    <tr>
      <th>{t('Код')}</th>
      <th>{t('Название')}</th>
      <th>{t('Владелец')}</th>
      <th>{t('Оплачено до')}</th>
      <th className="num">{t('Принёс')}</th>
      <th>{t('Состояние')}</th>
    </tr>
  )

  // Строка аптеки, которая сейчас заводится. По ней не щёлкнуть: карточки ещё нет.
  const pendingRows = () =>
    pending.map((p) => (
      <tr key={p.key} style={{ opacity: 0.65 }}>
        <td data-label={t('Код')}><b style={{ letterSpacing: 0.4 }}>{p.code}</b></td>
        <td className="cell-main" data-label={t('Название')}>
          {p.name}
          {p.city && <div className="tag-cat">{p.city}</div>}
        </td>
        <td className="tag-cat" data-label={t('Владелец')}>—</td>
        <td className="tag-cat" data-label={t('Оплачено до')}>—</td>
        <td className="tag-cat num" data-label={t('Принёс')}>—</td>
        <td className="cell-state" data-label={t('Состояние')}>
          <span className="badge low">
            {p.demo ? t('заводится с демо-данными…') : t('заводится…')}
          </span>
        </td>
      </tr>
    ))

  const rows = (items) =>
    items.map((p) => (
      <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(p.id)}>
        <td data-label={t('Код')}>
          <b style={{ letterSpacing: 0.4 }}>{p.code}</b>
          {online.includes(p.code) && <span className="live-dot" title={t('Сейчас работают')} />}
        </td>
        <td className="cell-main" data-label={t('Название')}>
          {p.name}
          {p.city && <div className="tag-cat">{p.city}</div>}
        </td>
        <td data-label={t('Владелец')}>
          {p.ownerName || '—'}
          {p.phone && <div className="tag-cat">{p.phone}</div>}
        </td>
        <td data-label={t('Оплачено до')}>
          {tjMoment(p.paidUntil)}
          {p.calledAt && (
            <div className="tag-cat" title={p.callNote || ''}>
              ☎ {fmtDate(p.calledAt)}{p.callNote ? ': ' + p.callNote.slice(0, 24) : ''}
            </div>
          )}
        </td>
        <td className="num" data-label={t('Принёс')}>
          {money(p.paid || 0)}
          {!p.paid && <div className="tag-cat">{t('ни разу')}</div>}
        </td>
        <td className="cell-state" data-label={t('Состояние')}>
          <span className={'badge ' + p._s.cls}>
            {t(p._s.key)}
            {p._s.days != null ? `, ${p._s.days} ${t('дн.')}` : ''}
            {p._s.left < 0 && !p.blocked ? `, ${-p._s.left} ${t('дн. просрочки')}` : ''}
          </span>
          {(() => {
            // Оплачена, а чеков нет неделю. Деньги получены, но клиент уже уходит —
            // просто ещё не сказал. Самый ранний признак, который у нас есть.
            const q = silentDays(p)
            return q !== null && q >= SILENT_DAYS && !p.blocked ? (
              <div className="tag-cat" style={{ color: 'var(--danger)' }}>
                {t('не торгует')} {q} {t('дн.')}
              </div>
            ) : null
          })()}
        </td>
      </tr>
    ))

  return (
    // admin-app: у панели своя разметка без бокового меню, и правила для узких
    // экранов ей нужны свои — общие написаны под разделы аптеки
    <div className="app admin-app">
      <div className="main" style={{ marginLeft: 0 }}>
        <header className="topbar">
          <div className="topbar-left">
            <img src={emblem} alt="" width="34" height="34" className="admin-emblem" />
            <div>
              <h1>{t('Аптеки')}</h1>
              <div className="sub">{list.length} {t('в обслуживании')} · {me?.name}</div>
            </div>
          </div>
          <div className="topbar-actions">
            <button className="btn ghost icon" onClick={load} title={t('Обновить')}><LuRefreshCw size={16} /></button>
            <button className="btn ghost" onClick={openJournal} title={t('Журнал')}>
              <span className="ic"><LuScrollText size={16} /></span> <span className="btn-text">{t('Журнал')}</span>
            </button>
            <button className="btn ghost icon" onClick={() => setNastroyki(true)} title={t('Настройки панели')}>
              <LuSettings size={16} />
            </button>
            <button className="btn" onClick={() => setForm({ ...emptyNew })} title={t('Завести аптеку')}>
              <span className="ic"><LuPlus size={16} /></span> <span className="btn-text">{t('Завести аптеку')}</span>
            </button>
            <button className="btn ghost icon" onClick={logout} title={t('Выйти')}><LuLogOut size={16} /></button>
          </div>
        </header>

        <main className="content">
          {sum && (
            <Svodka
              s={sum}
              t={t}
              onPick={async (kind) => {
                setPick(kind)
                if (kind === 'month' && !payments.length) {
                  try {
                    setPayments(await api.get('/admin/pharmacies/payments?days=62'))
                  } catch (e) {
                    toast(e.message, 'err')
                  }
                }
              }}
            />
          )}
          {sum && (
            <Suspense fallback={null}>
              <RevenueChart data={sum.byMonth} />
            </Suspense>
          )}

          {urgent.length > 0 && (
            <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
              <h2 style={{ padding: '14px 16px 0' }}>
                <span className="h2-title">
                  <span className="ic" style={{ color: 'var(--warn)' }}><LuTriangleAlert size={17} /></span>
                  {t('Требуют внимания')}
                </span>
              </h2>
              <table className="table-cards">
                <thead>{head}</thead>
                <tbody>{rows(urgent)}</tbody>
              </table>
            </div>
          )}

          <div className="panel" style={{ padding: 0 }}>
            <table className="table-cards">
              <thead>{head}</thead>
              <tbody>
                {pendingRows()}
                {rows(rest)}
                {!loading && list.length === 0 && pending.length === 0 && (
                  <tr><td colSpan="6" className="empty">{t('Аптек пока нет. Нажмите «Завести аптеку».')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      {openId && (
        <PharmacyCard
          id={openId}
          row={openRow}
          beat={beat}
          live={online.includes(openCode)}
          onClose={() => setOpenId(null)}
          onChanged={load}
          toast={toast}
          dialog={dialog}
          t={t}
        />
      )}

      {pick && (
        <SvodkaDetail
          kind={pick}
          list={list}
          payments={payments}
          t={t}
          onClose={() => setPick(null)}
          onOpen={(id) => {
            if (!id) return
            setPick(null)
            setOpenId(id)
          }}
        />
      )}

      {nastroyki && <Nastroyki onClose={() => setNastroyki(false)} />}
      {form && <NewPharmacy form={form} setForm={setForm} onStart={startCreate} toast={toast} t={t} />}

      {created && (
        <Modal className="admin-modal" title={t('Аптека заведена')} onClose={() => setCreated(null)}>
          <div className="note err" style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
            <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{t('Запишите пароль сейчас. Он больше нигде не показывается — потом его можно только задать заново.')}</span>
          </div>
          <div className="mini-cards" style={{ marginBottom: 16 }}>
            <div className="mini-card"><div className="m-label">{t('Аптека')}</div><div className="m-value sm">{created.name}</div></div>
            <div className="mini-card"><div className="m-label">{t('Логин')}</div><div className="m-value sm">{created.ownerLogin}</div></div>
            <div className="mini-card">
              <div className="m-label"><LuKeyRound size={11} style={{ verticalAlign: '-1px' }} /> {t('Пароль')}</div>
              <div className="m-value sm" style={{ letterSpacing: 1 }}>{created.ownerPassword}</div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setCreated(null)}>{t('Записал')}</button>
          </div>
        </Modal>
      )}

      {journal && (
        <Modal className="admin-modal" title={t('Журнал действий')} onClose={() => setJournal(null)} wide>
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table className="table-cards">
              <thead><tr><th>{t('Время')}</th><th>{t('Кто')}</th><th>{t('Аптека')}</th><th>{t('Что сделал')}</th></tr></thead>
              <tbody>
                {journal.map((a) => (
                  <tr key={a.id}>
                    <td className="tag-cat" data-label={t('Время')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                    <td data-label={t('Кто')}>{a.accountName || '—'}</td>
                    <td data-label={t('Аптека')}>{a.pharmacyCode || '—'}</td>
                    <td className="cell-main" data-label={t('Что сделал')}>{a.detail || a.action}</td>
                  </tr>
                ))}
                {journal.length === 0 && <tr><td colSpan="4" className="empty">{t('Записей пока нет')}</td></tr>}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Заведение новой аптеки ──
function NewPharmacy({ form, setForm, onStart, toast, t }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  // Всё, что можно проверить здесь, проверяется здесь: окно закрывается сразу,
  // и отказ, пришедший через полминуты, унёс бы с собой всё введённое. Сервер
  // проверяет то же самое ещё раз — он никому не верит на слово, и правильно.
  function submit() {
    const code = form.code.trim().toLowerCase()
    if (!CODE_RE.test(code)) {
      return toast(t('Код аптеки: латинские буквы, цифры и дефис, от 2 до 31 символа. Например: shifo'), 'err')
    }
    if (!form.name.trim()) return toast(t('Укажите название аптеки'), 'err')
    const pw = form.ownerPassword.trim()
    if (pw && pw.length < 6) return toast(t('Пароль слишком короткий (минимум 6 символов)'), 'err')
    onStart()
  }
  return (
    <Modal className="admin-modal" title={t('Новая аптека')} onClose={() => setForm(null)}>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>{t('Код аптеки')}</label>
          <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="shifo" autoFocus />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>{t('Название')}</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Аптека Шифо" />
        </div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Владелец')}</label>
          <input value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>{t('Телефон')}</label>
          <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+992 …" /></div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Город')}</label>
          <input value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>{t('Пробный период, дней')}</label>
          <NumberInput value={form.trialDays} onChange={(e) => set('trialDays', e.target.value)} /></div>
      </div>

      <div className="note info" style={{ marginBottom: 14 }}>
        {t('Под этим логином войдёт владелец аптеки. Пароль можно не задавать — он придумается и покажется один раз.')}
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Логин владельца')}</label>
          <input value={form.ownerLogin} onChange={(e) => set('ownerLogin', e.target.value)} placeholder={form.code || 'shifo'} /></div>
        <div className="field" style={{ flex: 1 }}><label>{t('Пароль')}</label>
          <input value={form.ownerPassword} onChange={(e) => set('ownerPassword', e.target.value)} placeholder={t('придумается сам')} /></div>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 16 }}>
        <input type="checkbox" checked={form.demo} onChange={(e) => set('demo', e.target.checked)} />
        {t('Заполнить демонстрационными товарами и продажами')}
      </label>

      <div className="note info" style={{ marginBottom: 14, fontSize: 12.5 }}>
        {t('Заведение занимает около полуминуты — окно закроется сразу, работа пойдёт в фоне. Логин и пароль появятся, когда аптека будет готова.')}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={() => setForm(null)}>{t('Отмена')}</button>
        <button className="btn" onClick={submit}>{t('Завести')}</button>
      </div>
    </Modal>
  )
}

// ── Карточка аптеки ──
// Всё про одного клиента на одном экране: чем он живёт, сколько платил, кто у него
// за кассой и что мы с этой аптекой делали. Перед звонком клиенту открывают её.
// Карточки, уже открывавшиеся за этот заход. Панель открыта весь день, и одну и ту же
// аптеку смотрят по нескольку раз — второй раз она обязана открываться мгновенно.
const seenCards = new Map()
const seenUsage = new Map()

function PharmacyCard({ id, row, beat, live, onClose, onChanged, toast, dialog, t }) {
  // ── Открываем сразу тем, что уже знаем ──
  // Название, код, срок оплаты, состояние — всё это лежит в строке списка, по которой
  // только что щёлкнули. Раньше карточка ждала сервер с нуля и показывала «Загрузка…»
  // почти секунду, а на остывшем подключении — две. Ждать было нечего: половина
  // содержимого уже была на экране, в той самой строке.
  const [ph, setPh] = useState(() => ({ payments: [], accounts: [], audit: [], ...(row || {}), ...(seenCards.get(id) || {}) }))
  const [usage, setUsage] = useState(() => seenUsage.get(id) || null)
  const [busy, setBusy] = useState(false)
  const [pay, setPay] = useState(null)
  const [edit, setEdit] = useState(null)

  const load = useCallback(async () => {
    try {
      const fresh = await api.get(`/admin/pharmacies/${id}`)
      seenCards.set(id, fresh)
      setPh((was) => ({ ...was, ...fresh }))
    } catch (e) {
      toast(e.message, 'err')
      onClose()
    }
  }, [id, toast, onClose])

  // ── Счётчики отдельным запросом ──
  // За ними надо идти в схему самой аптеки, и если та давно не работала —
  // подключение к ней открывается заново. Держать из-за этого весь экран нельзя.
  const loadUsage = useCallback(async () => {
    try {
      const u = await api.get(`/admin/pharmacies/${id}/usage`)
      seenUsage.set(id, u)
      setUsage(u)
    } catch {
      /* счётчики не главное: без них карточка остаётся полезной */
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // beat — в этой аптеке только что шла работа: перезапросим счётчики продаж
  useEffect(() => {
    loadUsage()
  }, [loadUsage, beat])

  async function act(fn, okText) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await load()
      await onChanged()
      if (okText) toast(okText)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function toggleBlock() {
    const stop = !ph.blocked
    const ok = await dialog.confirm({
      title: stop ? t('Приостановить работу аптеки?') : t('Возобновить работу аптеки?'),
      message: stop
        ? `${ph.name}: ${t('касса перестанет работать до возобновления. Данные останутся на месте.')}`
        : `${ph.name}: ${t('аптека снова сможет продавать.')}`,
      danger: stop,
      confirmText: stop ? t('Приостановить') : t('Возобновить'),
    })
    if (!ok) return
    act(
      () => api.post(`/admin/pharmacies/${id}/${stop ? 'block' : 'unblock'}`),
      stop ? t('Работа приостановлена') : t('Работа возобновлена'),
    )
  }

  // ── Отметка о звонке ──
  // Продление начинается со звонка, а звонков за день бывает десяток. Без отметки
  // один клиент выслушивает напоминание дважды, а другой не слышит его вовсе.
  async function markCalled() {
    const r = await dialog.prompt({
      title: t('Отметить звонок'),
      message: `${ph.name}${ph.phone ? ' · ' + ph.phone : ''}`,
      fields: [{ name: 'note', label: t('Что сказали'), placeholder: t('обещал оплатить в пятницу') }],
      confirmText: t('Записать'),
    })
    if (!r) return
    await act(() => api.post(`/admin/pharmacies/${id}/called`, { note: r.note || '' }), t('Звонок отмечен'))
  }

  async function enter() {
    const ok = await dialog.confirm({
      title: t('Войти под владельцем аптеки?'),
      message: t('Вы увидите аптеку его глазами, включая закупочные цены и выручку. Вход записывается в журнал, а вернуться можно одним нажатием.'),
      confirmText: t('Войти'),
    })
    if (!ok) return
    try {
      await enterPharmacy(id)
      // Дальше приложение само покажет аптеку: в токене уже её владелец
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function removeIt() {
    const r = await dialog.prompt({
      title: t('Удалить аптеку?'),
      message: `${t('Будут стёрты все её данные: товары, продажи, долги, история. Восстановить их можно только из копии, которую делал сам владелец. Наберите код аптеки')}: ${ph.code}`,
      fields: [{ name: 'code', label: t('Код аптеки') }],
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!r || r.code.trim() !== ph.code) return
    try {
      // Удаление стирает схему со всем содержимым — на большой аптеке это не мгновение
      await api.del(`/admin/pharmacies/${id}?confirm=${encodeURIComponent(r.code.trim())}`, {
        timeout: LONG_TIMEOUT_MS,
      })
      toast(t('Аптека удалена'))
      onClose()
      await onChanged()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // Строки списка не оказалось — так бывает разве что при переходе по прямой ссылке.
  // Тогда ждать всё-таки придётся.
  if (!ph.id) {
    return <Modal className="admin-modal" title={t('Аптека')} onClose={onClose}><div className="empty">{t('Загрузка…')}</div></Modal>
  }

  const s = statusOf(ph)

  return (
    <Modal className="admin-modal" title={`${ph.name} · ${ph.code}`} onClose={onClose} wide>
      <div className="mini-cards" style={{ marginBottom: 14 }}>
        <div className="mini-card">
          <div className="m-label">{t('Состояние')}</div>
          <div className="m-value sm">
            <span className={'badge ' + s.cls}>{t(s.key)}</span>
            {/* Сейчас за кассой — видно до звонка клиенту: «у нас всё встало»
                при живой связи означает совсем другое, чем при мёртвой */}
            {live && <span className="live-dot" title={t('Сейчас работают')} />}
          </div>
        </div>
        <div className="mini-card">
          <div className="m-label">{t('Оплачено до')}</div>
          <div className="m-value sm">{tjMoment(ph.paidUntil)}</div>
        </div>
        <div className="mini-card">
          <div className="m-label">{t('Принёс за всё время')}</div>
          <div className="m-value sm">{money((ph.payments || []).reduce((s, x) => s + Number(x.amount || 0), 0))}</div>
        </div>
        <div className="mini-card"><div className="m-label">{t('Товаров')}</div><div className="m-value sm">{num(usage?.products)}</div></div>
        <div className="mini-card"><div className="m-label">{t('Продаж')}</div><div className="m-value sm">{num(usage?.sales)}</div></div>
        <div className="mini-card">
          <div className="m-label">{t('Последняя продажа')}</div>
          <div className="m-value sm">{usage ? (usage.lastSale ? fmtDate(usage.lastSale) : '—') : '…'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
        <button className="btn" onClick={() => setPay({ ...emptyPay })} disabled={busy}>
          <span className="ic"><LuBanknote size={16} /></span> {t('Продлить')}
        </button>
        <button className="btn ghost" onClick={toggleBlock} disabled={busy}>
          <span className="ic">{ph.blocked ? <LuPlay size={16} /> : <LuPause size={16} />}</span>
          {ph.blocked ? t('Возобновить') : t('Приостановить')}
        </button>
        <button className="btn ghost" onClick={markCalled} disabled={busy}>
          <span className="ic"><LuPhone size={16} /></span> {t('Отметить звонок')}
        </button>
        <button className="btn ghost" onClick={enter} disabled={busy || ph.blocked}>
          <span className="ic"><LuLogIn size={16} /></span> {t('Войти под владельцем')}
        </button>
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() =>
            setEdit({
              name: ph.name,
              ownerName: ph.ownerName,
              phone: ph.phone,
              city: ph.city,
              note: ph.note,
              paidUntil: tjDate(ph.paidUntil),
              paidTime: tjTime(ph.paidUntil),
              offlineDays: String(ph.offlineDays ?? 7),
            })
          }
        >
          <span className="ic"><LuPencil size={16} /></span> {t('Изменить')}
        </button>
        <button className="btn ghost" onClick={removeIt} disabled={busy} style={{ marginLeft: 'auto', color: 'var(--danger)' }}>
          <span className="ic"><LuTrash2 size={16} /></span> {t('Удалить')}
        </button>
      </div>

      <Section title={t('Контакты')}>
        <Kv label={t('Владелец')} value={ph.ownerName || '—'} />
        <Kv label={t('Телефон')} value={ph.phone || '—'} />
        <Kv label={t('Город')} value={ph.city || '—'} />
        {ph.note && <Kv label={t('Примечание')} value={ph.note} />}
        {/* Программа для Windows продаёт и без интернета, но подписку проверяет сервер */}
        <Kv label={t('Касса работает без связи')} value={`${ph.offlineDays ?? 7} ${t('дн.')}`} />
        {ph.calledAt && (
          <Kv label={t('Последний звонок')} value={`${fmtDate(ph.calledAt)}${ph.callNote ? ' · ' + ph.callNote : ''}`} />
        )}
      </Section>

      <Section title={`${t('Оплаты')} · ${ph.payments.length}`}>
        {ph.payments.length === 0 ? (
          <div className="empty">{t('Оплат пока не было')}</div>
        ) : (
          <table className="table-cards">
            <thead>
              <tr>
                <th>{t('Дата')}</th><th className="num">{t('Сумма')}</th><th className="num">{t('Месяцев')}</th>
                <th>{t('Оплачено до')}</th><th>{t('Кто')}</th>
              </tr>
            </thead>
            <tbody>
              {ph.payments.map((p) => (
                <tr key={p.id}>
                  <td className="tag-cat" data-label={t('Дата')}>{fmtDate(p.createdAt)}</td>
                  <td className="num" data-label={t('Сумма')}><b>{p.amount}</b></td>
                  <td className="num" data-label={t('Месяцев')}>{p.months}</td>
                  <td data-label={t('Оплачено до')}>{fmtDate(p.paidUntilAfter)}</td>
                  <td className="tag-cat" data-label={t('Кто')}>{p.byAccount?.login || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`${t('Сотрудники')} · ${ph.accounts.length}`}>
        <table className="table-cards">
          <thead><tr><th>{t('Логин')}</th><th>{t('Роль')}</th><th>{t('Статус')}</th><th>{t('Добавлен')}</th></tr></thead>
          <tbody>
            {ph.accounts.map((a) => (
              <tr key={a.id}>
                <td className="cell-main" data-label={t('Логин')}>{a.login}</td>
                <td data-label={t('Роль')}>{a.role === 'founder' ? t('Основатель') : t('Кассир')}</td>
                <td className="cell-state" data-label={t('Статус')}><span className={'badge ' + (a.active ? 'ok' : 'debt')}>{a.active ? t('активен') : t('заблокирован')}</span></td>
                <td className="tag-cat" data-label={t('Добавлен')}>{fmtDate(a.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {ph.audit.length > 0 && (
        <Section title={t('Что делали с этой аптекой')}>
          <table className="table-cards">
            <tbody>
              {ph.audit.map((a) => (
                <tr key={a.id}>
                  <td className="tag-cat" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                  <td className="tag-cat">{a.accountName || '—'}</td>
                  <td className="cell-main">{a.detail || a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {pay && (
        <Modal className="admin-modal" title={`${t('Продление')}: ${ph.name}`} onClose={() => setPay(null)}>
          <div className="note info" style={{ marginBottom: 14 }}>
            {t('Деньги принимаются вживую. Здесь остаётся запись — за что и на сколько продлили.')}
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>{t('На сколько месяцев')}</label>
              <NumberInput value={pay.months} onChange={(e) => setPay({ ...pay, months: e.target.value })} autoFocus /></div>
            <div className="field" style={{ flex: 1 }}><label>{t('Сумма, сомони')}</label>
              <NumberInput value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>{t('Как оплатили')}</label>
            <div className="chips">
              {[['cash', 'Наличные'], ['transfer', 'Перевод'], ['other', 'Иначе']].map(([k, label]) => (
                <button key={k} className={'chip ' + (pay.method === k ? 'active' : '')} onClick={() => setPay({ ...pay, method: k })}>
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
          <div className="field"><label>{t('Примечание')}</label>
            <input value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setPay(null)} disabled={busy}>{t('Отмена')}</button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(
                  () =>
                    api
                      .post(`/admin/pharmacies/${id}/extend`, {
                        months: Number(pay.months) || 1,
                        amount: Number(pay.amount) || 0,
                        method: pay.method,
                        note: pay.note.trim() || undefined,
                      })
                      .then(() => setPay(null)),
                  t('Подписка продлена'),
                )
              }
            >
              {busy ? t('Продлеваем…') : t('Продлить')}
            </button>
          </div>
        </Modal>
      )}

      {edit && (
        <Modal className="admin-modal" title={t('Изменить аптеку')} onClose={() => setEdit(null)}>
          <div className="field"><label>{t('Название')}</label>
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>{t('Владелец')}</label>
              <input value={edit.ownerName} onChange={(e) => setEdit({ ...edit, ownerName: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label>{t('Телефон')}</label>
              <input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>{t('Город')}</label>
              <input value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label>{t('Оплачено до')}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="date" style={{ flex: 1 }} value={edit.paidUntil}
                  onChange={(e) => setEdit({ ...edit, paidUntil: e.target.value })} />
                <input type="time" style={{ width: 110 }} value={edit.paidTime}
                  onChange={(e) => setEdit({ ...edit, paidTime: e.target.value })} />
              </div>
              <div className="tag-cat">{t('В этот момент работа аптеки прекратится')}</div>
            </div>
          </div>
          <div className="field"><label>{t('Примечание')}</label>
            <input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></div>
          <div className="field"><label>{t('Касса работает без связи, дней')}</label>
            <input type="number" min="1" max="30" step="1" inputMode="numeric" style={{ maxWidth: 120 }} value={edit.offlineDays}
              onChange={(e) => setEdit({ ...edit, offlineDays: e.target.value })} data-testid="offline-days" />
            <div className="tag-cat">{t('Программа для Windows продаёт и без интернета. Дольше этого срока без связи с сервером она не работает — пока не проверит подписку. От 1 до 30 дней.')}</div>
          </div>

          <div className="note info" style={{ marginBottom: 14 }}>
            {t('Дату меняют, когда ошиблись при вводе, дают бесплатное продление или закрывают сразу. Обычную оплату лучше проводить кнопкой «Продлить» — она попадёт в историю оплат.')}
          </div>

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEdit(null)} disabled={busy}>{t('Отмена')}</button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(
                  () =>
                    api
                      .patch(`/admin/pharmacies/${id}`, {
                        name: edit.name.trim(),
                        ownerName: edit.ownerName,
                        phone: edit.phone,
                        city: edit.city,
                        note: edit.note,
                        // Полдень по Душанбе: так дата не съезжает на сутки
                        // при переводе в общее время
                        // Час указывается по Душанбе: сервер живёт по всемирному
                        // времени, и без пояса «17:00» уехало бы на пять часов
                        paidUntil: edit.paidUntil
                          ? new Date(`${edit.paidUntil}T${edit.paidTime || '23:59'}:00.000+05:00`).toISOString()
                          : undefined,
                        // Пустое поле — число не трогаем; негодное сервер отвергнет с объяснением
                        offlineDays: String(edit.offlineDays).trim() === '' ? undefined : Number(edit.offlineDays),
                      })
                      .then(() => setEdit(null)),
                  t('Сохранено'),
                )
              }
            >
              <span className="ic"><LuCheck size={16} /></span> {t('Сохранить')}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}

// ── Сводка по сервису ──
// Первое, что видит владелец, открыв панель: как идут дела. Деньги — слева,
// клиенты — справа: сначала «сколько заработал», потом «на ком».
//
// Доход за месяц показан рядом с прошлым не для красоты: одно число само по себе
// ничего не значит, а «на 12% меньше прошлого» — уже повод разобраться.
// ── Сводка по сервису ──
// Первое, что видит владелец, открыв панель: как идут дела. Деньги — слева,
// клиенты — справа: сначала «сколько заработал», потом «на ком».
//
// Каждая карточка нажимается и раскрывается списком. Число само по себе говорит
// «двое не заплатили», но звонить надо конкретным людям — а за ними иначе пришлось
// бы искать по всему списку глазами.
function Svodka({ s, t, onPick }) {
  const { money: m, clients: c } = s
  const diff = m.prevMonth > 0 ? Math.round(((m.thisMonth - m.prevMonth) / m.prevMonth) * 100) : null

  const Card = ({ kind, label, value, note, danger }) => (
    <button className="mini-card svodka-card" onClick={() => onPick(kind)} title={t('Показать список')}>
      <div className="m-label">{label}</div>
      <div className="m-value" style={danger ? { color: 'var(--danger)' } : undefined}>{value}</div>
      <div className="tag-cat">{note}</div>
    </button>
  )

  return (
    <div className="mini-cards" style={{ marginBottom: 16 }}>
      <Card
        kind="month"
        label={t('Доход за этот месяц')}
        value={money(m.thisMonth)}
        note={
          <>
            {t('в прошлом')} {money(m.prevMonth)}
            {diff !== null && (
              <span style={{ color: diff >= 0 ? 'var(--green)' : 'var(--danger)', marginLeft: 6 }}>
                {diff >= 0 ? '+' : ''}{diff}%
              </span>
            )}
          </>
        }
      />
      <Card kind="expected" label={t('Ожидается за 30 дней')} value={money(m.expected30)} note={t('если все продлят')} />
      <Card
        kind="all"
        label={t('Доход за всё время')}
        value={money(m.allTime)}
        note={`${t('средний платёж')} ${money(m.avgPayment)}`}
      />
      <Card kind="paying" label={t('Платят')} value={c.paying} note={`${t('из')} ${c.total} ${t('всего')}`} />
      <Card
        kind="trial"
        label={t('Пробный период')}
        value={c.trial}
        note={`+${c.newThisMonth} ${t('новых за месяц')}`}
      />
      <Card
        kind="expired"
        label={t('Срок вышел')}
        value={c.expired + c.blocked}
        danger={c.expired + c.blocked > 0}
        note={`${t('работа остановлена')}`}
      />
      <Card
        kind="silent"
        label={t('Оплачены, но молчат')}
        value={c.silent}
        danger={c.silent > 0}
        note={t('нет чеков больше недели')}
      />
    </div>
  )
}

// ── Расшифровка карточки ──
// Число в сводке говорит «двое не заплатили». Звонить надо людям, а не числам —
// поэтому здесь список с телефонами, и щелчок по строке открывает карточку клиента.
function SvodkaDetail({ kind, list, payments, onClose, onOpen, t }) {
  const titles = {
    month: t('Платежи за этот месяц'),
    expected: t('Кому продлевать в ближайшие 30 дней'),
    all: t('Сколько принёс каждый клиент'),
    paying: t('Платящие клиенты'),
    trial: t('На пробном периоде'),
    expired: t('Работа остановлена'),
    silent: t('Оплачены, но не торгуют'),
  }

  const now = Date.now()
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const withStatus = list.map((p) => ({ ...p, _s: statusOf(p) }))

  // Списки платежей и списки клиентов рисуются по-разному, но ведут в одно место
  const isMoney = kind === 'month'
  const rows = isMoney
    ? (payments || []).filter((x) => new Date(x.createdAt).getTime() >= month)
    : {
        expected: withStatus
          .filter((p) => !p.blocked && p._s.left <= 30)
          .sort((a, b) => a._s.left - b._s.left),
        all: [...withStatus].sort((a, b) => (b.paid || 0) - (a.paid || 0)),
        paying: withStatus.filter((p) => p._s.key === 'Оплачена'),
        trial: withStatus.filter((p) => p._s.key === 'Пробный период'),
        expired: withStatus.filter((p) => p._s.key === 'Срок вышел' || p.blocked),
        silent: withStatus.filter((p) => {
          const q = silentDays(p)
          return q !== null && q >= SILENT_DAYS && !p.blocked
        }),
      }[kind] || []

  return (
    <Modal className="admin-modal" title={titles[kind] || t('Подробно')} onClose={onClose} wide>
      {rows.length === 0 ? (
        <div className="empty">{t('Здесь пока пусто')}</div>
      ) : isMoney ? (
        <table className="table-cards">
          <thead>
            <tr>
              <th>{t('Дата')}</th>
              <th>{t('Клиент')}</th>
              <th className="num">{t('Сумма')}</th>
              <th className="num">{t('Месяцев')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(p.pharmacy?.id)}>
                <td className="tag-cat" data-label={t('Дата')}>{fmtDate(p.createdAt)}</td>
                <td className="cell-main" data-label={t('Клиент')}>{p.pharmacy?.name || '—'}<div className="tag-cat">{p.pharmacy?.code}</div></td>
                <td className="num" data-label={t('Сумма')}><b>{money(p.amount)}</b></td>
                <td className="num" data-label={t('Месяцев')}>{p.months}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="table-cards">
          <thead>
            <tr>
              <th>{t('Клиент')}</th>
              <th>{t('Телефон')}</th>
              <th>{t('Оплачено до')}</th>
              <th className="num">{t('Принёс')}</th>
              <th>{t('Состояние')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)}>
                <td className="cell-main" data-label={t('Клиент')}>{p.name}<div className="tag-cat">{p.code}</div></td>
                <td className="tag-cat" data-label={t('Телефон')}>{p.phone || '—'}</td>
                <td data-label={t('Оплачено до')}>{tjMoment(p.paidUntil)}</td>
                <td className="num" data-label={t('Принёс')}>{money(p.paid || 0)}</td>
                <td className="cell-state" data-label={t('Состояние')}>
                  <span className={'badge ' + p._s.cls}>{t(p._s.key)}</span>
                  {kind === 'silent' && (
                    <div className="tag-cat" style={{ color: 'var(--danger)' }}>
                      {t('не торгует')} {silentDays(p)} {t('дн.')}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="tag-cat" style={{ marginTop: 10 }}>{t('Щёлкните по строке, чтобы открыть карточку клиента')}</div>
    </Modal>
  )
}


// Счётчик ещё едет — многоточие; приехал пустым — прочерк. Разница важна:
// «пока не знаю» и «ноль» для владельца сервиса означают разное.
function num(v) {
  if (v === undefined || v === null) return v === null ? '—' : '…'
  return v
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function Kv({ label, value }) {
  return (
    <div className="kv" style={{ display: 'flex', gap: 10, fontSize: 14, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)', minWidth: 110 }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}
