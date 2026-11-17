import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  LuPlus, LuLogOut, LuRefreshCw, LuTriangleAlert, LuKeyRound,
  LuBanknote, LuPause, LuPlay, LuLogIn, LuScrollText, LuTrash2, LuPencil, LuCheck,
  LuPhone, LuSettings, LuSun, LuMoon, LuFileSpreadsheet, LuCopy,
} from 'react-icons/lu'
import { Modal, useToast, useDialog } from '../components/ui'
import NumberInput from '../components/NumberInput'
import KodyAktivacii from '../components/KodyAktivacii'
import ModuliVybor, { moduliText } from '../components/ModuliVybor'
import { api, LONG_TIMEOUT_MS } from '../db/api'
import { money } from '../db/store'
import { logout, useAuth, enterPharmacy } from '../db/auth'
import { onService, onlineCodes } from '../db/realtime'
import { fmtDate, fmtDateTime, tjMoment, tjDate, tjTime, serverNow } from '../lib/time'
import { useT, useLang, setLang, LANGS } from '../lib/i18n'
import { useTheme, setTheme } from '../lib/theme'
import emblem from '../assets/brand/emblem-64.png'
import LogoField from '../components/LogoField'
import TovaryIzExcel from '../components/TovaryIzExcel'

// Библиотека диаграмм весит около 370 КБ — грузим её после того, как показаны
// числа и список магазинов
const RevenueChart = lazy(() => import('../components/RevenueChart'))

// ── Телефон (окно до 600 px, 18.11.2026) ──
// На телефоне у панели другая разметка, не только вид: поиск и «Требуют внимания» — сразу под
// шапкой, подписи под значками шапки, «Закрыть» внизу длинных окон, номера клиентов — ссылками
// для звонка. Стилями такого не сделать, поэтому ширину спрашиваем сами — через matchMedia:
// браузер сообщает только о пересечении границы. На компьютере разметка прежняя.
const PHONE = '(max-width: 600px)'
function usePhone() {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const mq = window.matchMedia(PHONE)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches,
    () => false,
  )
}

// Номер клиента на телефоне — ссылкой: касание сразу набирает его. Экран отвечает на вопрос
// «кому звонить», и переписывать номер вручную незачем. В поле бывает и два номера через
// запятую — каждый своей ссылкой. stop: строка списка нажимается целиком и открывает карточку,
// а касание номера должно звонить, а не открывать её
function Tel({ phone, stop }) {
  const parts = String(phone || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return '—'
  return parts.map((s, i) => {
    const dial = s.replace(/[^\d+]/g, '')
    return (
      <span key={i}>
        {i > 0 && ', '}
        {dial.replace(/\D/g, '').length >= 5 ? (
          <a className="admin-tel" href={'tel:' + dial} onClick={stop ? (e) => e.stopPropagation() : undefined}>
            <LuPhone size={14} /> {s}
          </a>
        ) : (
          s
        )}
      </span>
    )
  })
}

// ── Настройки панели ──
// Тема и язык у панели свои, отдельные от магазина: владелец может держать
// панель на русском и в тёмной, а магазину показывать таджикский и светлую.
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
        {t('Настройка запоминается на этом устройстве и не влияет на то, что видят магазины')}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>{t('Готово')}</button>
      </div>
    </Modal>
  )
}

// ── Панель владельца сервиса ──
// Здесь обслуживают магазины-клиентов. У этой страницы своё оформление, а не общее
// с магазином: там боковое меню кассы, склада и смен, и владельцу сервиса нечего
// в нём делать — своего магазина у него нет вовсе.
//
// Главный экран отвечает на один вопрос: кому сегодня звонить. Поэтому магазины
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

// Сколько дней магазин не пробивал чеков. null — сервер ещё не успел посмотреть
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
  trialDays: '14', ownerLogin: '', ownerPassword: '', demo: false, logo: '',
  // Товары из Excel клиента (components/TovaryIzExcel.jsx) — разобранный файл или null
  tovary: null,
  // Модули (1.8.1): список ВЫКЛЮЧЕННЫХ — по умолчанию у клиента есть всё
  modulesOff: [],
}

export default function Admin() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const me = useAuth()
  const phone = usePhone()

  const [list, setList] = useState([])
  // Поиск магазина (на телефоне): карточка магазина там высотой в пол-экрана, и при полусотне
  // клиентов нужного перед звонком пришлось бы искать по двенадцати тысячам пикселей прокрутки
  const [find, setFind] = useState('')
  // Журнал на телефоне — по 50 записей: двести карточек подряд — тридцать тысяч пикселей
  const [zhurnalShown, setZhurnalShown] = useState(50)
  // Сводка по сервису: деньги и клиенты. Считается на сервере одним запросом
  // к базе панели, без походов в схемы магазинов.
  const [sum, setSum] = useState(null)
  // Какая карточка сводки раскрыта и платежи для её расшифровки. Платежи тянем
  // только когда понадобились: список магазинов нужен всегда, а они — по нажатию.
  const [pick, setPick] = useState(null)
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null) // заведение новой
  const [created, setCreated] = useState(null) // логин и пароль, показываются один раз
  const [openId, setOpenId] = useState(null) // открытая карточка
  const [journal, setJournal] = useState(null) // журнал по всему сервису
  const [nastroyki, setNastroyki] = useState(false) // тема и язык панели
  // Коды активации программы без интернета (1.6.0)
  const [kody, setKody] = useState(false)
  // Магазины, которые прямо сейчас заводятся. Создание идёт около пятнадцати секунд —
  // это настоящая работа базы, двадцать таблиц с индексами, — и всё это время
  // владелец сервиса не должен сидеть перед замершим окном.
  const [pending, setPending] = useState([])
  // Кто из магазинов сейчас за кассой. Приходит по связи и меняется сам —
  // это единственный способ увидеть, живой клиент или молчит вторую неделю.
  const [online, setOnline] = useState(() => onlineCodes())
  // Счётчик работы в открытом магазине: пробили чек — карточка обновилась сама
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
  // что было на момент загрузки: магазин завели с другого устройства — не видно,
  // клиент заплатил и его разблокировали — не видно. Кнопка «Обновить» осталась,
  // но нажимать её больше незачем.
  const openRow = useMemo(() => list.find((p) => p.id === openId), [list, openId])
  const openCode = openRow?.code
  useEffect(
    () =>
      onService((e) => {
        if (e.what === 'presence') setOnline(e.online || [])
        else if (e.what === 'pharmacies') load()
        // Работа идёт в открытой карточке — обновим её счётчики. Остальные магазины
        // торгуют весь день, и дёргать из-за них страницу незачем.
        else if (e.what === 'activity' && e.code && e.code === openCode) setBeat((n) => n + 1)
      }),
    [load, openCode],
  )

  // ── Пока магазин заводится, уходить со страницы нельзя ──
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

  // Найденные магазины: по названию, коду, владельцу, городу и телефону. Номер ищется и по одним
  // цифрам — «93777» находит «+992 93 777 12 12». Поиск есть только на телефоне (на компьютере
  // список виден целиком), поэтому на компьютере запрос всегда пустой
  const q = phone ? find.trim().toLowerCase() : ''
  const found = useMemo(() => {
    if (!q) return null
    const digits = q.replace(/\D/g, '')
    return [...urgent, ...rest].filter(
      (p) =>
        [p.name, p.code, p.ownerName, p.city, p.phone].some((v) => String(v || '').toLowerCase().includes(q)) ||
        (digits.length >= 3 && String(p.phone || '').replace(/\D/g, '').includes(digits)),
    )
  }, [q, urgent, rest])

  // Заведение магазина — единственное место в панели, где работа идёт долго:
  // создать схему, прогнать миграции, настроить, завести владельца. Держать окно
  // открытым всё это время незачем — оно закрывается сразу, а работа продолжается.
  //
  // Раньше запрос обрывался на пятнадцатой секунде и показывал «Сервер не отвечает»,
  // хотя магазин к тому моменту уже создавался. Худший вид ошибки: она врёт, а
  // повторное нажатие даёт «магазин с таким кодом уже заведён».
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
      // Логотип — уже уменьшенной картинкой (lib/logoImage.js); не выбран — магазин без логотипа
      logo: form.logo || undefined,
      // Товары из Excel — готовым списком (свой код товарам без штрихкода уже дан)
      products: form.tovary?.items?.length ? form.tovary.items : undefined,
      // Модули: выключенные (пусто — всё включено)
      modulesOff: form.modulesOff?.length ? form.modulesOff : undefined,
    }

    setForm(null)
    const mark = { key: 'new_' + Date.now(), code: body.code, name: body.name, city: body.city, demo: !!body.demo, tovary: body.products?.length || 0 }
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
        toast(`${t('Магазин завести не удалось')}: ${e.message}`, 'err')
      })
  }

  async function openJournal() {
    try {
      setJournal(await api.get('/admin/audit?limit=200'))
      setZhurnalShown(50)
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // «Выйти» на телефоне — с вопросом: там это значок рядом с другими, промах пальцем выкидывал
  // из панели, а пароль владельца сервиса длинный. На компьютере выходит сразу, как и было
  async function leave() {
    if (phone && !(await dialog.confirm({ title: t('Выйти из панели?'), confirmText: t('Выйти') }))) return
    logout()
  }

  // Логин и пароль нового магазина — одной запиской, чтобы сразу переслать клиенту
  async function copyCreated() {
    const text = `${t('Магазин')}: ${created.name}\n${t('Логин')}: ${created.ownerLogin}\n${t('Пароль')}: ${created.ownerPassword}`
    try {
      await navigator.clipboard.writeText(text)
      toast(t('Скопировано'))
    } catch {
      toast(t('Скопировать не получилось — перепишите логин и пароль вручную'), 'err')
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

  // Строка магазина, который сейчас заводится. По ней не щёлкнуть: карточки ещё нет.
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
            {p.tovary ? `${t('заводится с товарами')} (${p.tovary.toLocaleString('ru-RU')})…` : p.demo ? t('заводится с демо-данными…') : t('заводится…')}
          </span>
        </td>
      </tr>
    ))

  // admin-row: строка нажимается — на телефоне у карточки стрелка в углу (m-admin.css)
  const rows = (items) =>
    items.map((p) => (
      <tr key={p.id} className="admin-row" style={{ cursor: 'pointer' }} onClick={() => setOpenId(p.id)}>
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
          {p.phone && <div className="tag-cat">{phone ? <Tel phone={p.phone} stop /> : p.phone}</div>}
        </td>
        <td data-label={t('Оплачено до')}>
          {tjMoment(p.paidUntil)}
          {/* Заметка о звонке на компьютере — первые 24 знака, целиком — в подсказке. На телефоне
              подсказки нет: там заметка целиком, в две строки с многоточием (admin-zvonok, m-admin.css) */}
          {p.calledAt && (
            <div className={'tag-cat' + (phone ? ' admin-zvonok' : '')} title={p.callNote || ''}>
              ☎ {fmtDate(p.calledAt)}{p.callNote ? ': ' + (phone ? p.callNote : p.callNote.slice(0, 24)) : ''}
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

  // Блоки главного экрана — отдельно: на компьютере и на телефоне они стоят в разном порядке
  const svodka = sum && (
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
  )
  const chart = sum && (
    <Suspense fallback={null}>
      <RevenueChart data={sum.byMonth} />
    </Suspense>
  )
  const urgentPanel = urgent.length > 0 && (
    <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
      <h2 style={{ padding: '14px 16px 0' }}>
        <span className="h2-title">
          <span className="ic" style={{ color: 'var(--warn)' }}><LuTriangleAlert size={17} /></span>
          {t('Требуют внимания')}
        </span>
      </h2>
      {/* table-cards-wrap: на телефоне карточки магазинов отступают от краёв панели,
          иначе их рамка сливалась с рамкой панели; на компьютере обёртка ничего не меняет */}
      <div className="table-cards-wrap">
        <table className="table-cards">
          <thead>{head}</thead>
          <tbody>{rows(urgent)}</tbody>
        </table>
      </div>
    </div>
  )
  const allPanel = (
    // admin-all: на телефоне после списка идёт график — им нужен зазор (m-admin.css)
    <div className="panel admin-all" style={{ padding: 0 }}>
      <div className="table-cards-wrap">
        <table className="table-cards">
          <thead>{head}</thead>
          <tbody>
            {pendingRows()}
            {rows(rest)}
            {!loading && list.length === 0 && pending.length === 0 && (
              <tr><td colSpan="6" className="empty">{t('Магазинов пока нет. Нажмите «Завести магазин».')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    // admin-app: у панели своя разметка без бокового меню, и правила для узких
    // экранов ей нужны свои — общие написаны под разделы магазина
    <div className="app admin-app">
      <div className="main" style={{ marginLeft: 0 }}>
        <header className="topbar">
          <div className="topbar-left">
            <img src={emblem} alt="" width="34" height="34" className="admin-emblem" />
            <div>
              <h1>{t('Магазины')}</h1>
              <div className="sub">{list.length} {t('в обслуживании')} · {me?.name}</div>
            </div>
          </div>
          {/* На телефоне под значками — короткие подписи (admin-cap): подсказка title там не
              показывается, и «Коды активации» искали наугад. «Выйти» на телефоне — отдельно,
              в углу шапки (admin-logout, m-admin.css), а не рядом с «Завести магазин» */}
          <div className="topbar-actions">
            <button className={'btn ghost icon' + (phone ? ' admin-capbtn' : '')} onClick={load} title={t('Обновить')}>
              <LuRefreshCw size={16} />
              {phone && <span className="admin-cap">{t('Обновить')}</span>}
            </button>
            <button className={'btn ghost' + (phone ? ' admin-capbtn' : '')} onClick={() => setKody(true)} title={t('Коды активации')} data-testid="admin-licences">
              <span className="ic"><LuKeyRound size={16} /></span> <span className="btn-text">{t('Коды активации')}</span>
              {phone && <span className="admin-cap">{t('Коды')}</span>}
            </button>
            <button className={'btn ghost' + (phone ? ' admin-capbtn' : '')} onClick={openJournal} title={t('Журнал')}>
              <span className="ic"><LuScrollText size={16} /></span> <span className="btn-text">{t('Журнал')}</span>
              {phone && <span className="admin-cap">{t('Журнал')}</span>}
            </button>
            <button className={'btn ghost icon' + (phone ? ' admin-capbtn' : '')} onClick={() => setNastroyki(true)} title={t('Настройки панели')}>
              <LuSettings size={16} />
              {phone && <span className="admin-cap">{t('Настройки')}</span>}
            </button>
            <button className="btn" onClick={() => setForm({ ...emptyNew })} title={t('Завести магазин')}>
              <span className="ic"><LuPlus size={16} /></span> <span className="btn-text">{t('Завести магазин')}</span>
            </button>
            <button className={'btn ghost icon' + (phone ? ' admin-capbtn admin-logout' : '')} onClick={leave} title={t('Выйти')}>
              <LuLogOut size={16} />
              {phone && <span className="admin-cap">{t('Выйти')}</span>}
            </button>
          </div>
        </header>

        <main className="content">
          {phone ? (
            // ── Телефон: сначала ответ на «кому звонить сегодня» ──
            // Поиск и «Требуют внимания» — сразу под шапкой, затем сводка, все магазины и
            // график. Раньше до первой карточки магазина было полтора экрана сводки и графика
            <>
              <div className="admin-find">
                <input
                  type="search"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  placeholder={t('Найти: название, код или телефон')}
                  aria-label={t('Поиск')}
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-testid="admin-find"
                />
              </div>
              {found ? (
                <div className="panel" style={{ padding: 0 }}>
                  <div className="table-cards-wrap">
                    <table className="table-cards">
                      <thead>{head}</thead>
                      <tbody>
                        {rows(found)}
                        {found.length === 0 && <tr><td colSpan="6" className="empty">{t('Ничего не найдено')}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <>
                  {urgentPanel}
                  {svodka}
                  {allPanel}
                  {chart}
                </>
              )}
            </>
          ) : (
            <>
              {svodka}
              {chart}
              {urgentPanel}
              {allPanel}
            </>
          )}
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
          phone={phone}
        />
      )}

      {pick && (
        <SvodkaDetail
          kind={pick}
          list={list}
          payments={payments}
          t={t}
          phone={phone}
          onClose={() => setPick(null)}
          onOpen={(id) => {
            if (!id) return
            setPick(null)
            setOpenId(id)
          }}
        />
      )}

      {nastroyki && <Nastroyki onClose={() => setNastroyki(false)} />}
      {kody && <KodyAktivacii phone={phone} onClose={() => setKody(false)} />}
      {form && <NewPharmacy form={form} setForm={setForm} onStart={startCreate} toast={toast} t={t} phone={phone} />}

      {created && (
        // На телефоне это окно закрывается только кнопкой: затемнение над шторкой — больше
        // половины экрана, случайное касание (хотя бы при прокрутке) закрывало окно, а пароль
        // больше нигде не показывается. admin-created: плитки в столбик, логин и пароль крупно
        <Modal className="admin-modal admin-created" title={t('Магазин заведён')} onClose={phone ? undefined : () => setCreated(null)}>
          <div className="note err" style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
            <LuTriangleAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{t('Запишите пароль сейчас. Он больше нигде не показывается — потом его можно только задать заново.')}</span>
          </div>
          <div className="mini-cards" style={{ marginBottom: 16 }}>
            <div className="mini-card"><div className="m-label">{t('Магазин')}</div><div className="m-value sm">{created.name}</div></div>
            <div className="mini-card"><div className="m-label">{t('Логин')}</div><div className="m-value sm admin-secret" data-testid="created-login">{created.ownerLogin}</div></div>
            <div className="mini-card">
              <div className="m-label"><LuKeyRound size={11} style={{ verticalAlign: '-1px' }} /> {t('Пароль')}</div>
              <div className="m-value sm admin-secret" style={{ letterSpacing: 1 }} data-testid="created-password">{created.ownerPassword}</div>
            </div>
          </div>
          {created.imported && (
            <div className="note info" style={{ marginBottom: 16 }} data-testid="created-imported">
              {t('Товаров из Excel заведено')}: <b>{created.imported.created.toLocaleString('ru-RU')}</b>
              {created.imported.dropped ? ` · ${t('отброшено')}: ${created.imported.dropped}` : ''}
            </div>
          )}
          <div className="modal-actions">
            {/* На телефоне логин и пароль чаще всего тут же пересылают клиенту в мессенджер */}
            {phone && (
              <button type="button" className="btn ghost" onClick={copyCreated} data-testid="created-copy">
                <span className="ic"><LuCopy size={16} /></span> {t('Скопировать логин и пароль')}
              </button>
            )}
            <button className="btn" onClick={() => setCreated(null)}>{t('Записал')}</button>
          </div>
        </Modal>
      )}

      {journal && (
        <Modal className="admin-modal" title={t('Журнал действий')} onClose={() => setJournal(null)} wide>
          {/* admin-zhurnal: на телефоне своя прокрутка внутри окна-шторки не нужна — листается само окно.
              admin-log: там же запись — серой строкой «время · кто · магазин» над «что сделал» */}
          <div className="admin-zhurnal" style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table className="table-cards admin-log">
              <thead><tr><th>{t('Время')}</th><th>{t('Кто')}</th><th>{t('Магазин')}</th><th>{t('Что сделал')}</th></tr></thead>
              <tbody>
                {(phone ? journal.slice(0, zhurnalShown) : journal).map((a) => (
                  <tr key={a.id}>
                    <td className="tag-cat" data-label={t('Время')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                    <td data-label={t('Кто')}>{a.accountName || '—'}</td>
                    <td data-label={t('Магазин')}>{a.pharmacyCode || '—'}</td>
                    <td className="cell-main" data-label={t('Что сделал')}>{a.detail || a.action}</td>
                  </tr>
                ))}
                {journal.length === 0 && <tr><td colSpan="4" className="empty">{t('Записей пока нет')}</td></tr>}
              </tbody>
            </table>
          </div>
          {phone && journal.length > zhurnalShown && (
            <button type="button" className="btn ghost block admin-more" onClick={() => setZhurnalShown((n) => n + 50)}>
              {t('Показать ещё')} · {journal.length - zhurnalShown}
            </button>
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Заведение нового магазина ──
function NewPharmacy({ form, setForm, onStart, toast, t, phone }) {
  // Окно уже закрыли (картинка дорабатывалась после «Отмена» или «Завести») — не открываем его снова
  const set = (k, v) => setForm((f) => f && { ...f, [k]: v })
  // Картинка логотипа ещё готовится — «Завести» ждёт её, иначе магазин завёлся бы без логотипа
  const [logoBusy, setLogoBusy] = useState(false)
  // Ошибка проверки на телефоне: { field, msg }. Там она стоит под самим полем, пока его не
  // исправят: всплывающее сообщение исчезает через две с половиной секунды, лежит поверх
  // кнопок, а поле с ошибкой — экраном выше
  const [err, setErr] = useState(null)
  const fix = (k, v) => {
    set(k, v)
    if (err?.field === k) setErr(null)
  }

  // Всё, что можно проверить здесь, проверяется здесь: окно закрывается сразу,
  // и отказ, пришедший через полминуты, унёс бы с собой всё введённое. Сервер
  // проверяет то же самое ещё раз — он никому не верит на слово, и правильно.
  function submit() {
    const fail = (field, msg) => {
      if (!phone) return toast(msg, 'err')
      setErr({ field, msg })
      // К полю с ошибкой — сразу, с клавиатурой: его и надо исправить
      document.getElementById('np-' + field)?.focus()
    }
    const code = form.code.trim().toLowerCase()
    if (!CODE_RE.test(code)) {
      return fail('code', t('Код магазина: латинские буквы, цифры и дефис, от 2 до 31 символа. Например: shifo'))
    }
    if (!form.name.trim()) return fail('name', t('Укажите название магазина'))
    const pw = form.ownerPassword.trim()
    if (pw && pw.length < 6) return fail('ownerPassword', t('Пароль слишком короткий (минимум 6 символов)'))
    onStart()
  }
  const errUnder = (field) => err?.field === field && <div className="note err admin-field-err" role="alert">{err.msg}</div>
  // Код, логин и пароль: клавиатура телефона не ставит сама заглавную и не «исправляет» слово —
  // иначе логин заводился бы как «Shifo», а пароль подменялся бы словарём
  const latin = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
  return (
    <Modal className="admin-modal" title={t('Новый магазин')} onClose={() => setForm(null)}>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="np-code">{t('Код магазина')}</label>
          <input id="np-code" value={form.code} onChange={(e) => fix('code', e.target.value)} placeholder="shifo" autoFocus {...latin} />
          {errUnder('code')}
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="np-name">{t('Название')}</label>
          <input id="np-name" value={form.name} onChange={(e) => fix('name', e.target.value)} placeholder="Магазин Шифо" />
          {errUnder('name')}
        </div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Владелец')}</label>
          <input value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></div>
        {/* type="tel": на телефоне открывается цифровая клавиатура, а не буквенная */}
        <div className="field" style={{ flex: 1 }}><label>{t('Телефон')}</label>
          <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+992 …" /></div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Город')}</label>
          <input value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>{t('Пробный период, дней')}</label>
          <NumberInput value={form.trialDays} onChange={(e) => set('trialDays', e.target.value)} /></div>
      </div>

      <LogoField value={form.logo} onChange={(v) => set('logo', v)} onBusy={setLogoBusy} toast={toast} t={t} />

      {/* compact: на телефоне 14 галочек свёрнуты в строку «все включены · Изменить» — список
          занимал полтора экрана формы */}
      <ModuliVybor value={form.modulesOff} onChange={(v) => set('modulesOff', v)} t={t} testid="new-moduli" compact={phone} />

      <div className="note info" style={{ marginBottom: 14 }}>
        {t('Под этим логином войдёт владелец магазина. Пароль можно не задавать — он придумается и покажется один раз.')}
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>{t('Логин владельца')}</label>
          <input value={form.ownerLogin} onChange={(e) => set('ownerLogin', e.target.value)} placeholder={form.code || 'shifo'} {...latin} /></div>
        <div className="field" style={{ flex: 1 }}><label htmlFor="np-ownerPassword">{t('Пароль')}</label>
          <input id="np-ownerPassword" value={form.ownerPassword} onChange={(e) => fix('ownerPassword', e.target.value)} placeholder={t('придумается сам')} {...latin} />
          {errUnder('ownerPassword')}
        </div>
      </div>

      {/* admin-demo: на телефоне строка с галочкой — под палец (m-admin.css) */}
      <label className="admin-demo" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 16, opacity: form.tovary ? 0.5 : 1 }}>
        <input type="checkbox" style={{ width: 18, height: 18, flex: 'none', margin: 0 }} checked={form.demo && !form.tovary} disabled={!!form.tovary} onChange={(e) => set('demo', e.target.checked)} />
        {t('Заполнить демонстрационными товарами и продажами')}
      </label>

      {/* Товары клиента из его Excel — по желанию. С ними демо-товары не нужны: смешались бы */}
      <TovaryIzExcel value={form.tovary} onChange={(v) => setForm((f) => f && { ...f, tovary: v, demo: v ? false : f.demo })} t={t} />

      <div className="note info" style={{ marginBottom: 14, fontSize: 12.5 }}>
        {t('Заведение занимает около полуминуты — окно закроется сразу, работа пойдёт в фоне. Логин и пароль появятся, когда магазин будет готов.')}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={() => setForm(null)}>{t('Отмена')}</button>
        <button className="btn" onClick={submit} disabled={logoBusy}>{t('Завести')}</button>
      </div>
    </Modal>
  )
}

// ── Логотип магазина (1.6.4) ──
// Картинку выбирает владелец сервиса; она печатается на чеках, листах и видна на экране
// покупателя этого магазина. Здесь же она и готовится: пустые поля обрезаются, картинка
// уменьшается до 720×360 (lib/logoImage.js). Видно сразу, что получится; «Убрать» — магазин
// снова без логотипа, всё как прежде
// ── Карточка магазина ──
// Всё про одного клиента на одном экране: чем он живёт, сколько платил, кто у него
// за кассой и что мы с этим магазином делали. Перед звонком клиенту открывают её.
// Карточки, уже открывавшиеся за этот заход. Панель открыта весь день, и одну и ту же
// магазин смотрят по нескольку раз — второй раз он обязана открываться мгновенно.
const seenCards = new Map()
const seenUsage = new Map()

function PharmacyCard({ id, row, beat, live, onClose, onChanged, toast, dialog, t, phone }) {
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
  // Дозагрузка товаров из Excel: { tovary: разобранный файл, busy }
  const [zagruzka, setZagruzka] = useState(null)
  // Картинка логотипа в «Изменить магазин» ещё готовится
  const [logoBusy, setLogoBusy] = useState(false)
  // Логотип магазина: undefined — ещё грузится, '' — логотипа нет. Картинка лежит отдельно
  // от карточки и забирается заново, когда меняется отметка logoAt
  const [logo, setLogo] = useState(() => (row && !row.logoAt ? '' : undefined))
  useEffect(() => {
    let alive = true
    if (!ph.logoAt) {
      setLogo('')
      return undefined
    }
    api
      .get(`/admin/pharmacies/${id}/logo`)
      .then((r) => alive && setLogo(typeof r?.logo === 'string' ? r.logo : ''))
      .catch(() => alive && setLogo(''))
    return () => {
      alive = false
    }
  }, [id, ph.logoAt])

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
  // За ними надо идти в схему самого магазина, и если тот давно не работал —
  // подключение к ней открывается заново. Держать из-за этого весь экран нельзя.
  async function zagruzit() {
    const items = zagruzka?.tovary?.items
    if (!items?.length) return
    setZagruzka((z) => ({ ...z, busy: true }))
    try {
      const r = await api.post(`/admin/pharmacies/${id}/products`, { products: items }, { timeout: LONG_TIMEOUT_MS })
      setZagruzka(null)
      toast(`${t('Товары загружены')}: ${r.created.toLocaleString('ru-RU')}${r.existed ? ` · ${t('уже были в магазине')}: ${r.existed}` : ''}`)
      loadUsage()
      onChanged?.()
    } catch (e) {
      setZagruzka((z) => z && { ...z, busy: false })
      toast(`${t('Товары не загрузились')}: ${e.message}`, 'err')
    }
  }

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

  // beat — в этом магазине только что шла работа: перезапросим счётчики продаж
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
      title: stop ? t('Приостановить работу магазина?') : t('Возобновить работу магазина?'),
      message: stop
        ? `${ph.name}: ${t('касса перестанет работать до возобновления. Данные останутся на месте.')}`
        : `${ph.name}: ${t('магазин снова сможет продавать.')}`,
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
      // На телефоне номер — ссылкой: позвонить можно прямо отсюда, а потом записать, что сказали
      message: phone && ph.phone ? (
        <>
          {ph.name}
          <span className="admin-tel-line"><Tel phone={ph.phone} /></span>
        </>
      ) : (
        `${ph.name}${ph.phone ? ' · ' + ph.phone : ''}`
      ),
      fields: [{ name: 'note', label: t('Что сказали'), placeholder: t('обещал оплатить в пятницу') }],
      confirmText: t('Записать'),
    })
    if (!r) return
    await act(() => api.post(`/admin/pharmacies/${id}/called`, { note: r.note || '' }), t('Звонок отмечен'))
  }

  async function enter() {
    const ok = await dialog.confirm({
      title: t('Войти под владельцем магазина?'),
      message: t('Вы увидите магазин его глазами, включая закупочные цены и выручку. Вход записывается в журнал, а вернуться можно одним нажатием.'),
      confirmText: t('Войти'),
    })
    if (!ok) return
    try {
      await enterPharmacy(id)
      // Дальше приложение само покажет магазин: в токене уже её владелец
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function removeIt() {
    const r = await dialog.prompt({
      title: t('Удалить магазин?'),
      message: `${t('Будут стёрты все её данные: товары, продажи, долги, история. Восстановить их можно только из копии, которую делал сам владелец. Наберите код магазина')}: ${ph.code}`,
      fields: [{ name: 'code', label: t('Код магазина') }],
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!r) return
    // Коды магазинов всегда строчные, а клавиатура телефона сама ставит заглавную первую
    // букву («Bahor»). Сравниваем без регистра, как и сервер; не совпал — говорим об этом:
    // раньше окно молча закрывалось, и было непонятно, удалён магазин или нет
    if (r.code.trim().toLowerCase() !== ph.code) {
      toast(t('Код не совпал — магазин не удалён'), 'err')
      return
    }
    try {
      // Удаление стирает схему со всем содержимым — на большом магазине это не мгновение
      await api.del(`/admin/pharmacies/${id}?confirm=${encodeURIComponent(ph.code)}`, {
        timeout: LONG_TIMEOUT_MS,
      })
      toast(t('Магазин удалён'))
      onClose()
      await onChanged()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // Строки списка не оказалось — так бывает разве что при переходе по прямой ссылке.
  // Тогда ждать всё-таки придётся.
  if (!ph.id) {
    return <Modal className="admin-modal" title={t('Магазин')} onClose={onClose}><div className="empty">{t('Загрузка…')}</div></Modal>
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

      {/* admin-card-acts: на телефоне кнопки встают ровной сеткой в два столбца (m-admin.css) */}
      <div className="admin-card-acts" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
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
              // Логотип меняется, только если его тронули в окне: иначе «Сохранить» его не касается
              logo: '',
              logoChanged: false,
              modulesOff: Array.isArray(ph.modulesOff) ? ph.modulesOff : [],
            })
          }
        >
          <span className="ic"><LuPencil size={16} /></span> {t('Изменить')}
        </button>
        <button className="btn ghost" onClick={() => setZagruzka({ tovary: null, busy: false })} disabled={busy} data-testid="card-excel">
          <span className="ic"><LuFileSpreadsheet size={16} /></span> {t('Товары из Excel')}
        </button>
        <button className="btn ghost" onClick={removeIt} disabled={busy} style={{ marginLeft: 'auto', color: 'var(--danger)' }}>
          <span className="ic"><LuTrash2 size={16} /></span> {t('Удалить')}
        </button>
      </div>

      <Section title={t('Контакты')}>
        <Kv
          label={t('Логотип')}
          value={
            logo ? (
              <img className="admin-logo-thumb" src={logo} alt={t('Логотип')} data-testid="card-logo" />
            ) : logo === undefined ? (
              '…'
            ) : (
              t('нет')
            )
          }
        />
        <Kv label={t('Владелец')} value={ph.ownerName || '—'} />
        <Kv label={t('Телефон')} value={phone ? <Tel phone={ph.phone} /> : ph.phone || '—'} />
        <Kv label={t('Город')} value={ph.city || '—'} />
        <Kv label={t('Модули')} value={<span data-testid="card-moduli">{moduliText(ph.modulesOff, t)}</span>} />
        {ph.note && <Kv label={t('Примечание')} value={ph.note} />}
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
        <Section title={t('Что делали с этим магазином')}>
          {/* admin-log: на телефоне — компактной записью, как в журнале действий */}
          <table className="table-cards admin-log">
            <tbody>
              {ph.audit.map((a) => (
                <tr key={a.id}>
                  {/* Подписи — как у колонок журнала действий: на телефоне строка становится карточкой */}
                  <td className="tag-cat" data-label={t('Время')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                  <td className="tag-cat" data-label={t('Кто')}>{a.accountName || '—'}</td>
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

      {zagruzka && (
        <Modal className="admin-modal" title={t('Товары из Excel')} onClose={() => !zagruzka.busy && setZagruzka(null)}>
          <div className="note info" style={{ marginBottom: 12 }}>
            {t('Товары добавятся в магазин. Товары с тем же штрихкодом, что уже есть в магазине, не трогаются.')}
          </div>
          <TovaryIzExcel value={zagruzka.tovary} onChange={(v) => setZagruzka((z) => z && { ...z, tovary: v })} disabled={zagruzka.busy} t={t} />
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setZagruzka(null)} disabled={zagruzka.busy}>{t('Отмена')}</button>
            <button className="btn" onClick={zagruzit} disabled={zagruzka.busy || !zagruzka.tovary?.items?.length} data-testid="card-excel-go">
              {zagruzka.busy ? t('Загружаем…') : t('Загрузить')}
            </button>
          </div>
        </Modal>
      )}

      {edit && (
        <Modal className="admin-modal" title={t('Изменить магазин')} onClose={() => setEdit(null)}>
          {/* На телефоне без автофокуса: клавиатура выезжала сразу и закрывала пол-экрана, хотя
              здесь обычно меняют срок, модули или логотип, а не название */}
          <div className="field"><label>{t('Название')}</label>
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus={!phone} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>{t('Владелец')}</label>
              <input value={edit.ownerName} onChange={(e) => setEdit({ ...edit, ownerName: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label>{t('Телефон')}</label>
              <input type="tel" inputMode="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>{t('Город')}</label>
              <input value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label>{t('Оплачено до')}</label>
              {/* admin-srok: на телефоне поле часа вылезало за край окна — там дата и час делят ряд сеткой */}
              <div className="admin-srok" style={{ display: 'flex', gap: 8 }}>
                <input type="date" style={{ flex: 1 }} value={edit.paidUntil}
                  onChange={(e) => setEdit({ ...edit, paidUntil: e.target.value })} />
                <input type="time" style={{ width: 110 }} value={edit.paidTime}
                  onChange={(e) => setEdit({ ...edit, paidTime: e.target.value })} />
              </div>
              <div className="tag-cat">{t('В этот момент работа магазина прекратится')}</div>
            </div>
          </div>
          <div className="field"><label>{t('Примечание')}</label>
            <input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></div>
          <LogoField
            value={edit.logoChanged ? edit.logo : logo || ''}
            loading={!edit.logoChanged && logo === undefined}
            // Картинка готовится не мгновенно: берём окно таким, каким оно стало к этому
            // моменту (иначе откатились бы поля, набранные за это время), а закрытое — не открываем
            onChange={(v) => setEdit((e) => e && { ...e, logo: v, logoChanged: true })}
            onBusy={setLogoBusy}
            toast={toast}
            t={t}
          />
          <ModuliVybor value={edit.modulesOff} onChange={(v) => setEdit((e) => e && { ...e, modulesOff: v })} t={t} testid="edit-moduli" compact={phone} />
          <div className="note info" style={{ marginBottom: 14 }}>
            {t('Дату меняют, когда ошиблись при вводе, дают бесплатное продление или закрывают сразу. Обычную оплату лучше проводить кнопкой «Продлить» — она попадёт в историю оплат.')}
          </div>

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEdit(null)} disabled={busy}>{t('Отмена')}</button>
            <button
              className="btn"
              // Пока картинка логотипа готовится, «Сохранить» ждёт её
              disabled={busy || logoBusy}
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
                        // Логотип: новая картинка или '' (убрать); не трогали — поле не отправляем
                        logo: edit.logoChanged ? edit.logo : undefined,
                        // Модули: выключенные (пусто — всё включено)
                        modulesOff: edit.modulesOff,
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
// Плитка сводки — отдельным компонентом, а не внутри Svodka. Объявленная внутри, она при каждой
// перерисовке была бы новым компонентом, и React пересоздавал бы все семь кнопок, а панель
// перерисовывается сама по событиям связи. Касание, пришедшееся на такую замену (палец опустился
// на старую кнопку, поднялся над новой), на телефоне терялось — плитка «не нажималась»
// sum — денежная плитка: на телефоне она во всю ширину, а «сомони» — мельче числа (svodka-money,
// cur в m-admin.css). На компьютере разметка даёт тот же вид, что и прежде
function SvodkaCard({ kind, label, value, note, danger, sum, onPick, t }) {
  const cut = sum ? /^(.*) (\S+)$/.exec(value) : null
  return (
    <button className={'mini-card svodka-card' + (sum ? ' svodka-money' : '')} onClick={() => onPick(kind)} title={t('Показать список')}>
      <div className="m-label">{label}</div>
      <div className="m-value" style={danger ? { color: 'var(--danger)' } : undefined}>
        {cut ? <>{cut[1]} <span className="cur">{cut[2]}</span></> : value}
      </div>
      <div className="tag-cat">{note}</div>
    </button>
  )
}

function Svodka({ s, t, onPick }) {
  const { money: m, clients: c } = s
  const diff = m.prevMonth > 0 ? Math.round(((m.thisMonth - m.prevMonth) / m.prevMonth) * 100) : null
  // Общее у всех плиток: что делать по нажатию и перевод
  const own = { onPick, t }

  return (
    // admin-svodka: на телефоне деньги — строками во всю ширину, клиенты — по две плитки в ряд
    <div className="mini-cards admin-svodka" style={{ marginBottom: 16 }}>
      <SvodkaCard
        {...own}
        sum
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
      <SvodkaCard {...own} sum kind="expected" label={t('Ожидается за 30 дней')} value={money(m.expected30)} note={t('если все продлят')} />
      <SvodkaCard
        {...own}
        sum
        kind="all"
        label={t('Доход за всё время')}
        value={money(m.allTime)}
        note={`${t('средний платёж')} ${money(m.avgPayment)}`}
      />
      <SvodkaCard {...own} kind="paying" label={t('Платят')} value={c.paying} note={`${t('из')} ${c.total} ${t('всего')}`} />
      <SvodkaCard
        {...own}
        kind="trial"
        label={t('Пробный период')}
        value={c.trial}
        note={`+${c.newThisMonth} ${t('новых за месяц')}`}
      />
      <SvodkaCard
        {...own}
        kind="expired"
        label={t('Срок вышел')}
        value={c.expired + c.blocked}
        danger={c.expired + c.blocked > 0}
        note={`${t('работа остановлена')}`}
      />
      <SvodkaCard
        {...own}
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
function SvodkaDetail({ kind, list, payments, onClose, onOpen, t, phone }) {
  const titles = {
    month: t('Платежи за этот месяц'),
    expected: t('Кому продлевать в ближайшие 30 дней'),
    all: t('Сколько принёс каждый клиент'),
    paying: t('Платящие клиенты'),
    trial: t('На пробном периоде'),
    expired: t('Работа остановлена'),
    silent: t('Оплачены, но не торгуют'),
  }

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
              <tr key={p.id} className="admin-row" style={{ cursor: 'pointer' }} onClick={() => onOpen(p.pharmacy?.id)}>
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
              <tr key={p.id} className="admin-row" style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)}>
                <td className="cell-main" data-label={t('Клиент')}>{p.name}<div className="tag-cat">{p.code}</div></td>
                <td className="tag-cat" data-label={t('Телефон')}>{phone && p.phone ? <Tel phone={p.phone} stop /> : p.phone || '—'}</td>
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
      {/* На телефоне строк нет — есть карточки, и по ним не щёлкают, а нажимают */}
      <div className="tag-cat" style={{ marginTop: 10 }}>
        {phone ? t('Нажмите на клиента, чтобы открыть его карточку') : t('Щёлкните по строке, чтобы открыть карточку клиента')}
      </div>
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

// На телефоне подпись стоит над значением (m-admin.css): рядом с подписью длинная ссылка или
// почта в примечании не переносилась и уводила всю карточку вбок
function Kv({ label, value }) {
  return (
    <div className="kv" style={{ display: 'flex', gap: 10, fontSize: 14, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)', minWidth: 110 }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}
