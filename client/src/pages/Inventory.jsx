import { useState, useEffect, useMemo, useRef } from 'react'
import { LuClipboardCheck, LuPlus, LuCircleCheck, LuTriangleAlert, LuTrash2, LuScanBarcode, LuX } from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'
import { useCollection, money, refresh, db, setCollection, stockText } from '../db/store'
import { api, LONG_TIMEOUT_MS } from '../db/api'
import { fmtDateTime, serverNow } from '../lib/time'
import { useT } from '../lib/i18n'
import { useCategories, categoryNames } from '../lib/categories'
import NumberInput from '../components/NumberInput'
import VesInput from '../components/VesInput'
import { isVesovoy, kgText, splitUnits, edinica, opensPack, unitsText, gramsOfKg } from '../lib/units'
import ProductPick from './prihod/ProductPick'
import { beepError } from '../lib/sound'
import { productByCode } from '../lib/pick'
import {
  MAX_PICKED, OTBOR_STARYY_MS, izOtbora, naverh, otborNachat, plusSkan, polyaIzOtbora, poryadokStrok, readOtbor, skanVPole,
  vOtbor, vOtboreStavim, writeOtbor, zaSkan, zhivyeVOtbore,
} from '../lib/skanPereschet'
import {
  MAX_DIGITS, countOf, shownOf, retype, deltaOf, merged, settle, sameCounts, tally,
  readDraft, writeDraft, dropDraft, closeDraft, pruneDrafts,
} from '../lib/pereschet'
import { useCan } from '../db/auth'

// ── Инвентаризация (пересчёт остатков) ──
// 1) Создаём лист — система записывает, сколько товара должно быть.
// 2) Считаем по полкам и вносим фактическое количество.
// 3) Применяем: остатки становятся такими, как насчитали, недостача идёт в списание.
// Пока лист не применён, на складе ничего не меняется.
//
// Лист считают часами и с разных устройств, поэтому на экране — числа с сервера, а
// поверх них то, что ввели здесь; на сервер уходят только изменённые здесь строки
// (см. lib/pereschet.js).

// Сервер отвечает на «чем кончилось применение», только когда оно закончится, а
// большой лист применяется не мгновенно — ждём дольше обычных пятнадцати секунд
const LOOK_TIMEOUT_MS = 60000
// Через сколько спросить сервер о листе ещё раз
const LOOK_AGAIN_MS = 3000
// «Что пересчитываем» → товары, отобранные сканером (1.7.2). Лист из них сервер называет
// этими словами (inventory.service, PICKED_SCOPE); они же уходят охватом — сервер прежней
// версии принял бы их за категорию и отказал «нет товаров», а не завёл бы весь склад
const PICKED = '__picked'
const PICKED_SCOPE = 'Выбранные товары'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// Один лист с сервера. wait — «ответь, когда закончится идущее применение».
// null — сервер такого запроса не знает: он прежней версии. Сайт обновляется на минуты
// раньше сервера, и в эти минуты страница обязана работать с ним по-старому (см. apply
// и sheetState). Когда сервер обновлён, эту ветку можно убрать.
async function fetchSheet(id, wait) {
  try {
    return await api.get(`/inventory/${id}${wait ? '?wait=1' : ''}`, wait ? { timeout: LOOK_TIMEOUT_MS } : undefined)
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

// Что с листом на самом деле: сам лист или null, если его больше нет. Узнать не
// удалось — бросает.
// unsure — чем кончился наш запрос, неизвестно (связь оборвалась, сервер не ответил):
// он мог ещё идти к серверу, когда тот ответил «не применён». Тогда смотрим второй раз
async function sheetState(id, unsure) {
  const look = async () => {
    try {
      const one = await fetchSheet(id, true)
      if (one) return one
      // Сервер прежней версии: судьбу листа видно только в общем списке
      return (await api.get('/inventory')).find((x) => x.id === id) || null
    } catch (e) {
      if (e.status === 400) return null // «Лист не найден»
      throw e
    }
  }
  let got
  try {
    got = await look()
  } catch {
    await pause(LOOK_AGAIN_MS)
    return look()
  }
  if (unsure && got && got.status !== 'applied') {
    await pause(LOOK_AGAIN_MS)
    got = await look().catch(() => got)
  }
  return got
}

export default function Inventory() {
  const can = useCan()
  const products = useCollection('products')
  const categories = categoryNames(useCategories())
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [list, setList] = useState([])
  const [open, setOpen] = useState(null) // открытый лист — таким, каким он лежит на сервере
  const [typed, setTyped] = useState({}) // строка листа → что ввели здесь и чего на сервере ещё нет
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // чем кончилось применение, если не так, как ждали
  const [scope, setScope] = useState('all')
  // ── Сканер (1.7.2) ──
  // Список отбора для листа «Выбранные товары» — у каждого магазина свой, переживает уход
  // со страницы. Поля «Штрихкод» и «Наименование» — одни на оба места (список отбора и
  // открытый лист видны не одновременно)
  const shop = getUser()?.pharmacy?.code || ''
  const [otbor, setOtborState] = useState(() => readOtbor(shop))
  const setOtbor = (fn) => {
    const next = typeof fn === 'function' ? fn(readOtbor(shop)) : fn
    writeOtbor(shop, next)
    setOtborState(next)
  }
  const otborRows = useMemo(() => zhivyeVOtbore(otbor, products), [otbor, products])
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const [pick, setPick] = useState({ code: '', name: '' })
  const scanRef = useRef(null)
  const [top, setTop] = useState([]) // строки открытого листа, отсканированные здесь: свежая — первой
  const [focusRow, setFocusRow] = useState(null) // строка, в чьё поле поставить курсор (весовой товар)

  // Открыта ли ещё эта страница: ответ на применение может прийти, когда человек уже ушёл
  const here = useRef(true)
  useEffect(() => {
    // Выставляется при каждом появлении страницы: в режиме разработки React убирает
    // и ставит её заново, и без этого отметка осталась бы «ушли» навсегда
    here.current = true
    return () => {
      here.current = false
    }
  }, [])

  // Какой лист открыт сейчас: ответ сервера по листу, который уже закрыли, не должен
  // ни открыть его снова, ни подменить числа в другом
  const openId = useRef(null)
  // Листы, которые эта страница применяет прямо сейчас. На экране они уже «применены»,
  // и перебивать это ответами на более ранние запросы нельзя
  const applying = useRef(new Set())

  // Сообщить, чем кончилось применение. Человек успел уйти на другую страницу — узнать
  // он должен и там
  function tell(n) {
    if (here.current) setNotice(n)
    else toast(n.message ? `${noticeText(n.kind).title}: ${n.message}` : noticeText(n.kind).title, 'err')
  }

  // Заголовок и объяснение для сообщения о применении
  function noticeText(kind) {
    if (kind === 'unknown') {
      return {
        title: t('Не удалось узнать, применён ли пересчёт'),
        text: t('Запрос ушёл, а ответ не пришёл: пересчёт мог примениться, а мог и нет. Когда связь появится, откройте этот лист: если он не применён, введённые числа будут на месте — примените его заново.'),
      }
    }
    if (kind === 'other') {
      return {
        title: t('Пересчёт применён с другими числами'),
        text: t('Этот лист уже применён — но не с теми числами, что были на этом устройстве. Так бывает, если его применили с другого устройства или первая попытка прошла, а ответ на неё потерялся. Остатки на складе стоят по применённому листу. Откройте его и сверьте; чтобы исправить остатки, создайте новый лист.'),
      }
    }
    return {
      title: t('Пересчёт не применён'),
      text: t('Остатки на складе вернулись к прежним. Введённые числа остались на этом устройстве — откройте лист и примените заново.'),
    }
  }

  async function load() {
    try {
      const all = await api.get('/inventory')
      // Лист, который применяется прямо сейчас, на сервере ещё может значиться
      // неприменённым — на экране он остаётся таким, каким его показали
      setList((prev) => all.map((x) => (applying.current.has(x.id) ? prev.find((y) => y.id === x.id) || x : x)))
      // Листы, применённые с другого устройства: введённое здесь им больше не нужно.
      // А если оно в применённый лист не попало, человек должен об этом узнать
      const missed = pruneDrafts(all, { skip: applying.current })
      if (missed.length) tell({ kind: 'other', sheet: missed[0] })
    } catch (e) {
      toast(e.message, 'err')
    }
  }
  useEffect(() => {
    load()
  }, [])

  // Показать лист: числа с сервера и поверх них — введённое на этом устройстве
  function show(inv) {
    if (openId.current !== inv.id) {
      setTop([])
      setPick({ code: '', name: '' })
    }
    openId.current = inv.id
    setOpen(inv)
    setTyped(inv.status === 'applied' ? {} : readDraft(inv.id))
  }

  function close() {
    openId.current = null
    setOpen(null)
    setTop([])
    setPick({ code: '', name: '' })
  }

  // Лист оказался применённым — не отсюда или отсюда, но ответ тогда потерялся
  function foundApplied(sheet) {
    const missed = closeDraft(sheet)
    setList((ls) => ls.map((x) => (x.id === sheet.id ? sheet : x)))
    if (openId.current === sheet.id) {
      setOpen(sheet)
      setTyped({})
    }
    refresh('products')
    if (missed) tell({ kind: 'other', sheet })
    return missed
  }

  async function createSheet() {
    const picked = scope === PICKED
    // Отобранное сканером — то, что стоит в списке сейчас (без товаров, удалённых с тех пор)
    const rows = picked ? otborRows : []
    if (picked && !rows.length) {
      toast(t('Отсканируйте товары, которые будете пересчитывать'), 'err')
      scanRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      // Пересчёт всего склада — это тысячи строк одним запросом, и на сервере
      // ему отведены минуты. Обычные пятнадцать секунд оборвали бы его на полпути:
      // сотрудник, считавший товар весь день, получил бы «сервер не отвечает»
      // вместо сохранения, а работа на сервере при этом доделалась бы.
      const body = picked ? { scope: PICKED_SCOPE, productIds: rows.map((r) => r.productId) } : { scope }
      const inv = await api.post('/inventory', body, { timeout: LONG_TIMEOUT_MS })
      show(inv)
      if (picked) {
        // Насчитанное сканером — сразу в «По факту» и на сервер, как «Сохранить черновик»
        const fields = polyaIzOtbora(inv, rows)
        if (Object.keys(fields).length) {
          let next = readDraft(inv.id)
          for (const item of inv.items) if (fields[item.id] !== undefined) next = retype(next, item, fields[item.id])
          writeDraft(inv.id, next)
          setTyped(next)
          sendDraft(inv, { quiet: true })
        }
        // Список отбора стал листом: уходят отправленные товары (пока лист заводился, сканер
        // заперт, но и пришедшее мимо него не пропадёт)
        const sent = new Set(rows.map((r) => r.productId))
        setOtbor((l) => l.filter((r) => !sent.has(r.productId)))
        setPick({ code: '', name: '' })
      }
      await load()
      toast(t('Лист пересчёта создан'))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  // Листа больше нет — его удалили с другого устройства
  function gone(id, message) {
    toast(message, 'err')
    dropDraft(id)
    if (openId.current === id) close()
    load()
  }

  // Подтянуть лист с сервера: с другого устройства в него могли внести числа, его
  // могли применить или удалить
  async function renew(id) {
    let fresh
    try {
      fresh = await fetchSheet(id)
    } catch (e) {
      // Нет связи — остаётся то, что показано; перед применением спросим ещё раз
      if (e.status === 400) gone(id, e.message)
      return
    }
    // Пока шёл запрос, лист успели применить отсюда же — его судьбу решает ответ на
    // применение, и показанное на экране этим ответом перебивать нельзя
    if (!fresh || applying.current.has(id)) return
    if (fresh.status === 'applied') return foundApplied(fresh)
    setList((ls) => ls.map((x) => (x.id === id ? fresh : x)))
    if (openId.current === id) setOpen(fresh)
  }

  function openSheet(inv) {
    // Сразу — то, что есть в списке; следом подтягивается свежий лист. Список мог
    // загрузиться час назад, а за этот час числа вносили с другого устройства
    show(inv)
    // Применённый лист уже не изменится
    if (inv.status !== 'applied') renew(inv.id)
  }

  // Человек изменил поле «по факту». Введённое сразу ложится и на устройство
  function type(item, value) {
    // Длину держит и само поле; здесь — на случай, когда значение пришло мимо клавиатуры
    const next = retype(readDraft(open.id), item, value.slice(0, MAX_DIGITS))
    writeDraft(open.id, next)
    setTyped(next)
  }

  const sum = useMemo(() => tally(open ? merged(open, typed) : null, products), [open, typed, products])

  // ── Сканер (1.7.2) ──
  // После скана курсор возвращается в «Штрихкод»: следующий скан идёт туда же
  const refocusScan = () => setTimeout(() => scanRef.current?.focus(), 0)
  // Поле, в которое курсор поставил скан (весовой товар): Enter в нём — обратно к сканеру
  const skanFocus = useRef(null)
  // Весовой товар сканом не считают — курсор встаёт в его поле (строка уже наверху)
  useEffect(() => {
    if (!focusRow) return
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusRow) : focusRow
    const el = document.querySelector(`[data-inv-row="${sel}"]`)
    if (el) {
      skanFocus.current = focusRow
      el.focus()
      el.select?.()
    }
    setFocusRow(null)
  }, [focusRow])

  // ── Поля количества и веса ──
  // Сканер выстрелил, пока курсор в поле количества (весовой товар после скана, правка
  // руками), — это скан, а не количество: поле возвращается к тому, что в нём было перед
  // первой цифрой кода, товар считается как со сканера (lib/skanPereschet.js, skanVPole).
  // Enter после скана весового и в списке отбора — обратно к сканеру; в длинном листе после
  // правки руками курсор остаётся на месте: прыжок наверх потерял бы строку, на которой
  // человек стоит.
  // key — поле (data-inv-row), setRaw — поставить в поле текст (как его набрали бы),
  // onScan — что делать со сканом, always — Enter всегда ведёт к сканеру.
  // Перед каждым знаком запоминается текст поля: по нему видно, что было до кода
  const pole = useRef({ key: null, buf: '', snaps: [] })
  const poleProps = (key, setRaw, onScan, always = false) => ({
    'data-inv-row': key,
    onFocus: () => {
      pole.current = { key, buf: '', snaps: [] }
    },
    onKeyDown: (e) => {
      if (pole.current.key !== key) pole.current = { key, buf: '', snaps: [] }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pole.current.snaps.push(e.currentTarget.value)
        pole.current.buf += e.key
        return
      }
      if (e.key !== 'Enter') return
      const { buf, snaps } = pole.current
      const hit = skanVPole(buf, products, productByCode)
      const back = always || skanFocus.current === key
      pole.current = { key, buf: '', snaps: [] }
      if (hit) {
        e.preventDefault()
        setRaw(snaps[snaps.length - hit.len] ?? '')
        skanFocus.current = null
        return onScan(hit.product)
      }
      if (back) {
        e.preventDefault()
        skanFocus.current = null
        scanRef.current?.focus()
      }
    },
  })

  // Скан в открытом листе: строка товара — наверх, к насчитанному — одна упаковка
  function skanVListe(p) {
    setPick({ code: '', name: '' })
    const item = open.items.find((i) => i.productId === p.id)
    if (!item) {
      beepError()
      toast(`${p.name}: ${t('этого товара нет в листе')}`, 'err')
      refocusScan()
      return
    }
    setTop((tp) => naverh(tp, item.id))
    if (open.status === 'applied') return refocusScan()
    if (zaSkan(p) === null) return setFocusRow(item.id)
    // Насчитанное — из хранилища, а не из состояния страницы: два скана подряд быстрее
    // перерисовки, и второй не должен потерять первый
    type(item, String(plusSkan(countOf(shownOf(item, readDraft(open.id))), p)))
    refocusScan()
  }

  // Скан в «Выбранных товарах»: товар — наверх списка, к насчитанному — одна упаковка
  function skanVOtbor(p) {
    setPick({ code: '', name: '' })
    const list = readOtbor(shop)
    if (!list.some((r) => r.productId === p.id) && list.length >= MAX_PICKED) {
      beepError()
      toast(`${t('В одном листе — не больше')} ${MAX_PICKED} ${t('товаров')}`, 'err')
      return refocusScan()
    }
    setOtbor((l) => vOtbor(l, p))
    if (zaSkan(p) === null) return setFocusRow('pick:' + p.id)
    refocusScan()
  }

  // Поля «Штрихкод» и «Наименование» — одни на оба места
  const skanPolya = (onPick, readOnly = false) => (
    <div className="inv-scan">
      <ProductPick
        readOnly={readOnly}
        ids={{ code: 'inv-code', name: 'inv-name' }}
        codeRef={scanRef}
        products={products}
        code={pick.code}
        name={pick.name}
        chosen={null}
        onCode={(v) => setPick((f) => ({ ...f, code: v }))}
        onName={(v) => setPick((f) => ({ ...f, name: v }))}
        onPick={onPick}
        // Незнакомый код — поле очищается: следующий скан иначе дописался бы к нему
        onUnknownCode={(code) => {
          setPick({ code: '', name: '' })
          toast(`${t('Товар с таким штрихкодом не найден')}: ${code}`, 'err')
          refocusScan()
        }}
        onUnknownName={() => toast(t('Товар не найден'), 'err')}
        hint={<><span className="ic"><LuScanBarcode size={16} /></span>{t('Каждый скан — плюс одна упаковка. Весовой товар — введите вес в его поле.')}</>}
      />
    </div>
  )

  // Черновик сохраняется мгновенно: сотрудник ходит по полкам и не должен ждать
  // ответа сервера после каждого сохранения. Введённое уже лежит на устройстве; на
  // сервер уходят только строки, изменённые здесь
  function saveDraft() {
    sendDraft(open)
  }
  // sheet — лист, каким его показали (только что созданный ещё не стоит в open);
  // quiet — без «Пересчёт сохранён»: сохраняет сама страница, а не человек
  function sendDraft(sheet, { quiet = false } = {}) {
    const id = sheet.id
    const sent = readDraft(id)
    const items = deltaOf(sheet, sent)
    if (!quiet) toast(t('Пересчёт сохранён'))
    if (!items.length) return
    api.patch(`/inventory/${id}`, { items }, { timeout: LONG_TIMEOUT_MS }).then(
      (saved) => {
        // Лист с тех пор применили отсюда же — его судьбу решает ответ на применение
        if (applying.current.has(id)) return
        // Сервер вернул лист целиком — вместе с тем, что внесли с других устройств.
        // Из «введённого здесь» уходит то, что он принял и что с тех пор не меняли
        const next = settle(readDraft(id), sent)
        writeDraft(id, next)
        setList((ls) => ls.map((x) => (x.id === id ? saved : x)))
        if (openId.current === id) {
          setOpen(saved)
          setTyped(next)
        }
      },
      (e) => {
        if (applying.current.has(id)) return
        // Отказ по существу — лист уже применили или удалили с другого устройства:
        // узнаём, что с ним, и говорим об этом
        if (e.status === 400) {
          toast(`${t('На сервере пересчёт не сохранён')}: ${e.message}`, 'err')
          renew(id)
          return
        }
        const why = /[.!?…]$/.test(e.message) ? e.message : e.message + '.'
        toast(`${t('На сервере пересчёт не сохранён')}: ${why} ${t('Введённые числа остались на этом устройстве.')}`, 'err')
      },
    )
  }

  async function apply() {
    const id = open.id
    // Сначала — свежий лист. С другого устройства в него могли внести числа, а то и
    // применить его: спроси мы «применить?» по тому, что на экране с утра, человек
    // подтвердил бы одни итоги, а применились бы другие
    let sheet = open
    let old = false // сервер прежней версии
    setBusy(true)
    try {
      const fresh = await fetchSheet(id)
      if (fresh) sheet = fresh
      else old = true
    } catch (e) {
      if (e.status === 400) gone(id, e.message)
      else toast(e.message, 'err')
      return
    } finally {
      setBusy(false)
    }
    // Пока ждали ответа, лист закрыли или ушли со страницы — спрашивать «применить?»
    // уже некого
    if (!here.current || openId.current !== id) return
    if (sheet.status === 'applied') {
      if (!foundApplied(sheet)) toast(t('Этот пересчёт уже применён'))
      return
    }
    if (!old) {
      setOpen(sheet)
      setList((ls) => ls.map((x) => (x.id === id ? sheet : x)))
    }

    const sent = readDraft(id)
    // Лист таким, каким его подтверждает человек, — по нему потом сверяется применённое
    const wanted = merged(sheet, sent)
    const total = tally(wanted, products)
    if (!total.counted) return
    const ok = await dialog.confirm({
      title: t('Применить пересчёт?'),
      message:
        `${t('Остатки станут такими, как вы насчитали')}. ` +
        `${t('Недостача')}: ${total.shortage.length} ${t('поз.')} ${t('на')} ${money(total.shortageCost)}, ` +
        `${t('излишек')}: ${total.surplus.length} ${t('поз.')}. ${t('Отменить нельзя.')}`,
      danger: true,
      confirmText: t('Применить'),
    })
    if (!ok) return

    // Остатки становятся насчитанными сразу — сотрудник не ждёт обработки сотен позиций
    const prevProducts = db.get('products')
    const byProduct = Object.fromEntries(total.rows.map((d) => [d.productId, d.actual]))
    setCollection('products', prevProducts.map((p) => {
      const actual = byProduct[p.id]
      if (actual === undefined) return p
      return { ...p, ...splitUnits(actual, p) }
    }))
    applying.current.add(id)
    const applied = { ...wanted, status: 'applied', appliedAt: serverNow().toISOString() }
    setList((ls) => ls.map((x) => (x.id === id ? applied : x)))
    close()
    toast(t('Остатки обновлены'))

    // Насчитанное уходит вместе с просьбой применить — одним запросом; сервер пишет
    // его и применяет лист одной записью. Раньше это были два запроса, и они уходили
    // разом: большой список добирался до сервера дольше короткого «применить», и лист
    // применялся по прежним числам — без того, что ввели после последнего сохранения.
    // Слать их по очереди тоже плохо: между ними вкладку могли закрыть, и лист остался
    // бы неприменённым, хотя человеку уже сказано «остатки обновлены».
    // Повторов не делаем: применение не из тех запросов, что шлют дважды.
    //
    // Сервер прежней версии чисел в «применить» не понимает: он молча применил бы лист
    // без них. Ему они уходят, как раньше, отдельным запросом, и «применить» — только
    // после ответа на него.
    const items = deltaOf(sheet, sent)
    const applyNow = (body) => api.post(`/inventory/${id}/apply`, body, { timeout: LONG_TIMEOUT_MS })
    const request = old
      ? (items.length ? api.patch(`/inventory/${id}`, { items }, { timeout: LONG_TIMEOUT_MS }) : Promise.resolve()).then(() => applyNow({}))
      : applyNow({ items })

    // Лист применён. Те ли числа применены, что были на экране, — сверяем: между
    // вопросом «применить?» и запросом лист могли изменить с другого устройства
    const done = (got) => {
      applying.current.delete(id)
      dropDraft(id)
      refresh('products')
      load()
      if (got?.items && !sameCounts(wanted, got)) tell({ kind: 'other', sheet: got })
    }

    request.then(done, async (e) => {
      // Что на самом деле с листом, знает только сервер: применение могло пройти, а
      // ответ — потеряться по дороге; лист могли применить и с другого устройства.
      // Отказ «уже применён» — не повод молчать: применены могли быть не те числа
      const refused = e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 408
      let got
      try {
        got = await sheetState(id, !refused)
      } catch {
        got = undefined // узнать не удалось
      }
      if (got?.status === 'applied') return done(got)

      applying.current.delete(id)
      setCollection('products', prevProducts)
      if (got === null) {
        // Листа больше нет — его удалили с другого устройства
        dropDraft(id)
        load()
        toast(`${t('Пересчёт не применён')}: ${e.message}`, 'err')
        return
      }
      // Введённое остаётся на устройстве: как бы лист потом ни открыли (кнопкой в
      // сообщении или из списка), насчитанное за день на месте
      const back = got || sheet
      setList((ls) => ls.map((x) => (x.id === id ? back : x)))
      tell({ kind: got ? 'refused' : 'unknown', message: e.message, sheet: back })
    })
  }

  async function removeSheet(inv) {
    const ok = await dialog.confirm({
      title: t('Удалить лист пересчёта?'),
      message: t('Незаконченный лист будет удалён. На складе ничего не изменится.'),
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    const prev = list
    setList((ls) => ls.filter((x) => x.id !== inv.id))
    if (open?.id === inv.id) close()
    toast(t('Удалено'))
    api.del(`/inventory/${inv.id}`).then(
      () => dropDraft(inv.id),
      (e) => {
        setList(prev)
        toast(e.message, 'err')
      },
    )
  }

  const pg = usePagination(list, 10)

  // Выгрузка и печать: открыт лист — выгружается ЛИСТ (с ним ходят по полкам);
  // иначе — история пересчётов
  const chisloEx = (i, n) => {
    const prod = products.find((p) => p.id === i.productId)
    return isVesovoy(prod) ? `${kgText(n)} ${t(edinica(prod))}` : n
  }
  const exList = open
    ? {
        zagolovok: t('Лист пересчёта'),
        podzag: `${open.scope === 'all' ? t('Весь склад') : t(open.scope)} · ${fmtDateTime(open.date)} · ${open.status === 'applied' ? t('применён') : t('не закончен')}`,
        cols: [
          { header: t('Товар'), key: 'name', width: 44 },
          { header: t('По системе, шт'), key: 'exp', width: 16, num: true },
          { header: t('По факту, шт'), key: 'fact', width: 16, num: true },
          { header: t('Расхождение'), key: 'diff', width: 14, num: true },
        ],
        rows: open.items.map((i) => {
          const actual = countOf(shownOf(i, typed))
          return {
            name: i.name,
            exp: chisloEx(i, i.expectedUnits),
            fact: actual === null ? '' : chisloEx(i, actual),
            diff: actual === null ? '' : chisloEx(i, actual - i.expectedUnits),
          }
        }),
      }
    : {
        zagolovok: t('Инвентаризация'),
        podzag: `${t('Найдено записей')}: ${list.length}`,
        cols: [
          { header: t('Дата'), key: 'date', width: 18 },
          { header: t('Охват'), key: 'scope', width: 24 },
          { header: t('Кто'), key: 'user', width: 20 },
          { header: t('Статус'), key: 'status', width: 16 },
        ],
        rows: list.map((inv) => ({
          date: fmtDateTime(inv.date),
          scope: inv.scope === 'all' ? t('Весь склад') : t(inv.scope),
          user: inv.user?.name || '—',
          status: inv.status === 'applied' ? t('применён') : t('не закончен'),
        })),
      }
  const exportExcel = () =>
    skachatXlsx({ fayl: exList.zagolovok, zagolovok: `${getUser()?.pharmacy?.name || ''} — ${exList.zagolovok}`, podzag: exList.podzag, cols: exList.cols, rows: exList.rows })

  return (
    <Layout title={t('Инвентаризация')} subtitle={t('Пересчёт остатков и сверка с системой')}
      actions={<ExportPechat onExcel={exportExcel} />}>
      <PrintSheet zagolovok={exList.zagolovok} podzag={exList.podzag} cols={exList.cols} rows={exList.rows} />
      {!open ? (
        <>
          <div className="note info" style={{ marginBottom: 16, maxWidth: 820 }}>
            {t('Как это работает: создайте лист — система запишет, сколько товара должно быть. Пересчитайте товар на полках и внесите фактические количества. Пока лист не применён, остатки не меняются.')}
          </div>

          <div className="panel" style={{ maxWidth: scope === PICKED ? 980 : 560 }}>
            <h2><span className="h2-title"><span className="ic"><LuPlus size={17} /></span>{t('Новый пересчёт')}</span></h2>
            <div className="field" data-tour="inv.scope" style={{ maxWidth: 520 }}>
              <label htmlFor="inv-scope">{t('Что пересчитываем')}</label>
              <select id="inv-scope" data-testid="inv-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="all">{t('Весь склад')}</option>
                {can('inventory.count') && <option value={PICKED}>{t('Выбранные товары (сканером)')}</option>}
                {categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}
              </select>
            </div>
            {scope === PICKED && can('inventory.count') && (
              <>
                <div data-tour="inv.pick">{skanPolya(skanVOtbor, busy)}</div>
                {otborRows.length > 0 && otborNachat(shop) > 0 && Date.now() - otborNachat(shop) > OTBOR_STARYY_MS && (
                  <div className="note warn" style={{ marginBottom: 12 }} data-testid="inv-otbor-old">
                    {t('Список начат')} {fmtDateTime(new Date(otborNachat(shop)))}. {t('С тех пор товар могли продавать — проверьте числа или очистите список и отсканируйте заново.')}
                  </div>
                )}
                <div className="inv-otbor" data-testid="inv-otbor">
                  <table>
                    <thead>
                      <tr><th>{t('Товар')}</th><th className="num">{t('По системе')}</th><th style={{ width: 170 }}>{t('Насчитано')}</th><th></th></tr>
                    </thead>
                    <tbody>
                      {otborRows.map((r, n) => {
                        const p = productById.get(r.productId)
                        const ves = isVesovoy(p)
                        return (
                          <tr key={r.productId} className={n === 0 ? 'inv-last' : undefined}>
                            <td><b>{p.name}</b><div className="tag-cat">{p.barcode}</div></td>
                            <td className="num">{stockText(p)}</td>
                            <td>
                              {ves ? (
                                <VesInput
                                  className="disc-input" style={{ width: 110 }} grams={r.units ?? 0} placeholder="—"
                                  {...poleProps('pick:' + r.productId, (txt) => setOtbor((l) => vOtboreStavim(l, r.productId, txt.trim() === '' ? null : gramsOfKg(txt))), skanVOtbor, true)}
                                  onGrams={(g) => setOtbor((l) => vOtboreStavim(l, r.productId, g))}
                                  aria-label={`${t('Насчитано')}: ${p.name}`}
                                />
                              ) : (
                                <NumberInput
                                  integer className="disc-input" style={{ width: 110 }} value={r.units === null ? '' : String(r.units)} placeholder="—"
                                  maxLength={MAX_DIGITS}
                                  {...poleProps('pick:' + r.productId, (txt) => setOtbor((l) => vOtboreStavim(l, r.productId, txt)), skanVOtbor, true)}
                                  onChange={(e) => setOtbor((l) => vOtboreStavim(l, r.productId, e.target.value))}
                                  aria-label={`${t('Насчитано')}: ${p.name}`}
                                />
                              )}
                              {/* Сколько это упаковок: «2 уп + 5 шт»; у весового без мешка вес и так в поле */}
                              {r.units !== null && !(ves && !opensPack(p)) && <div className="tag-cat">{unitsText(r.units, p, t)}</div>}
                            </td>
                            <td className="num">
                              <button className="btn ghost sm icon" onClick={() => setOtbor((l) => izOtbora(l, r.productId))} title={t('Убрать из списка')} aria-label={`${t('Убрать из списка')}: ${p.name}`}><LuX size={15} /></button>
                            </td>
                          </tr>
                        )
                      })}
                      {otborRows.length === 0 && (
                        <tr><td colSpan="4" className="empty">{t('Сканируйте товары — они появятся здесь. Повторный скан того же товара прибавит ещё одну упаковку.')}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {can('inventory.count') && (
              <div className="inv-create">
                <button className="btn" data-tour="inv.create" data-testid="inv-create" onClick={createSheet} disabled={busy}>
                  <span className="ic"><LuClipboardCheck size={16} /></span>
                  {' '}{scope === PICKED && otborRows.length ? `${t('Создать лист')} (${otborRows.length})` : t('Создать лист')}
                </button>
                {scope === PICKED && otborRows.length > 0 && (
                  <button
                    className="btn ghost"
                    onClick={async () => {
                      const ok = await dialog.confirm({ title: t('Очистить список?'), message: t('Отсканированные товары уйдут из списка. На складе ничего не изменится.'), confirmText: t('Очистить') })
                      if (ok) setOtbor([])
                    }}
                    disabled={busy}
                  >
                    {t('Очистить список')}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="panel mt" data-tour="inv.list" style={{ padding: 0 }}>
            <h2 style={{ padding: '16px 16px 0' }}>
              <span className="h2-title"><span className="ic"><LuClipboardCheck size={17} /></span>{t('Пересчёты')}</span>
            </h2>
            <table>
              <thead>
                <tr><th>{t('Дата')}</th><th>{t('Охват')}</th><th>{t('Кто')}</th><th>{t('Статус')}</th><th></th></tr>
              </thead>
              <tbody>
                {pg.slice.map((inv) => (
                  <tr key={inv.id}>
                    <td>{fmtDateTime(inv.date)}</td>
                    <td>{inv.scope === 'all' ? t('Весь склад') : t(inv.scope)}</td>
                    <td>{inv.user?.name || '—'}</td>
                    <td>
                      {inv.status === 'applied'
                        ? <span className="badge ok">{t('применён')}</span>
                        : <span className="badge low">{t('не закончен')}</span>}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => openSheet(inv)}>
                        {inv.status === 'applied' ? t('Посмотреть') : t('Продолжить')}
                      </button>{' '}
                      {inv.status !== 'applied' && can('inventory.count') && (
                        <button className="btn ghost sm icon" onClick={() => removeSheet(inv)} title={t('Удалить')} aria-label={t('Удалить')}><LuTrash2 size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan="5" className="empty">{t('Пересчётов ещё не было')}</td></tr>}
              </tbody>
            </table>
            <Pagination {...pg} />
          </div>
        </>
      ) : (
        <>
          <div className="cards four" style={{ marginBottom: 16 }}>
            <div className="metric"><div className="metric-head"><div className="label">{t('Позиций в листе')}</div></div><div className="value">{open.items.length}</div></div>
            <div className="metric"><div className="metric-head"><div className="label">{t('Пересчитано')}</div></div><div className="value">{sum.counted}</div></div>
            <div className="metric"><div className="metric-head"><div className="label">{t('Недостача')}</div></div><div className="value" style={{ color: sum.shortage.length ? 'var(--danger)' : undefined }}>{sum.shortage.length}</div></div>
            <div className="metric"><div className="metric-head"><div className="label">{t('Излишек')}</div></div><div className="value" style={{ color: sum.surplus.length ? 'var(--warn)' : undefined }}>{sum.surplus.length}</div></div>
          </div>

          {open.status === 'applied' && (
            <div className="note info" style={{ marginBottom: 12 }}>{t('Этот пересчёт уже применён — данные показаны для истории.')}</div>
          )}

          {open.status !== 'applied' && can('inventory.count') && (
            <div className="panel inv-scan-panel" data-tour="inv.scan">{skanPolya(skanVListe)}</div>
          )}

          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('Товар')}</th>
                  <th className="num">{t('По системе, шт')}</th>
                  <th style={{ width: 140 }}>{t('По факту, шт')}</th>
                  <th className="num">{t('Расхождение')}</th>
                </tr>
              </thead>
              <tbody>
                {poryadokStrok(open.items, top).map((i) => {
                  const raw = shownOf(i, typed)
                  const actual = countOf(raw)
                  // Весовой товар считается в килограммах: храним граммы, показываем кг
                  const prod = products.find((p) => p.id === i.productId)
                  const ves = isVesovoy(prod)
                  const diff = actual === null ? null : actual - i.expectedUnits
                  const chislo = (n) => (ves ? `${kgText(n)} ${t(edinica(prod))}` : n)
                  return (
                    <tr key={i.id} className={top[0] === i.id ? 'inv-last' : undefined}>
                      <td><b>{i.name}</b>{prod?.barcode && <div className="tag-cat">{prod.barcode}</div>}</td>
                      <td className="num">{chislo(i.expectedUnits)}</td>
                      <td data-tour="inv.fact">
                        {ves ? (
                          <VesInput
                            className="disc-input"
                            style={{ width: 100 }}
                            grams={actual ?? 0}
                            disabled={open.status === 'applied'}
                            placeholder="—"
                            {...poleProps(i.id, (txt) => type(i, txt.trim() === '' ? '' : String(gramsOfKg(txt))), skanVListe)}
                            onGrams={(g) => type(i, String(g))}
                          />
                        ) : (
                          <NumberInput
                            integer className="disc-input" style={{ width: 100 }}
                            value={raw}
                            disabled={open.status === 'applied'}
                            placeholder="—"
                            maxLength={MAX_DIGITS}
                            {...poleProps(i.id, (txt) => type(i, txt), skanVListe)}
                            onChange={(e) => type(i, e.target.value)}
                          />
                        )}
                        {!ves && opensPack(prod) && actual !== null && <div className="tag-cat">{unitsText(actual, prod, t)}</div>}
                      </td>
                      <td className="num">
                        {diff === null ? <span className="tag-cat">{t('не считали')}</span>
                          : diff === 0 ? <span className="badge ok">{t('сходится')}</span>
                            : <span className={'badge ' + (diff < 0 ? 'debt' : 'low')}>{diff > 0 ? '+' : ''}{chislo(diff)}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={close} disabled={busy}>{t('Назад к списку')}</button>
            {open.status !== 'applied' && (
              <>
                {can('inventory.count') && <button className="btn ghost" data-tour="inv.draft" onClick={saveDraft}>{t('Сохранить черновик')}</button>}
                {can('inventory.apply') && (
                  <button className="btn danger" data-tour="inv.apply" onClick={apply} disabled={busy || sum.counted === 0}>
                    <span className="ic"><LuCircleCheck size={16} /></span> {t('Применить пересчёт')}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {notice && (
        <Modal
          title={<><span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>{noticeText(notice.kind).title}</>}
          onClose={() => setNotice(null)}
        >
          {notice.message && <div className="note err" style={{ marginBottom: 12 }}>{notice.message}</div>}
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
            {noticeText(notice.kind).text}
          </p>
          <div className="modal-actions">
            <button
              className="btn"
              onClick={() => {
                openSheet(notice.sheet)
                setNotice(null)
              }}
            >
              {t('Открыть лист')}
            </button>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
