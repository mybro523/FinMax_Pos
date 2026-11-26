import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useDeferredValue, useSyncExternalStore, lazy, Suspense } from 'react'
import {
  LuCamera, LuShoppingCart, LuPlus, LuMinus, LuTrash2, LuCheck, LuPrinter, LuScanLine, LuClock,
  LuTriangleAlert, LuX, LuLock, LuChevronRight, LuUndo2, LuBookmark,
} from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog, PAYMENTS } from '../components/ui'
// Сканер камеры тянет за собой тяжёлую библиотеку распознавания (~400 КБ).
// Грузим её только при нажатии «Камера», иначе она замедляла открытие Кассы каждый раз.
const CameraScanner = lazy(() => import('../components/CameraScanner'))
import KassaCatalog, { LIMIT } from '../components/KassaCatalog'
import ChipsMore from '../components/ChipsMore'
import Lightbox from '../components/Lightbox'
import { useCollection, useFirstLoading, money, db, stockText, realId } from '../db/store'
import { useAuth, useCan } from '../db/auth'
import { useDesktopStatus } from '../db/desktopStatus'
import { soloMessage } from '../lib/aktivaciya'
import { isVesovoy, kgText, KG, gramsOfKg, edinica, isKg,
  uppOf, isDivisible as isDiv, lineUnits, lineGross, lineNet, pricePerPiece,
  expiredUnits, hasExpired, stockUnits,
  fitLine, pieceUnits, packPieces, packLabel,
} from '../lib/units'

// Весовой товар: на вес (одно поле «кг») или в мешке (1.5.12) — «Упаковок» и «кг», как штучный
const vesOnly = (x) => isVesovoy(x) && !isDiv(x)
const vesPack = (x) => isVesovoy(x) && isDiv(x)
// «2,5» вместо «2.5» — сколько килограммов в мешке
const drob = (n) => String(Math.round(Number(n) * 1000) / 1000).replace('.', ',')
import {
  MAX_CHEKOV, klyuch, chitat, pisat, razobrat, novyChek, svobodnyNomer, posleProdazhi,
  osvezhit, sdacha, kupyury, pohozheNaKod, estBukva, raspredelit,
} from '../lib/cheki'
import { MAX_OTLOZH, chitatOtlozh, pisatOtlozh, otlozhitItem } from '../lib/otlozhennye'
import { useModul } from '../lib/useModul'
import { findByBarcode, checkout, returnGoods, openShift as openShiftOp } from '../db/ops'
import { cancelQueued } from '../lib/offlineSales'
import { otmenaVozvrat } from '../lib/otmena'
import { productPayload } from '../components/ProductForm'
import NewProductModal from '../components/NewProductModal'
import { beepOk, beepError, unlockAudio } from '../lib/sound'
import { fmtDateTime, chekNomer } from '../lib/time'
import { normalizeScan } from '../lib/scan'
import { parseVesEtiketku, productPoVesKodu } from '../lib/vesy'
import { useT, useLang, translate as tr } from '../lib/i18n'
import { RegisterAlert } from '../components/SoloKassyPanel'
import { blockUpdate } from '../lib/version'
import { sellsBelowCost } from '../lib/pricing'
import { saleTicket, qtyPriceText } from '../lib/ticket'
import { showCustomer, customerLabels, cartScreen } from '../lib/customerScreen'
import { autoPrint } from '../lib/print'
import { pechatPoGotovo } from '../lib/pechatGotovo'
import TicketView from '../components/TicketView'
import PrintDoc from '../components/PrintDoc'
import { pechatBezOkna } from '../components/PrintKeeper'
import { pechatTicket } from '../lib/pechat'
import { getRekvizity } from '../lib/rekvizity'
import { useCategories, categoryNames } from '../lib/categories'
import NumberInput from '../components/NumberInput'
import { isComposite, availUnitsOf, compositeCost } from '../lib/recipe'

// ── Хелперы штучной продажи ──
// Сама арифметика упаковок и штук живёт в lib/units — одна на всю программу.
// Доступно к продаже только ГОДНОЕ: просроченные партии лежат на складе,
// но покупателю не уходят, поэтому касса считает остаток без них.
// У составного товара (1.8.5) доступно = сколько можно собрать из ингредиентов —
// считается в компоненте, где есть весь список товаров (availUnits ниже).
// ── Строка чека: числа обязаны сходиться ──
// Покупатель умножает то, что видит. Раньше в строке стояло количество упаковок,
// а рядом цена ОДНОЙ ШТУКИ: «1 уп × 7,5 сомони», итог 150. Для товара, который
// делится на двадцать штук, это выглядело как ошибка кассы — и объяснить
// её у прилавка было нечем.
//
// Поэтому показываем то, что перемножается: целые упаковки — по цене упаковки,
// всё остальное — в штуках по цене штуки.

// «Все категории» — отдельное значение, а не слово «Все»: иначе категория,
// которую владелец сам назвал «Все», стала бы неотличима от сброса фильтра
const VSE = '\u0000vse'
// Свёрнута ли шапка категорий в каталоге — запоминается на этом компьютере
const CATS_KEY = 'apteka_kassa_cats'
// Ниже этой ширины чек и каталог рядом не помещаются — там переключатель.
// Число то же, что в стилях кассы (index.css) и в туре (lib/tur.js): разойдутся —
// и касса будет считать экран широким, пока на нём показан переключатель
const UZKO = '(max-width: 1279px)'
// Телефон (до 600 px, как в index.css и m-kassa.css): касса — одна колонка, которая листается
// страницей, клавиатура — экранная. На нём курсор сам в поле сканера не возвращается
// (см. vernutKursor). Шире 600 px — компьютер и программа: там всё как было
const TELEFON = '(max-width: 600px)'
const naTelefone = () => typeof window.matchMedia === 'function' && window.matchMedia(TELEFON).matches
function useTelefon() {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const mq = window.matchMedia(TELEFON)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    naTelefone,
    () => false,
  )
}
// Слово валюты — так, как его пишет money() в суммах: «сомони» из «0 сомони»
const valyuta = () => {
  const s = money(0)
  return s.slice(s.lastIndexOf(' ') + 1)
}
// Один сравниватель на всю кассу. localeCompare с указанием языка заводит его заново
// на каждое сравнение, а каталог в настоящем магазине — это тысячи названий
const poAlfavitu = new Intl.Collator('ru').compare

export default function Pos() {
  const products = useCollection('products')
  // Состав (1.8.5): у составного товара доступно = сколько можно собрать из ингредиентов.
  // Для этого нужен весь список товаров — считаем здесь, где он есть
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const availUnits = useCallback((p) => availUnitsOf(p, byId), [byId])
  const customers = useCollection('customers')
  // Сервисы перевода (Alif, DC…): при оплате переводом кассир выбирает, через какой
  const payServices = useCollection('payServices')
  // Карточку товара заводит владелец: он задаёт цену продажи и закупочную.
  // Кассир у прилавка откладывает незнакомый штрихкод — покупателя это не задерживает,
  // а товар оформляется потом, спокойно и с накладной в руках.
  const auth = useAuth()
  const can = useCan()
  // Карточку с кассы заводит тот, кому разрешено заводить товары; остальные откладывают штрихкод
  const isFounder = can('products.create')
  // Подписка кончилась и отсрочка вышла: сервер продажу не примет. Показать это
  // до нажатия честнее, чем дать набрать корзину и отказать на оплате — кассир
  // решил бы, что программа сломалась, а покупатель уже стоит у прилавка.
  const desk = useDesktopStatus()
  // Магазин без интернета (1.7.1): срок вышел — сразу, не дожидаясь «кто я»
  const canSell = (auth?.subscription ? auth.subscription.canWrite : true) && desk?.activation?.active !== false
  // ── Смена ──
  // Без открытой смены касса не продаёт: каждый чек обязан войти в отчёт смены. На сайте
  // смена — общая смена сайта, в программе — смена этой кассы (локальная база отдаёт
  // только её). Пока смены не загружены, окно не показываем: иначе мигало бы при входе
  const shifts = useCollection('shifts')
  const loadingShifts = useFirstLoading('shifts')
  const smena = shifts.find((s) => !s.closedAt) || null
  const noShift = !loadingShifts && !smena
  const [noShiftModal, setNoShiftModal] = useState(false)
  const [openCash, setOpenCash] = useState('')
  const [openingShift, setOpeningShift] = useState(false)
  // Окно — сразу при входе в кассу (и каждый раз, когда смену закрыли)
  useEffect(() => {
    if (noShift) setNoShiftModal(true)
  }, [noShift])
  // Смена появилась (открыли здесь или на другом устройстве) — окно больше не нужно
  useEffect(() => {
    if (smena) setNoShiftModal(false)
  }, [smena])
  async function openShiftHere() {
    if (openingShift) return
    setOpeningShift(true)
    try {
      const { synced } = openShiftOp(Number(openCash) || 0, auth)
      await synced
      setOpenCash('')
      toast(t('Смена открыта'))
      vernutKursor()
    } catch (e) {
      toast(t('Смена не открыта') + ': ' + t(e.message), 'err')
    } finally {
      setOpeningShift(false)
    }
  }
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const telefon = useTelefon()
  const phCode = auth?.pharmacy?.code || ''

  // ── Открытые чеки ──
  // Чек больше не живёт в памяти страницы: он хранится на устройстве и переживает
  // уход в другой раздел и перезагрузку. Состояние помнит, чьего магазина эти чеки, —
  // чтобы при смене магазина в том же браузере не записать чужие под новый ключ.
  const [cheki, setCheki] = useState(() => ({ code: phCode, ...chitat(phCode) }))
  useEffect(() => {
    if (cheki.code !== phCode) setCheki({ code: phCode, ...chitat(phCode) })
  }, [phCode, cheki.code])
  useEffect(() => {
    pisat(cheki.code, cheki)
  }, [cheki])
  // Касса открыта в двух окнах одного браузера: без этого каждое окно затирало бы
  // чеки другого своей устаревшей копией. Событие приходит только в ЧУЖОЕ окно.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== klyuch(phCode) || !e.newValue) return
      setCheki({ code: phCode, ...razobrat(e.newValue) })
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [phCode])

  // ── Отложенные товары (1.8.15; перенос 1.8.17) ──
  // Отложенный ТОВАР уходит из корзины в отдельный список на устройстве (lib/otlozhennye.js)
  // и не продаётся, пока его не вернут. Сам список показывается и возвращается в разделе
  // «Отложенные штрихкоды», поэтому откладывать (значок/F7) даём только там, где этот раздел
  // есть: модуль включён и есть право его смотреть — иначе товар некуда будет вернуть.
  const otlozhOn = useModul('deferred') && can('deferred.view')

  const chek = cheki.list.find((c) => c.id === cheki.active) || cheki.list[0]
  const { cart, payment, customerId, received, payVia } = chek

  // Всё, что раньше было отдельным состоянием кассы, теперь свойство активного чека:
  // у каждого покупателя своя корзина, свой способ оплаты и свой клиент
  const patch = useCallback((x) => {
    setCheki((s) => ({
      ...s,
      list: s.list.map((c) => (c.id === s.active ? { ...c, ...(typeof x === 'function' ? x(c) : x) } : c)),
    }))
  }, [])
  const setCart = useCallback(
    (next) => patch((c) => ({ cart: typeof next === 'function' ? next(c.cart) : next })),
    [patch],
  )
  const setPayment = (v) => patch({ payment: v })
  const setCustomerId = (v) => patch({ customerId: v })
  const setReceived = (v) => patch({ received: v })
  const setPayVia = (v) => patch({ payVia: v })

  // ── Скидка на весь чек ──
  // Одна цифра на чек — сумма или процент. Сами скидки по-прежнему лежат в строках:
  // raspredelit раскладывает названную скидку по ним, а снятие обнуляет строки.
  // Пока скидка задана на чек, строки для правки закрыты — иначе две скидки спорили бы
  const obshchaya = !!chek.discValue
  const setDiscMode = (m) => patch({ discMode: m })
  const setObshchaya = (v) => {
    const val = String(v ?? '')
    if (val === '') patch((c) => ({ discValue: '', cart: c.cart.map((i) => (i.discount ? { ...i, discount: 0 } : i)) }))
    else patch({ discValue: val })
  }

  const [code, setCode] = useState('')
  // Список считается от текущих товаров, а не запоминается в момент набора.
  // Раньше это было состояние: наберёшь название, пока список ещё едет
  // с сервера, — и подсказки останутся пустыми, сколько ни жди.
  const loadingProducts = useFirstLoading('products')
  const [receipt, setReceipt] = useState(null)
  const [camera, setCamera] = useState(false)
  const [foto, setFoto] = useState(null) // товар, чьё фото смотрим на весь экран
  const [newProduct, setNewProduct] = useState(null)
  const [paying, setPaying] = useState(false)
  const [analogFor, setAnalogFor] = useState(null) // товар нет в наличии -> предложить аналоги
  const [failedSale, setFailedSale] = useState(null) // продажа не записалась на сервер
  // Последняя продажа — для кнопки «Отмена» в окне чека: промис её записи (настоящий
  // номер чека приходит с ним) и корзина, какой она была до оплаты
  const lastSaleRef = useRef(null)
  const [selId, setSelId] = useState(null) // выбранная строка чека — с ней работают клавиши
  const probito = useRef(null) // товар, который только что пробили (см. selLine)
  const [cat, setCat] = useState(VSE)
  // Шапка категорий свёрнута или раскрыта — как оставили на этом компьютере в прошлый раз
  const [catsOpen, setCatsOpen] = useState(() => {
    try {
      return localStorage.getItem(CATS_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggleCats = () =>
    setCatsOpen((v) => {
      try {
        localStorage.setItem(CATS_KEY, v ? '0' : '1')
      } catch {
        /* не запомнилось — не страшно */
      }
      return !v
    })
  // Выбор категории. На телефоне раскрытый список плашек («Ещё») после выбора сворачивается
  // до двух рядов, а экран встаёт на шапку каталога, если она ушла выше края: иначе товары
  // выбранной категории оставались бы далеко внизу, под всеми плашками
  const vybratKat = (c) => {
    setCat(c)
    if (!naTelefone()) return
    requestAnimationFrame(() => {
      const box = document.querySelector('.kc-cats-box')
      if (box && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start' })
    })
  }
  const [hi, setHi] = useState(0) // подсвеченная строка каталога
  const [pane, setPane] = useState('check') // на узком экране: 'check' | 'catalog'
  const [izm, setIzm] = useState(null) // что изменилось в чеке, пока он лежал: { id, text }
  const inputRef = useRef(null)
  const receivedRef = useRef(null)
  const cartRef = useRef(cart)
  useEffect(() => {
    cartRef.current = cart
  }, [cart])
  const chekRef = useRef(chek)
  chekRef.current = chek

  // Скидка на чек пересчитывается при любом изменении строк: добавили товар,
  // поменяли количество, сверка с базой подняла цену — доли остаются верными
  const grossSig = cart.map((i) => i.productId + ':' + lineGross(i)).join('|')
  useEffect(() => {
    if (!obshchaya) return
    const c = chekRef.current
    const r = raspredelit(c.cart, c.discMode, c.discValue)
    if (r.changed) setCart(r.cart)
  }, [grossSig, obshchaya, chek.discMode, chek.discValue, setCart])

  // ── Чек или каталог на узком экране ──
  // Кассир начал набирать название, а на экране чек — подходящих товаров он не
  // увидел бы. Поэтому каталог открывается сам. Но не сразу: сканер тоже «печатает»
  // в это поле, и от каждого скана экран дёргался бы туда-обратно. Сканер успевает
  // за доли секунды, человек — нет; по паузе их и отличаем.
  // Открыли сами — сами и закроем, когда поле опустеет (товар выбран или поиск
  // стёрт). Если каталог открыл кассир кнопкой, он остаётся открытым.
  //
  // Следим только за набором, а не за самим переключателем: иначе кассир, нажавший
  // «Чек» при непустом поиске, через четверть секунды снова оказался бы в каталоге.
  const autoPane = useRef(false)
  const paneRef = useRef(pane)
  paneRef.current = pane
  useEffect(() => {
    if (!window.matchMedia(UZKO).matches) return
    if (code.trim()) {
      if (paneRef.current === 'catalog') return
      const id = setTimeout(() => {
        autoPane.current = true
        setPane('catalog')
      }, 250)
      return () => clearTimeout(id)
    }
    if (autoPane.current) {
      autoPane.current = false
      setPane('check')
    }
  }, [code])
  const pokazat = (p) => {
    autoPane.current = false
    setPane(p)
  }

  // Метка «открыта касса» на всей странице: по ней сообщения всплывают сверху,
  // а не поверх кнопки оплаты (сами сообщения рисуются вне кассы, у корня программы)
  useEffect(() => {
    document.documentElement.classList.add('kassa-open')
    return () => document.documentElement.classList.remove('kassa-open')
  }, [])

  // Пока в корзине есть товар, программа не станет перезагружаться из-за новой
  // версии: чек сохранится, но перезагрузка под руками кассира сбивает работу
  useEffect(() => {
    if (!cart.length) return
    return blockUpdate()
  }, [cart.length])

  // Возвращаем фокус на поле сканера (нужно для USB-сканера), НО не вырываем его,
  // пока кассир печатает в другом поле — иначе вторая цифра в «Штук»/«Скидка»
  // улетала в поиск, потому что корзина меняется на каждое нажатие клавиши.
  //
  // focusScanner — по клавише: Escape, знак с USB- или Bluetooth-сканера (обработчик клавиш
  // ниже). Курсор нужен в поле сейчас же, иначе пропадёт начало штрихкода. На телефоне
  // экран при этом к полю не прыгает: скан печатается и в поле за краем экрана, а новая
  // строка чека показывается сама (см. selLine)
  const focusScanner = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    if (naTelefone()) el.focus({ preventScroll: true })
    else el.focus()
  }, [])
  // vernutKursor — после нажатия кнопки («+», «−», корзинка, способ оплаты, скидка на чек,
  // строка каталога) и после окна. На телефоне — ничего (17.11.2026, проверка на телефоне):
  // фокус уводил экран к самому верху, и кассир терял из виду строку или оплату, которую
  // только что меняла, а на Android после каждого «+» ещё и выезжала клавиатура на пол-
  // экрана. В поле сканера на телефоне нажимают сами; знак с подключённого сканера всё
  // равно попадёт в поле — его ловит обработчик клавиш
  const vernutKursor = useCallback(() => {
    if (!naTelefone()) focusScanner()
  }, [focusScanner])
  // Enter в поле числа (штуки, вес, скидка) — набор окончен. На компьютере курсор
  // возвращается к сканеру. На телефоне поле просто отпускает курсор: экранная клавиатура
  // закрывается, а экран остаётся у строки, которую правили
  const gotovoVPole = (e) => {
    if (naTelefone()) e.currentTarget.blur()
    else focusScanner()
  }
  useEffect(() => {
    if (camera || newProduct || receipt || analogFor) return
    const el = document.activeElement
    const typingElsewhere =
      el && el !== inputRef.current &&
      (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    if (!typingElsewhere) vernutKursor()
  }, [cart, receipt, camera, newProduct, analogFor, vernutKursor])

  // ── Защита числовых полей от «выстрела» сканера ──
  // Кассир мог поправить количество и, не нажав Enter, взяться за сканер. Тогда штрихкод
  // печатается в поле числа. Слои защиты: Enter/Tab, откат по длине и «глушение»
  // остатка выстрела.
  //
  // Возврата фокуса «по паузе» здесь больше НЕТ намеренно: раньше стоял таймер на
  // 1,5 с, и у кассира, который задумался над количеством, курсор вырывало на сканер —
  // следующие цифры улетали в поиск. Пока человек в поле, курсор его. Выстрел сканера
  // в поле числа и без таймера ловится ниже — по скорости набора и длине кода.

  // 1) Enter/Tab — сразу возвращаем фокус на сканер (на телефоне поле только отпускает
  //    курсор — см. gotovoVPole).

  // Человек печатает с интервалами 150–400 мс, сканер «выстреливает» за единицы миллисекунд.
  // По этому признаку отличаем реальный ввод кассира от штрихкода и запоминаем как «чистое»
  // только то значение, которое набрал человек.
  const lastKeyRef = useRef(0)
  const HUMAN_GAP_MS = 60
  // Очередь «нечеловеческих» цифр подряд. Проверка «8+ цифр в значении» ниже не
  // спасает поля количества: они зажимают значение на каждой букве, и до восьми
  // цифр оно не доживает. А вот ЧЕТЫРЕ цифры с промежутками меньше 60 мс пальцами
  // не набрать — это точно сканер, каким бы коротким ни было поле
  const fastRunRef = useRef(0)

  const onCellKey = (e, productId) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      gotovoVPole(e)
      return
    }
    const now = performance.now()
    const humanPace = now - lastKeyRef.current > HUMAN_GAP_MS
    lastKeyRef.current = now
    const digit = e.key.length === 1 && e.key >= '0' && e.key <= '9'
    if (!digit || humanPace) fastRunRef.current = 0
    else if (++fastRunRef.current >= 4) {
      fastRunRef.current = 0
      e.preventDefault() // пятая цифра выстрела в поле уже не попадает
      bailOutScan()
      return
    }
    // keydown приходит до изменения значения, поэтому здесь в корзине ещё «чистое» состояние
    if (humanPace) snapLine(productId)
  }

  // 3) Если в поле числа всё же «прилетел» штрихкод (8+ цифр — для количества и скидки
  //    таких значений не бывает), откатываем позицию к значению на момент входа в поле,
  //    чтобы в чеке не осталось подменённое количество или скидка на всю сумму.
  const lineSnapRef = useRef(null)
  const snapLine = (id) => {
    const it = cart.find((i) => i.productId === id)
    lineSnapRef.current = it
      ? { productId: id, qty: it.qty, pieces: it.pieces || 0, discount: it.discount || 0 }
      : null
  }
  const looksLikeScan = (v) => String(v).replace(/\D/g, '').length >= 8

  // 4) Остаток выстрела. Поняв на восьмой цифре, что это штрихкод, мы возвращаем
  //    фокус сканеру — и оставшиеся цифры с Enter прилетели бы уже в него обрывком
  //    кода. Обрывок ничего не значит, а найти по нему «похожий» товар и положить
  //    его в чек было бы хуже, чем ничего. Поэтому короткое время поле молчит.
  const muteUntil = useRef(0)
  const ostanovitVystrel = useCallback(() => {
    muteUntil.current = performance.now() + 350
    beepError()
    toast(t('Это похоже на штрихкод — сканируйте ещё раз'), 'err')
    setCode('')
    focusScanner()
  }, [toast, t, focusScanner])

  function bailOutScan() {
    const s = lineSnapRef.current
    if (s) {
      setCart((c) =>
        c.map((i) => (i.productId === s.productId ? { ...i, qty: s.qty, pieces: s.pieces, discount: s.discount } : i)),
      )
    }
    ostanovitVystrel()
  }

  // ── Весовой товар в корзину ──
  // Вес приходит с этикетки весов (точный) или добавляется килограммом по клику,
  // а дальше кассир правит его в строке. Хранится граммами в «штуках» строки. У товара в
  // мешке (1.5.12) вес — отдельные килограммы: мешки в строке остаются как были
  const addWeight = useCallback(
    (p, grams) => {
      // Сырьё (1.8.5) напрямую не продаётся
      if (p.forSale === false) {
        toast(`«${p.name}» ${t('— сырьё, не для продажи')}`, 'err')
        return false
      }
      const avail = availUnits(p)
      const ex = cartRef.current.find((i) => i.productId === p.id)
      const used = ex ? lineUnits(ex) : 0
      if (avail <= used || avail <= 0) {
        toast(`${t('Максимум на складе')}: ${kgText(avail)} ${t(edinica(p))}`, 'err')
        return false
      }
      const add = Math.min(Math.max(1, Math.trunc(grams) || 0), avail - used)
      if (add < grams) toast(`${t('Максимум на складе')}: ${kgText(avail)} ${t(edinica(p))}`, 'err')
      setCart((c) => {
        const e = c.find((i) => i.productId === p.id)
        if (e) return c.map((i) => (i.productId !== p.id ? i : vesPack(i) ? { ...i, pieces: (i.pieces || 0) + add } : { ...i, qty: 0, pieces: lineUnits(i) + add }))
        return [
          ...c,
          {
            productId: p.id, name: p.name, price: p.price, cost: isComposite(p) ? compositeCost(p, byId) : p.cost,
            // Своя цена за 1 кг у товара в мешке (1.5.12): отдельные килограммы — по ней
            piecePrice: p.piecePrice ?? null,
            unitsPerPack: uppOf(p), unit: p.unit, stock: p.stock, looseUnits: p.looseUnits,
            qty: 0, pieces: add, discount: 0,
          },
        ]
      })
      setSelId(p.id)
      probito.current = p.id
      return true
    },
    [toast, setCart, t, availUnits, byId],
  )

  // Возвращает true, если товар реально добавлен в корзину (false — нет на складе / лимит)
  const addProduct = useCallback(
    (p) => {
      // Сырьё (1.8.5) напрямую не продаётся — только через составной товар
      if (p.forSale === false) {
        toast(`«${p.name}» ${t('— сырьё, не для продажи')}`, 'err')
        return false
      }
      // Весовой без мешка добавляется килограммом. Весовой в мешке (1.5.12) — как штучный:
      // мешком, а если целого мешка нет — килограммом
      if (vesOnly(p)) return addWeight(p, KG)
      const upp = uppOf(p)
      // Отдельно продаётся штука, у весового — килограмм (тысяча граммов)
      const step = pieceUnits(p)
      const skolko = (n) => (isVesovoy(p) ? `${kgText(n)} ${t(edinica(p))}` : `${n} ${t('шт')}`)
      const avail = availUnits(p)
      if (avail <= 0) {
        // Составной товар (1.8.5): закончилось не сам товар, а сырьё для его сборки
        if (isComposite(p)) {
          toast(`«${p.name}»: ${t('не хватает сырья для сборки')}`, 'err')
          return false
        }
        // Годного не осталось. Разделяем два случая: товара нет вовсе и товар есть,
        // но весь просрочен — действия у кассира разные
        const allExpired = stockUnits(p) > 0
        const ids = new Set(p.analogIds || [])
        const alts = products.filter((x) => x.id !== p.id && (ids.has(x.id) || (x.analogIds || []).includes(p.id)) && availUnits(x) > 0)
        if (alts.length) setAnalogFor({ product: p, analogs: alts, allExpired })
        else if (allExpired) toast(`«${p.name}»: ${t('весь остаток просрочен — продавать нельзя')}`, 'err')
        else toast(`«${p.name}» ${t('нет на складе')}`, 'err')
        return false
      }
      // Годный товар есть, но часть остатка просрочена — предупреждаем сразу,
      // а не когда кассир упрётся в лимит количества
      if (hasExpired(p)) {
        toast(
          isVesovoy(p)
            ? `«${p.name}»: ${kgText(expiredUnits(p))} ${t(edinica(p))} ${t('просрочено — уберите с полки')}`
            : `«${p.name}»: ${expiredUnits(p)} ${t('шт просрочено — уберите с полки')}`,
          'err',
        )
      }
      const ex = cartRef.current.find((i) => i.productId === p.id)
      const used = ex ? ex.qty * upp + (ex.pieces || 0) : 0
      if (used >= avail) {
        toast(`${t('Максимум на складе')}: ${skolko(avail)}`, 'err')
        return false
      }
      // Добавляем целую упаковку, если она помещается; иначе — одну штуку (осталась вскрытая)
      const addPack = avail - used >= upp
      setCart((c) => {
        const e = c.find((i) => i.productId === p.id)
        if (e) {
          if (e.qty * upp + (e.pieces || 0) >= avail) return c
          return c.map((i) =>
            i.productId === p.id
              ? addPack
                ? { ...i, qty: i.qty + 1 }
                : { ...i, pieces: (i.pieces || 0) + Math.min(step, avail - (e.qty * upp + (e.pieces || 0))) }
              : i,
          )
        }
        return [
          ...c,
          {
            productId: p.id, name: p.name, price: p.price, cost: isComposite(p) ? compositeCost(p, byId) : p.cost,
            // Своя цена штуки (1.5.11; у весового — за 1 кг): отдельные — по ней, упаковки —
            // по цене упаковки
            piecePrice: p.piecePrice ?? null,
            unitsPerPack: upp, unit: p.unit, stock: p.stock, looseUnits: p.looseUnits,
            qty: addPack ? 1 : 0, pieces: addPack ? 0 : Math.min(step, avail - used), discount: 0,
          },
        ]
      })
      // Только что добавленная строка становится выбранной: клавиши «+», «−»,
      // F2 и F4 относятся к тому, что кассир пробил последним
      setSelId(p.id)
      probito.current = p.id
      return true
    },
    [toast, products, setCart, t, addWeight, availUnits, byId],
  )

  const handleUnknown = useCallback((barcode) => {
    setCamera(false)
    // Из DataMatrix берём код товара (GTIN), а не всю строку с серийником
    setNewProduct({ barcode: normalizeScan(barcode) })
  }, [])

  const onCameraDetect = useCallback(
    (code) => {
      setCamera(false)
      const ves = parseVesEtiketku(code)
      if (ves) {
        const wp = productPoVesKodu(products, ves.code)
        if (wp && addWeight(wp, ves.grams)) {
          beepOk()
          toast(`${wp.name}: ${kgText(ves.grams)} ${t(edinica(wp))} ${t('добавлен в корзину')}`)
        } else {
          beepError()
          if (!wp) toast(`${t('Весовой товар с кодом')} ${ves.code} ${t('не найден — впишите этот код в штрихкод весового товара')}`, 'err')
        }
        return
      }
      const p = findByBarcode(code)
      if (p) {
        // Тост-успех и «бип» — только если товар реально добавлен (иначе addProduct уже показал ошибку)
        if (addProduct(p)) {
          beepOk()
          toast(`${p.name} ${t('добавлен в корзину')}`)
        } else {
          beepError()
        }
      } else {
        beepError()
        toast(isFounder ? t('Новый товар — заполните карточку') : t('Товара нет в базе — отложите штрихкод'), 'err')
        setNewProduct({ barcode: normalizeScan(code) })
      }
    },
    [addProduct, addWeight, products, toast, isFounder, t],
  )

  // ── Каталог ──
  // Категории показываем только те, в которых есть товар: пустая плашка — это
  // нажатие, после которого кассир видит «ничего не найдено».
  const catList = useCategories()
  const cats = useMemo(() => {
    const est = new Set(products.map((p) => p.category).filter(Boolean))
    const poPoryadku = categoryNames(catList).filter((c) => est.has(c))
    const starye = [...est].filter((c) => !poPoryadku.includes(c)).sort(poAlfavitu)
    return [...poPoryadku, ...starye]
  }, [products, catList])
  useEffect(() => {
    if (cat !== VSE && !cats.includes(cat)) setCat(VSE)
  }, [cats, cat])

  // Сырьё (1.8.5) в кассе не показываем и не ищем: его не продают напрямую
  const sorted = useMemo(() => products.filter((p) => p.forSale !== false).sort((a, b) => poAlfavitu(a.name, b.name)), [products])
  const ishi = useCallback(
    (text, c) => {
      const q = String(text || '').trim().toLowerCase()
      const poTekstu = (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        String(p.barcode || '').includes(q) ||
        String(p.dosage || '').toLowerCase().includes(q)
      const vKategorii = sorted.filter((p) => (c === VSE || p.category === c) && poTekstu(p))
      if (vKategorii.length || !q || c === VSE) return { rows: vKategorii, outside: false }
      // Кассир выбрал «Сиропы» и набрал «аспирин». Ответ «ничего нет» был бы
      // враньём: товар есть, просто в другой категории
      return { rows: sorted.filter(poTekstu), outside: true }
    },
    [sorted],
  )
  // Сканер печатает тринадцать знаков за десятки миллисекунд. Список отстаёт от
  // набора намеренно: поле отвечает сразу, а каталог перерисовывается, когда успеет
  const dq = useDeferredValue(code)
  const found = useMemo(() => ishi(dq, cat), [ishi, dq, cat])
  const shown = useMemo(() => found.rows.slice(0, LIMIT), [found])
  // Двигал ли кассир подсветку стрелками. Если да — Enter берёт именно эту строку
  const hiTouched = useRef(false)
  useEffect(() => {
    setHi(0)
    hiTouched.current = false
  }, [dq, cat])

  const pickFromCatalog = useCallback(
    (p) => {
      if (addProduct(p)) {
        beepOk()
        // На телефоне каталог закрывает чек — говорим словами, что товар добавлен.
        // Если каталог открылся сам от набора, он сейчас сам и закроется: чек будет виден
        if (window.matchMedia(UZKO).matches && !autoPane.current) toast(`${p.name} ${t('добавлен в корзину')}`)
        setCode('')
      } else {
        // Не добавился (нет на складе) — набранное не стираем: рядом в списке
        // другие формы того же товара, и искать их заново кассиру незачем
        beepError()
      }
      vernutKursor()
    },
    [addProduct, toast, t, vernutKursor],
  )

  const moveHi = (d) => {
    hiTouched.current = true
    setHi((h) => Math.max(0, Math.min(shown.length - 1, h + d)))
    requestAnimationFrame(() => document.querySelector('.kc-row.hi')?.scrollIntoView({ block: 'nearest' }))
  }

  // ── Выбранная строка чека ──
  const sel = cart.find((i) => i.productId === selId) || cart[cart.length - 1] || null
  const moveSel = (d) => {
    if (!cart.length) return
    const idx = cart.findIndex((i) => i.productId === sel?.productId)
    const next = cart[Math.max(0, Math.min(cart.length - 1, idx + d))]
    if (next) setSelId(next.productId)
  }
  // Чек на широком экране листается внутри себя: строка, которую только что пробили
  // или выбрали стрелкой, не должна остаться за краем.
  // На телефоне чек листается всей страницей, и экран едет только к только что пробитой
  // строке (probito — её ставят addProduct и addWeight). Открыл кассир другой чек или убрал
  // строку — выбранной становится последняя, но страница под пальцем не уезжает
  const selLine = sel?.productId
  useEffect(() => {
    const svezhaya = probito.current === selLine
    probito.current = null
    if (!selLine) return
    if (!svezhaya && naTelefone()) return
    document.querySelector(`[data-line="${CSS.escape(selLine)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selLine, cart.length])
  const changeSel = (d) => sel && changeQty(sel.productId, d)
  const removeSel = () => sel && remove(sel.productId)
  const focusCell = (cls, zapas) => {
    if (!sel) {
      toast(t('Корзина пуста — отсканируйте товар'), 'err')
      return
    }
    const el =
      document.querySelector(`[data-line="${CSS.escape(sel.productId)}"] .${cls}`) ||
      (zapas ? document.querySelector(`[data-line="${CSS.escape(sel.productId)}"] .${zapas}`) : null)
    if (el) {
      el.focus()
      el.select?.()
    } else if (cls === 'inp-pieces') {
      toast(t('Этот товар продаётся только целыми упаковками'), 'err')
    }
  }

  function onScanKey(e) {
    // Остаток выстрела сканера после отката — см. ostanovitVystrel
    if (performance.now() < muteUntil.current) {
      e.preventDefault()
      return
    }
    const val = code.trim()

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      // Идёт поиск — стрелки ходят по каталогу, иначе по строкам чека
      if (val) moveHi(d)
      else moveSel(d)
      return
    }
    if (e.key === 'Escape') {
      if (code) {
        e.preventDefault()
        setCode('')
      }
      return
    }
    // «+», «−» и Delete правят чек только при пустом поле: иначе нельзя было бы
    // набрать «Но-шпа» или стереть букву в поиске
    if (!val) {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        changeSel(1)
        return
      }
      if (e.key === '-') {
        e.preventDefault()
        changeSel(-1)
        return
      }
      if (e.key === 'Delete') {
        e.preventDefault()
        removeSel()
        return
      }
    }

    // Enter при пустом поле не делает ничего — и уж точно не проводит продажу:
    // сканер сам дожимает Enter, и однажды продажа прошла бы случайно
    if (e.key !== 'Enter') return
    if (!val) return

    // Этикетка весов: в коде зашиты товар и точный вес
    const ves = parseVesEtiketku(val)
    if (ves) {
      const wp = productPoVesKodu(products, ves.code)
      if (wp) {
        if (addWeight(wp, ves.grams)) beepOk()
        else beepError()
      } else {
        beepError()
        toast(`${t('Весовой товар с кодом')} ${ves.code} ${t('не найден — впишите этот код в штрихкод весового товара')}`, 'err')
      }
      setCode('')
      return
    }

    const p = findByBarcode(val)
    if (p) {
      if (addProduct(p)) beepOk()
      else beepError()
      setCode('')
      return
    }

    const rows = ishi(code, cat).rows
    // Строку выбрали стрелками — берём именно её, что бы ни было набрано
    if (hiTouched.current && dq === code && rows[hi]) {
      pickFromCatalog(rows[hi])
      return
    }

    // Свои короткие коды (четыре-пять цифр) магазина тоже заводят. Если такого кода
    // нет ни у одного товара даже частью, это не поиск, а новый код
    const korotkiyKod = /^\d+$/.test(val) && !rows.length
    if (pohozheNaKod(val) || korotkiyKod) {
      // Список товаров ещё не пришёл — предлагать завести новый рано: так кассир
      // завёл бы второй раз товар, который в базе уже есть
      if (loadingProducts) {
        beepError()
        toast(t('Список товаров ещё загружается — отсканируйте ещё раз через секунду'), 'err')
        setCode('')
        return
      }
      beepError()
      setCode('')
      handleUnknown(val)
      return
    }

    // Набрано название — берём первую, подсвеченную строку каталога. Обрывок из
    // одних цифр так не работает: по нему легко попасть не в тот товар
    if (estBukva(val) && rows.length) {
      pickFromCatalog(rows[0])
      return
    }
    beepError()
    toast(rows.length ? t('Выберите товар в списке — стрелками или мышью') : t('Товар не найден'), 'err')
  }

  async function saveNewProduct(form) {
    if (!form.name.trim()) return toast(t('Введите название'), 'err')
    // Продажа дешевле закупки бывает нужна, но чаще это опечатка в цене
    if (sellsBelowCost(form.cost, form.price)) {
      const ok = await dialog.confirm({
        title: t('Цена продажи ниже закупочной'),
        message: `${t('Закупили по')} ${money(Number(form.cost) || 0)}, ${t('продаёте по')} ${money(Number(form.price) || 0)}. ${t('Каждая продажа принесёт убыток. Сохранить всё равно?')}`,
        danger: true,
        confirmText: t('Сохранить'),
      })
      if (!ok) return
    }
    try {
      // Та же воронка, что и в «Товарах»: раньше каждая страница приводила
      // числа по-своему, и «пусто» превращалось то в ноль, то в NaN
      const created = await db.push('products', productPayload(form, { normalizeBarcode: normalizeScan }))
      if (availUnits(created) > 0) addProduct(created)
      toast(`«${created.name}» ${t('добавлен в базу')}`)
      setNewProduct(null)
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // «Добавить позже» — кладём код (канонический, из DataMatrix — GTIN) в отложенные
  function deferBarcode(barcode) {
    const code = normalizeScan(barcode)
    if (!db.get('deferred').some((d) => d.barcode === code)) {
      db.push('deferred', { barcode: code }).catch((e) => toast(e.message, 'err'))
    }
    toast(t('Штрихкод отложен'))
    setNewProduct(null)
  }

  // Устанавливаем кол-во упаковок/штук с проверкой лимита по общему числу штук
  function applyLine(productId, qty, pieces) {
    const item = cart.find((i) => i.productId === productId)
    if (!item) return
    const live = products.find((p) => p.id === productId)
    const upp = uppOf(item)
    const avail = live ? availUnits(live) : lineUnits(item)
    const fit = fitLine({ qty, pieces, upp, avail })
    qty = fit.qty
    pieces = fit.pieces
    if (fit.capped) {
      // Отказ не должен быть тупиком. Остаток — последняя пачка, она уже в корзине,
      // а кассиру нужны три штуки из неё: штук на складе хватает, места не хватает
      // только из-за упаковки. Раньше он видел просто «максимум 5 шт» и не понимал,
      // что делать, — а сделать было и правда нечего.
      toast(
        isVesovoy(item)
          ? `${t('Максимум на складе')}: ${kgText(avail)} ${t(edinica(item))}` +
              (fit.blockedByPacks ? `. ${t('Уберите упаковку кнопкой «−», чтобы продать на вес')}` : '')
          : fit.blockedByPacks
            ? `${t('Максимум на складе')}: ${avail} ${t('шт')}. ${t('Уберите упаковку кнопкой «−», чтобы продать штуками')}`
            : `${t('Максимум на складе')}: ${avail} ${t('шт')}`,
        'err',
      )
    }
    setCart((c) =>
      c.map((i) => {
        if (i.productId !== productId) return i
        // Переклэмпиваем скидку под новую сумму позиции
        const gross = lineGross({ ...i, qty, pieces })
        return { ...i, qty, pieces, discount: Math.min(i.discount || 0, gross) }
      }),
    )
  }
  // ── Кнопка «−» ──
  // Первое нажатие доводит до нуля упаковок и ОСТАВЛЯЕТ строку. Раньше она при нуле
  // исчезала — и до состояния «0 упаковок + N штук» было не добраться в принципе:
  // пока упаковка в корзине, она занимает весь остаток последней пачки, и штуки
  // просто не помещаются. Вскрыть последнюю пачку было нельзя.
  //
  // Второе нажатие на уже пустой строке её убирает: привычный способ передумать
  // остаётся, а рядом есть корзинка для того же самого.
  // Вес в строке правится одним числом в килограммах. Черновик набора живёт,
  // только пока поле в фокусе: убрали курсор — показывается точный вес строки
  const [vesDraft, setVesDraft] = useState(null) // { id, val }
  // Сколько килограммов в поле: весь вес строки, у товара в мешке — отдельные килограммы
  const vesNow = (i) => String((vesPack(i) ? Number(i.pieces) || 0 : lineUnits(i)) / KG || '')
  const vesValue = (i) => (vesDraft?.id === i.productId ? vesDraft.val : vesNow(i))
  // Нажал на поле веса — набранное выделяется, и новое число ЗАМЕНЯЕТ старое. Раньше
  // курсор вставал в конец: в строке «1» (кг) кассир набирал 2 и получал «12» — и отказ
  // «максимум на складе» (владелец 31.10: «хочу просто купить 2 кг, а тут невозможно»).
  // Мышь ставит курсор уже после фокуса, поэтому первое нажатие перехватываем: фокус и
  // выделение — сами. Второе нажатие в уже открытом поле — обычное, чтобы поправить цифру
  const vybratVse = (e) => {
    const el = e.currentTarget
    if (document.activeElement === el) return
    e.preventDefault()
    el.focus()
    el.select?.()
  }
  const changeVes = (id, val) => {
    setVesDraft({ id, val })
    const it = cart.find((i) => i.productId === id)
    // У товара в мешке — отдельные килограммы, мешки остаются
    applyLine(id, it && vesPack(it) ? it.qty : 0, gramsOfKg(val))
  }

  const changeQty = (id, delta) => {
    const it = cart.find((i) => i.productId === id)
    if (!it) return
    // Весовому без мешка «упаковкой больше/меньше» означает ±1 кг; у мешка — ±1 мешок
    if (vesOnly(it)) return applyLine(id, 0, Math.max(0, lineUnits(it) + delta * KG))
    const empty = it.qty === 0 && (it.pieces || 0) === 0
    if (delta < 0 && empty) return remove(id)
    applyLine(id, it.qty + delta, it.pieces || 0)
  }
  const changePieces = (id, v) => {
    if (looksLikeScan(v)) return bailOutScan()
    const it = cart.find((i) => i.productId === id)
    if (it) applyLine(id, it.qty, Number(v) || 0)
  }

  // Скидка (сомони) на позицию — не больше суммы позиции
  function setDiscount(productId, value) {
    if (looksLikeScan(value)) return bailOutScan()
    if (obshchaya) return toast(t('Скидка задана на весь чек — снимите её, чтобы править по строкам'), 'err')
    const it = cart.find((i) => i.productId === productId)
    // Предупреждаем, если скидку урезали: иначе позиция молча уходила бы в ноль
    if (it && Number(value) > lineGross(it)) {
      toast(`${t('Скидка не больше суммы позиции')}: ${money(lineGross(it))}`, 'err')
    }
    setCart((c) =>
      c.map((i) => {
        if (i.productId !== productId) return i
        const d = Math.min(Math.max(0, Number(value) || 0), lineGross(i))
        return { ...i, discount: d }
      }),
    )
  }

  // Товары в корзине, у которых на складе есть просроченные партии.
  // Берём живые карточки, а не снимок из корзины: остаток мог измениться.
  const expiredInCart = cart
    .map((i) => products.find((p) => p.id === i.productId))
    .filter((p) => p && hasExpired(p))

  // Подпись над «− 1 +» на карточке строки: упаковки (и мешки весового) — «Упаковок»,
  // остальное — своей единицей: «Кол-во, шт», «Кол-во, рулон». После перехода на «шт»
  // (17.11.2026) штучный товар стоял под «Упаковок», хотя упаковок у него нет
  const podpisKolva = (i) => (packLabel(i) === 'уп' ? t('Упаковок') : `${t('Кол-во')}, ${t(packLabel(i))}`)
  const remove = (id) => setCart((c) => c.filter((i) => i.productId !== id))

  // ── Отложить товар (1.8.15; перенос 1.8.17) ──
  // Строка уходит из корзины в список «Отложенные товары» на устройстве (lib/otlozhennye.js):
  // не продаётся и не списывается, пока её не вернут. Сам список и возврат — в разделе
  // «Отложенные штрихкоды». Пишем прямо в хранилище: держать список в состоянии кассы теперь
  // незачем, касса его не показывает.
  function otlozhitTovar(line) {
    if (!line || !otlozhOn) return
    const list = chitatOtlozh(phCode)
    if (list.length >= MAX_OTLOZH) {
      toast(`${t('Отложено товаров')}: ${MAX_OTLOZH}. ${t('Верните или уберите из списка')}`, 'err')
      return
    }
    pisatOtlozh(phCode, [otlozhitItem(line), ...list])
    remove(line.productId)
    beepOk()
    toast(`«${line.name}» ${t('отложен')}`)
    vernutKursor()
  }
  const otlozhitSel = () => otlozhOn && sel && otlozhitTovar(sel)

  // «Очистить корзину» — покупатель передумал. Сам чек остаётся открытым, пустым
  const ochistit = () => {
    patch({ cart: [], received: '', discValue: '' })
    setIzm(null)
    vernutKursor()
  }

  const total = cart.reduce((s, i) => s + lineNet(i), 0)
  const discountTotal = cart.reduce((s, i) => s + Math.min(i.discount || 0, lineGross(i)), 0)
  // Сводка «Товаров»: каждая единица своим числом — «3 уп + 2 рулон + 5 шт + 1,5 кг».
  // Килограммы с литрами, как и упаковки с рулонами, в одно число не складываются.
  // Штуки из вскрытых пачек — в те же «шт», что и штучные товары: с переходом на «шт»
  // (17.11.2026) сводка писала «2 шт + 2 уп + 3 шт» — одна единица двумя слагаемыми
  const poEdinicam = new Map()
  const dobavit = (u, n) => poEdinicam.set(u, (poEdinicam.get(u) || 0) + n)
  for (const i of cart) {
    if (vesOnly(i)) dobavit(edinica(i), lineUnits(i))
    else if (isVesovoy(i)) {
      // Мешки — к упаковкам, отдельные килограммы — к килограммам
      if (i.qty) dobavit(packLabel(i), i.qty)
      if (i.pieces) dobavit(edinica(i), i.pieces)
    } else {
      if (i.qty) dobavit(edinica(i), i.qty)
      if (i.pieces) dobavit('шт', i.pieces)
    }
  }
  const countText = [...poEdinicam]
    .map(([u, n]) => (isVesovoy({ unit: u }) ? `${kgText(n)} ${t(u)}` : `${n} ${t(u)}`))
    .join(' + ') || `0 ${t('шт')}`
  // Сдача считается только для наличных: картой и в долг «получено» не бывает
  const sd = payment === 'cash' ? sdacha(total, received) : { state: 'none', diff: 0, received: null }
  const bills = payment === 'cash' ? kupyury(total) : []

  // ── Экран покупателя (программа для Windows, второй экран моноблока) ──
  // Покупателю — корзина и итог готовыми строками, как на чеке. После оплаты на пять
  // секунд — «Спасибо за покупку!» и сдача, потом — «Добро пожаловать». На сайте ничего
  const lang = useLang()
  const shopName = auth?.pharmacy?.name || ''
  const [thanks, setThanks] = useState(null)
  useEffect(() => {
    const base = { lang, shop: shopName, labels: customerLabels(t) }
    if (cart.length) {
      showCustomer(
        cartScreen({
          cart,
          total,
          discountTotal,
          shop: shopName,
          lang,
          t,
          money,
          sub: (i) => qtyPriceText(i, t, money) + (i.discount > 0 ? ` · ${t('скидка')} −${money(i.discount)}` : ''),
          sum: (i) => money(lineNet(i)),
        }),
      )
    } else if (thanks) showCustomer({ ...base, mode: 'thanks', total: thanks.total, change: thanks.change })
    else showCustomer({ ...base, mode: 'idle' })
  }, [cart, total, discountTotal, thanks, shopName, lang, t])
  useEffect(() => {
    if (!thanks) return undefined
    const id = setTimeout(() => setThanks(null), 5000)
    return () => clearTimeout(id)
  }, [thanks])
  // Следующий покупатель уже у кассы — «Спасибо» с суммой прошлого чека больше не нужно:
  // убрали его товар — покупатель увидит «Добро пожаловать», а не чужую сдачу
  useEffect(() => {
    if (cart.length && thanks) setThanks(null)
  }, [cart.length, thanks])
  // Ушли из кассы (в другой раздел, вышли) — покупателю снова «Добро пожаловать»
  const idleScreen = useRef(null)
  idleScreen.current = { mode: 'idle', lang, shop: shopName, labels: customerLabels(t) }
  useEffect(() => () => showCustomer(idleScreen.current), [])

  // ── Что изменилось в чеке, пока он лежал ──
  const opisat = useCallback(
    (notes) =>
      notes
        .map((n) =>
          n.kind === 'gone'
            ? `«${n.name}» ${t('удалён из базы — убран из чека')}`
            : n.kind === 'out'
              ? `«${n.name}» ${t('закончился — убран из чека')}`
              : n.kind === 'stock'
                ? `«${n.name}»: ${t('на складе осталось')} ${n.unit && n.unit !== 'шт' ? kgText(n.avail) : n.avail} ${t(n.unit || 'шт')} — ${t('количество уменьшено')}`
                : n.kind === 'piece'
                  ? n.unit && n.unit !== 'шт'
                    ? `«${n.name}»: ${t('цена за 1')} ${t(n.unit)} ${t('изменилась')} ${money(n.was)} → ${money(n.now)}`
                    : `«${n.name}»: ${t('цена за 1 шт изменилась')} ${money(n.was)} → ${money(n.now)}`
                  : `«${n.name}»: ${t('цена изменилась')} ${money(n.was)} → ${money(n.now)}`,
        )
        .join(' · '),
    [t],
  )
  const pokazatIzm = useCallback(
    (id, notes) => {
      const text = opisat(notes)
      // Тост гаснет через пару секунд, а изменение цены кассир обязан заметить —
      // поэтому оно ещё и остаётся строкой над чеком, пока её не закроют
      setIzm({ id, text })
      beepError()
      toast(text, 'err')
    },
    [opisat, toast],
  )

  // Сверяем активный чек с базой: при открытии кассы, при переходе на другой чек
  // и каждый раз, когда список товаров обновился (вторая касса продала, владелец
  // сменил цену). Ждём, пока товары загрузятся: по пустому списку все строки
  // выглядели бы «удалёнными».
  useEffect(() => {
    if (loadingProducts || !products.length) return
    const cur = chekRef.current
    if (!cur.cart.length) return
    const r = osvezhit(cur.cart, products, realId)
    if (!r.changed) return
    // Пересчитываем внутри обновления, по самой свежей корзине: за это время
    // кассир мог пробить ещё товар, и готовым результатом мы бы его затёрли
    setCheki((s) => ({
      ...s,
      list: s.list.map((c) => (c.id === cur.id ? { ...c, cart: osvezhit(c.cart, products, realId).cart } : c)),
    }))
    if (r.notes.length) pokazatIzm(cur.id, r.notes)
  }, [products, cheki.active, loadingProducts, pokazatIzm])

  // ── Вкладки чеков ──
  function novyyChek() {
    if (!cart.length) {
      // Плодить пустые вкладки незачем: этот чек и так готов к следующему покупателю
      toast(t('Этот чек пока пуст — сканируйте товар'), 'err')
      vernutKursor()
      return
    }
    if (cheki.list.length >= MAX_CHEKOV) {
      toast(`${t('Открыто чеков')}: ${MAX_CHEKOV}. ${t('Проведите или закройте один из них')}`, 'err')
      return
    }
    setCheki((s) => {
      const c = novyChek(svobodnyNomer(s.list))
      return { ...s, list: [...s.list, c].sort((a, b) => a.n - b.n), active: c.id }
    })
    setCode('')
    pokazat('check')
    toast(`${t('Чек')} ${chek.n} ${t('отложен — открыт новый')}`)
  }

  function pereyti(id) {
    if (id === cheki.active) return
    setCheki((s) => {
      const cur = s.list.find((c) => c.id === s.active)
      // Пустой чек, с которого ушли, вкладкой не оставляем — иначе они копились бы
      const list = cur && !cur.cart.length ? s.list.filter((c) => c.id !== cur.id) : s.list
      return { ...s, list, active: id }
    })
    setCode('')
    setSelId(null)
  }

  async function zakrytChek(c) {
    if (c.cart.length) {
      const ok = await dialog.confirm({
        title: `${t('Закрыть чек')} ${c.n}?`,
        message: `${t('В чеке товаров')}: ${c.cart.length}. ${t('Они будут убраны из чека. На складе ничего не изменится.')}`,
        danger: true,
        confirmText: t('Закрыть чек'),
      })
      if (!ok) return
    }
    setCheki((s) => {
      const list = s.list.filter((x) => x.id !== c.id)
      if (!list.length) {
        const n = novyChek(1)
        return { ...s, list: [n], active: n.id }
      }
      return { ...s, list, active: s.active === c.id ? list[list.length - 1].id : s.active }
    })
    setIzm(null)
  }

  async function pay() {
    if (paying) return
    if (!canSell) {
      toast(auth?.standalone ? soloMessage(desk?.activation, t) || t(auth?.subscription?.message || '') : auth?.subscription?.message || t('Продажи закрыты: подписка не оплачена'), 'err')
      return
    }
    // Смены нет — продажи нет: показываем окно, где смену можно открыть
    if (!smena) {
      setNoShiftModal(true)
      return
    }
    if (!cart.length) return

    // Последняя сверка с базой прямо перед оплатой. Если что-то изменилось по
    // существу — показываем и останавливаемся: кассир должен увидеть новую сумму
    // раньше, чем назовёт её покупателю
    let items = cart
    if (!loadingProducts && products.length) {
      const r = osvezhit(cart, products, realId)
      if (r.changed) {
        setCart(r.cart)
        if (r.notes.length) {
          pokazatIzm(chek.id, r.notes)
          return
        }
        items = r.cart
      }
    }

    if (payment === 'cash' && sd.state === 'short') {
      beepError()
      toast(`${t('Не хватает')} ${money(-sd.diff)}`, 'err')
      receivedRef.current?.focus()
      return
    }

    let customer = null
    if (payment === 'debt') {
      if (!customerId) {
        toast(t('Выберите клиента для долга'), 'err')
        return
      }
      const c = customers.find((x) => x.id === customerId)
      if (!c) {
        toast(t('Клиент не найден — выберите заново'), 'err')
        setCustomerId('')
        return
      }
      customer = { id: c.id, name: c.name }
    }
    // Перевод без сервиса не сверить с выпиской: выбранный, а если не выбирали —
    // первый из списка. Списка нет вовсе — его заводит владелец в настройках
    let via = ''
    if (payment === 'transfer') {
      via = payVia && payServices.some((s) => s.name === payVia) ? payVia : payServices[0]?.name || ''
      if (!via) {
        toast(t('Добавьте сервис перевода в «Настройках»'), 'err')
        return
      }
    }
    setPaying(true)
    const soldCart = items // на случай, если продажу не удастся записать — вернём в корзину
    const soldDisc = { discMode: chek.discMode, discValue: chek.discValue } // и скидку на чек — как была
    try {
      // Чек печатаем сразу по локальной записи — покупатель не ждёт ответа сервера,
      // запись уходит в фоне (цифры в чеке те же, что уйдут на сервер).
      const { sale, synced } = checkout({
        items: items.map((i) => ({
          productId: i.productId, name: i.name, qty: i.qty, pieces: i.pieces || 0,
          price: i.price, piecePrice: i.piecePrice ?? null, cost: i.cost, unitsPerPack: uppOf(i), unit: i.unit || '', discount: i.discount,
        })),
        payment,
        payVia: via,
        customer,
      })
      lastSaleRef.current = {
        tempId: sale.id,
        synced,
        chek: { cart: soldCart, payment, payVia: via, customerId, received, ...soldDisc },
      }
      // «Получено» и «Сдача» — только для бумажного чека. На сервер они не уходят:
      // на деньги смены сдача не влияет, в кассе остаётся ровно сумма чека.
      // _key — какой это чек для окна (номер записи сменится, когда продажа запишется)
      setReceipt({ ...sale, received: sd.state === 'ok' ? sd.received : null, change: sd.state === 'ok' ? sd.diff : 0, _key: sale.id })
      // Номер чека — из времени продажи, а записанная продажа получает время базы кассы
      // или сервера (на долю секунды позже). Чтобы номер на бумаге совпадал с номером в
      // отчётах и при поиске, окно чека переходит на записанную продажу, как только она
      // записалась, — и печатает уже её (см. Receipt)
      synced
        .then((stored) => {
          if (!stored?.date) return
          // Связи нет — чек лёг в очередь браузера и уйдёт на сервер сам (lib/offlineSales.js)
          if (stored._offline) toast(t('Нет связи — чек сохранён и уйдёт на сервер сам'))
          setReceipt((r) =>
            r && r._key === sale.id
              ? {
                  ...r,
                  ...stored,
                  customer: stored.customer || r.customer,
                  // У строк продажи на сервере нет единицы — берём её из строк кассы
                  items: stored.items?.length
                    ? stored.items.map((i) => (i.unit ? i : { ...i, unit: r.items.find((x) => x.productId === i.productId)?.unit || '' }))
                    : r.items,
                  received: r.received,
                  change: r.change,
                  _key: r._key,
                  _stored: true,
                }
              : r,
          )
        })
        .catch(() => {
          // Не записалась — чек не печатается (окно «Продажа не записана» вернёт корзину)
          setReceipt((r) => (r && r._key === sale.id ? { ...r, _failed: true } : r))
        })
      // Покупателю на втором экране — «Спасибо за покупку!» и сдача (если платил наличными)
      setThanks({ total: money(sale.total), change: sd.state === 'ok' && sd.diff > 0 ? money(sd.diff) : '' })
      // Чек продан — вкладка остаётся и готова к следующему покупателю: всё как у
      // нового чека, и скидка на чек тоже (иначе она досталась бы следующему)
      patch(posleProdazhi)
      setIzm(null)
      pokazat('check')
      toast(t('Продажа проведена'))

      // Деньги нельзя терять молча: если запись так и не прошла — возвращаем корзину
      synced.catch((e) => {
        setFailedSale({ message: e.message, cart: soldCart, payment, payVia: via, customerId, ...soldDisc })
        beepError()
      })
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setPaying(false)
    }
  }

  // Вернуть чек в корзину. Если кассир уже начал следующего покупателя, не смешиваем их:
  // возвращённый чек встаёт отдельной вкладкой
  function vernutChek(c) {
    const data = {
      cart: c.cart, payment: c.payment, payVia: c.payVia || '',
      customerId: c.customerId || '', received: c.received || '',
      // Скидка на чек — та же, что была при продаже: чек возвращается целиком
      discMode: c.discMode === 'pct' ? 'pct' : 'sum', discValue: c.discValue || '',
    }
    setCheki((s) => {
      const cur = s.list.find((c) => c.id === s.active)
      if (cur && !cur.cart.length) {
        return { ...s, list: s.list.map((c) => (c.id === cur.id ? { ...c, ...data } : c)) }
      }
      const c = { ...novyChek(svobodnyNomer(s.list)), ...data }
      return { ...s, list: [...s.list, c].sort((a, b) => a.n - b.n), active: c.id }
    })
  }

  // Продажа не записалась — возвращаем её чеком
  function vernutProdazhu() {
    vernutChek({ ...failedSale, received: '' })
    setFailedSale(null)
    setReceipt(null)
  }

  // ── «Отмена» в окне чека ──
  // Продажа уже записана, поэтому отменяется она возвратом всего чека с пометкой «Отмена
  // чека» (lib/otmena.js): товар — на полку, деньги — тем же способом, каким платили. Чек
  // возвращается в корзину только после того, как возврат записан: иначе продажа осталась
  // бы, а кассир провёл бы её второй раз
  async function otmenitProdazhu() {
    const last = lastSaleRef.current
    if (!last || !receipt || last.tempId !== receipt._key) throw new Error(t('Эту продажу уже нельзя отменить здесь — оформите возврат'))
    let real
    try {
      real = await last.synced // записанная продажа — с настоящим номером
    } catch {
      // Продажа не записалась вовсе — её вернёт в корзину окно «Продажа не записана»
      setReceipt((r) => (r && r._key === last.tempId ? null : r))
      return
    }
    // Чек продан без связи и ещё ждёт отправки — он просто снимается из очереди: возврат
    // не нужен (и без связи невозможен). Уже ушёл на сервер — отменяется возвратом, как обычно
    if (real?._offline && (await cancelQueued(real.id))) {
      vernutChek(last.chek)
      if (lastSaleRef.current === last) {
        lastSaleRef.current = null
        setThanks(null)
      }
      setReceipt((r) => (r && r._key === last.tempId ? null : r))
      toast(t('Продажа отменена — товары снова в корзине'))
      return
    }
    const v = otmenaVozvrat(real)
    if (!v.lines.length) throw new Error(t('В чеке нет товаров для возврата'))
    const { synced } = returnGoods(v)
    await synced
    // Возврат записан — чек в корзину в любом случае (кассир уже начал следующего — чек
    // встанет отдельной вкладкой). Окно и «Спасибо» закрываем, только если это всё ещё
    // эта продажа: пока шла отмена, могли провести следующую
    vernutChek(last.chek)
    if (lastSaleRef.current === last) {
      lastSaleRef.current = null
      setThanks(null)
    }
    setReceipt((r) => (r && r._key === last.tempId ? null : r))
    toast(t('Продажа отменена — товары снова в корзине'))
  }

  // Клиент для долга. На телефоне под списком появляется строка с ним целиком (имя, долг,
  // телефон) — экран подъезжает, чтобы она не осталась под полосой «Итого»
  const vybratKlienta = (id) => {
    setCustomerId(id)
    if (!naTelefone() || !id) return
    requestAnimationFrame(() => {
      document.querySelector('[data-testid="kassa-klient-kto"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  async function addCustomer() {
    const r = await dialog.prompt({
      title: t('Новый клиент'),
      fields: [
        { name: 'name', label: t('Имя клиента') },
        { name: 'phone', label: t('Телефон'), placeholder: '+992 …' },
      ],
      confirmText: t('Добавить'),
    })
    if (!r || !r.name.trim()) return
    try {
      const c = await db.push('customers', { name: r.name.trim(), phone: (r.phone || '').trim() })
      vybratKlienta(c.id)
      toast(t('Клиент добавлен'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // ── Поле «Получено» ──
  // Сюда тоже может прилететь штрихкод, и здесь это опаснее всего: сканер дожимает
  // Enter, а Enter в этом поле проводит продажу. Поэтому две защиты. Длинное число —
  // это код, а не деньги. А Enter, пришедший через миллисекунды после цифры, нажал
  // не человек.
  //
  // Порог здесь жёстче, чем у полей количества: быстрый кассир на цифровом блоке
  // жмёт «0» и Enter почти слитно, и принять его за сканер значило бы стереть
  // набранную сумму. Сканер шлёт знаки с разрывом в единицы миллисекунд.
  const SCANNER_GAP_MS = 35
  const lastRecvKey = useRef(0)
  function onReceivedChange(v) {
    if (looksLikeScan(v)) {
      setReceived('')
      ostanovitVystrel()
      return
    }
    setReceived(v)
  }
  function onReceivedKey(e) {
    const now = performance.now()
    const bystro = now - lastRecvKey.current < SCANNER_GAP_MS
    lastRecvKey.current = now
    if (e.key === 'Escape') {
      e.preventDefault()
      focusScanner()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (bystro) {
      setReceived('')
      ostanovitVystrel()
      return
    }
    pay()
  }
  // Способ оплаты. На телефоне под кнопками появляется своё — сервисы перевода, список
  // клиентов, «Получено» с купюрами — и оно часто оказывалось под полосой «Итого» у нижнего
  // края: экран подъезжает ровно настолько, чтобы его было видно (запас под полосу — в
  // m-kassa.css, scroll-margin)
  const vybratOplatu = (key) => {
    setPayment(key)
    vernutKursor()
    if (!naTelefone()) return
    requestAnimationFrame(() => {
      document
        .querySelector('.kassa-oplata [data-tour="pos.pay-via"], .kassa-oplata [data-tour="pos.customer"], .kassa-oplata [data-tour="pos.received"]')
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
  // После купюры — курсор в «Получено», кроме телефона (см. кнопки купюр)
  const kPoluchenomu = () => {
    if (!naTelefone()) receivedRef.current?.focus()
  }

  // F9 — к оплате. Наличными: курсор встаёт в «Получено», Enter там проводит
  // продажу. Картой и в долг получать нечего — продажа проводится сразу.
  function kOplate() {
    if (!smena) {
      setNoShiftModal(true)
      return
    }
    if (!cart.length) {
      toast(t('Корзина пуста — отсканируйте товар'), 'err')
      return
    }
    if (payment === 'cash') {
      receivedRef.current?.focus()
      receivedRef.current?.select?.()
    } else {
      pay()
    }
  }

  // ── Горячие клавиши ──
  // Обработчик один на всю жизнь страницы, а действия берутся из ссылки, которая
  // обновляется на каждой отрисовке: так клавиши всегда видят текущий чек.
  // F3 — поле скидки на чек. F2 при заданной скидке на чек ведёт туда же:
  // строки закрыты, и курсор в закрытом поле только сбивал бы с толку
  const focusChekDiscount = () => {
    const el = document.querySelector('.inp-chek-discount')
    if (!el) return toast(t('Скидка на чек вам не разрешена'), 'err')
    el.focus()
    el.select?.()
  }
  const skidka = () => (obshchaya ? focusChekDiscount() : focusCell('inp-discount'))
  const keys = useRef({})
  keys.current = { novyyChek, kOplate, focusCell, moveSel, changeSel, removeSel, focusScanner, skidka, focusChekDiscount, otlozhitSel }
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return
      // Открыто окно (чек, камера, карточка товара, подтверждение) или идёт тур —
      // клавиши принадлежат им, а не кассе
      if (document.querySelector('.overlay, .tur-root')) return
      const k = keys.current
      if (e.key === 'F2') { e.preventDefault(); k.skidka(); return }
      if (e.key === 'F3') { e.preventDefault(); k.focusChekDiscount(); return }
      if (e.key === 'F4') { e.preventDefault(); k.focusCell('inp-pieces', 'inp-ves'); return }
      if (e.key === 'F7') { e.preventDefault(); k.otlozhitSel(); return }
      if (e.key === 'F8') { e.preventDefault(); k.novyyChek(); return }
      if (e.key === 'F9') { e.preventDefault(); k.kOplate(); return }

      const el = document.activeElement
      const vPole = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (vPole) return // поля разбираются сами: поле сканера — в onScanKey
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // Фокус ушёл со сканера (нажали мышью способ оплаты или строку чека)
      if (e.key === 'ArrowDown') { e.preventDefault(); k.moveSel(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); k.moveSel(-1); return }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); k.changeSel(1); return }
      if (e.key === '-') { e.preventDefault(); k.changeSel(-1); return }
      if (e.key === 'Delete') { e.preventDefault(); k.removeSel(); return }
      // Любой печатный знак — это начало штрихкода или названия. Возвращаем фокус
      // сканеру, и знак попадает уже в него: скан после нажатия мышью не теряется
      // Пробел не в счёт: им нажимают кнопку, на которой стоит фокус
      if (e.key.length === 1 && e.key !== ' ') k.focusScanner()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Окно чека закрыто («Готово», «Печать»): продажа окончена, чек пуст. На телефоне экран
  // возвращается к полю сканера и камере — следующий покупатель начинается оттуда. Курсор в
  // поле не ставится (клавиатура не выезжает, см. vernutKursor). «Отмена» продажи сюда не
  // ведёт: товары вернулись в чек, и кассир остаётся там, где был
  const zakrytOknoCheka = () => {
    setReceipt(null)
    if (naTelefone()) window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Клиент, на которого пишется долг (оплата «В долг»)
  const klient = payment === 'debt' && customerId ? customers.find((c) => c.id === customerId) || null : null

  // ── Полоса «Итого + Провести продажу» на телефоне ──
  // Есть что продавать — или смены нет: смену открывают отсюда (см. разметку полосы)
  const mbar = cart.length > 0 || (canSell && noShift)
  // Почему продажи закрыты — тем же текстом, что сообщение при попытке продать (pay)
  const prichinaStop = canSell
    ? undefined
    : auth?.standalone
      ? soloMessage(desk?.activation, t) || t(auth?.subscription?.message || '')
      : auth?.subscription?.message || t('Продажи закрыты: подписка не оплачена')

  // Тур по кассе просит показать чек или каталог: на телефоне видно что-то одно
  useEffect(() => {
    const onPane = (e) => {
      autoPane.current = false
      setPane(e.detail === 'catalog' ? 'catalog' : 'check')
    }
    window.addEventListener('tur:pane', onPane)
    return () => window.removeEventListener('tur:pane', onPane)
  }, [])

  return (
    <Layout fill title={t('Касса')} subtitle={t('Продажа по сканеру штрихкода · упаковками и поштучно')}>
      <div className="kassa-wrap">
      {/* Магазин без интернета: главный больше не принимает эту кассу (1.7.0) */}
      <RegisterAlert />
      <div className={'kassa pane-' + pane + (mbar ? ' has-mbar' : '')}>
        {/* ── Сканер и каталог ──
            В разметке стоят первыми: на телефоне поле сканера должно быть сверху
            и видно всегда. На широком экране сетка ставит этот блок справа. */}
        <div className="kassa-side">
          <div className="scan-box">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t('Отсканируйте штрихкод или введите название')}</label>
              <div className="scan-line">
                {/* Одно поле и для сканера, и для поиска. Два поля — это кассир,
                    который рано или поздно сканирует не в то */}
                <div className="scan-wrap">
                  <span className="scan-ic" aria-hidden="true"><LuScanLine size={18} /></span>
                  <input
                    ref={inputRef}
                    className="scan-input"
                    data-tour="pos.scan"
                    value={code}
                    onChange={(e) => {
                      if (performance.now() < muteUntil.current) return
                      setCode(e.target.value)
                    }}
                    onKeyDown={onScanKey}
                    placeholder={t('Наведите сканер на товар…')}
                    data-vkb-default
                    // На телефоне курсор в поле не ставится и при входе: на Android он сразу
                    // поднимал клавиатуру на пол-экрана (см. vernutKursor)
                    autoFocus={!telefon}
                  />
                </div>
                <button className="btn ghost" data-tour="pos.camera" title={t('Камера')} aria-label={t('Камера')} onClick={() => { unlockAudio(); setCamera(true) }}>
                  <span className="ic"><LuCamera size={17} /></span> <span className="cam-text">{t('Камера')}</span>
                </button>
              </div>
            </div>
            <div className="scan-hint">
              <span className="ic"><LuScanLine size={15} /></span>
              {t('USB-сканер работает как клавиатура · для продажи поштучно укажите «штук в упаковке» в карточке товара')}
            </div>
          </div>

          {/* На узком экране чек и каталог рядом не помещаются — показываем что-то одно */}
          <div className="kassa-switch" data-tour="pos.switch" role="tablist">
            <button role="tab" aria-selected={pane === 'check'} className={pane === 'check' ? 'active' : ''} onClick={() => pokazat('check')}>
              {t('Чек')}{cart.length > 0 && <span className="chek-count">{cart.length}</span>}
            </button>
            <button role="tab" aria-selected={pane === 'catalog'} className={pane === 'catalog' ? 'active' : ''} onClick={() => pokazat('catalog')}>
              {t('Каталог')}
            </button>
          </div>

          <div className="kassa-catalog" data-tour="pos.catalog">
            {/* Шапка каталога: строка «Категории: …» сворачивает и разворачивает плашки.
                Свёрнутая показывает выбранную категорию, а списку достаётся больше места */}
            {cats.length > 0 && (
              <div className={'kc-cats-box' + (catsOpen ? ' open' : '')} data-tour="pos.cats">
                <button
                  type="button"
                  className="kc-cats-head"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleCats}
                  aria-expanded={catsOpen}
                  aria-controls="kc-cats"
                  data-tour="pos.cats-toggle"
                >
                  <span className={'kc-caret' + (catsOpen ? ' open' : '')} aria-hidden="true"><LuChevronRight size={16} /></span>
                  <span className="kc-cats-title">{t('Категории')}: <b>{cat === VSE ? t('Все') : t(cat)}</b></span>
                  <span className="kc-cats-hint">{catsOpen ? t('свернуть') : t('развернуть')}</span>
                </button>
                {/* На телефоне плашек — не больше двух рядов, остальные по «Ещё» (ChipsMore):
                    сотня категорий иначе отодвинула бы сам список товаров на несколько экранов.
                    Ключ на телефоне — категория: после выбора ряд рождается заново, свёрнутым
                    до двух рядов (см. vybratKat). На компьютере ряд листается внутри себя —
                    там он не пересоздаётся, иначе прокрутка плашек сбрасывалась бы */}
                {catsOpen && (
                  <ChipsMore className="kc-cats" id="kc-cats" key={telefon ? cat : 'kc-cats'}>
                    <button className={'chip ' + (cat === VSE ? 'active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => vybratKat(VSE)}>{t('Все')}</button>
                    {cats.map((c) => (
                      <button key={c} className={'chip ' + (cat === c ? 'active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => vybratKat(c)}>{t(c)}</button>
                    ))}
                  </ChipsMore>
                )}
              </div>
            )}
            <KassaCatalog
              onFoto={setFoto}
              rows={shown}
              byId={byId}
              total={found.rows.length}
              hi={hi}
              showHi={dq.trim() !== ''}
              outside={found.outside}
              loading={loadingProducts && !products.length}
              noProducts={!loadingProducts && !products.length}
              onPick={pickFromCatalog}
            />
          </div>
        </div>

        {/* ── Чек ── */}
        <div className="kassa-receipt">
          <div className="cheki" data-tour="pos.cheki">
            {cheki.list.map((c) => (
              <div key={c.id} className={'chek-tab' + (c.id === chek.id ? ' active' : '')}>
                <button className="chek-tab-main" onClick={() => pereyti(c.id)} title={`${t('Чек')} ${c.n}`}>
                  {t('Чек')} {c.n}
                  {c.cart.length > 0 && <span className="chek-count">{c.cart.length}</span>}
                </button>
                {cheki.list.length > 1 && (
                  <button className="chek-x" onClick={() => zakrytChek(c)} title={t('Закрыть чек')} aria-label={`${t('Закрыть чек')} ${c.n}`}>
                    <LuX size={13} />
                  </button>
                )}
              </div>
            ))}
            <button className="btn ghost sm chek-new" onClick={novyyChek} title={t('Отложить этот чек и открыть новый')}>
              <span className="ic"><LuPlus size={15} /></span> {t('Отложить чек')} <kbd className="kbd">F8</kbd>
            </button>
          </div>

          {izm && izm.id === chek.id && (
            <div className="note err kassa-izm" role="alert">
              <LuTriangleAlert size={17} style={{ flexShrink: 0, marginTop: 1 }} />
              {/* «Чек изменился», а не «пока чек лежал»: то же самое случается и с чеком,
                  который прямо сейчас на экране, — вторая касса продала товар из него */}
              <span>{t('Чек изменился')}: {izm.text}</span>
              <button className="chek-x" onClick={() => setIzm(null)} title={t('Закрыть')} aria-label={t('Закрыть')}><LuX size={14} /></button>
            </div>
          )}

          <div className="panel kassa-cart" data-tour="pos.cart">
            <h2>
              <span className="h2-title"><span className="ic"><LuShoppingCart size={17} /></span>{t('Корзина')}</span>
              {cart.length > 0 && (
                <span className="kassa-cart-tools">
                  <span className="tag-cat">{countText}</span>
                  {/* Стоит у самой корзины, а не рядом с «Провести продажу»: промах
                      мимо главной кнопки не должен стирать набранный чек */}
                  <button className="btn ghost sm" disabled={paying} data-tour="pos.clear" onClick={ochistit}>
                    {t('Очистить корзину')}
                  </button>
                </span>
              )}
            </h2>
            {expiredInCart.length > 0 && (
              <div className="note err" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <LuTriangleAlert size={17} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {t('В чеке есть товар с просроченными партиями. Покупателю уходит только годный, но просрочку надо убрать с полки и списать:')}
                  <br />
                  {expiredInCart.map((p) => `${p.name} — ${expiredUnits(p)} ${t('шт')}`).join('; ')}
                </span>
              </div>
            )}
            {cart.length === 0 ? (
              <div className="empty">{t('Корзина пуста — отсканируйте товар')}</div>
            ) : (
              <div className="kassa-table-wrap">
                <table className="kassa-table">
                  <thead>
                    <tr>
                      <th className="kt-n">№</th><th>{t('Товар')}</th><th className="num kt-upp">{t('В уп.')}</th>
                      <th>{t('Упаковок')}</th><th>{t('Штук')}</th><th>{t('Скидка')}</th>
                      <th className="num">{t('Сумма')}</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((i, n) => (
                      <tr
                        key={i.productId}
                        data-line={i.productId}
                        className={sel?.productId === i.productId ? 'sel' : ''}
                        onClick={() => setSelId(i.productId)}
                      >
                        <td className="kt-n">{n + 1}</td>
                        <td className="kt-name">
                          <b>{i.name}</b>
                          <div className="tag-cat">
                            {money(i.price)}
                            {vesOnly(i)
                              ? ` / ${t(edinica(i))}`
                              : isDiv(i) && ` · ${money(pricePerPiece(i))}/${t(vesPack(i) ? edinica(i) : 'шт')}`}
                            {/* На телефоне колонки «В уп.» нет — число переезжает сюда */}
                            {isDiv(i) && (
                              <span className="kt-upp-m"> · {t('в уп.')} {vesPack(i) ? `${drob(packPieces(i))} ${t(edinica(i))}` : uppOf(i)}</span>
                            )}
                          </div>
                        </td>
                        <td className="num kt-upp">
                          {vesOnly(i) ? (
                            <span className="tag-cat">{t(edinica(i))}</span>
                          ) : vesPack(i) ? (
                            `${drob(packPieces(i))} ${t(edinica(i))}`
                          ) : isDiv(i) ? (
                            uppOf(i)
                          ) : (
                            <span className="tag-cat">—</span>
                          )}
                        </td>
                        {/* data-label — подпись поля на телефоне: заголовка таблицы там нет */}
                        {/* Весовой без мешка упаковками не продаётся: вес вводится в колонке
                            «Штук», как штуки (1.5.11). В мешке (1.5.12) — мешки здесь, килограммы
                            в «Штук». На карточке телефона пустая клетка не видна */}
                        <td className={'kt-qty' + (vesOnly(i) ? ' kt-empty' : '')} data-label={vesOnly(i) ? undefined : podpisKolva(i)}>
                          {vesOnly(i) ? (
                            <span className="tag-cat">—</span>
                          ) : (
                            <div className="qty-ctrl" data-tour="pos.qty">
                              <button onClick={() => changeQty(i.productId, -1)} aria-label={t('Упаковкой меньше')}><LuMinus size={14} /></button>
                              <b>{i.qty}</b>
                              <button onClick={() => changeQty(i.productId, 1)} aria-label={t('Упаковкой больше')}><LuPlus size={14} /></button>
                            </div>
                          )}
                        </td>
                        {/* Товар не делится и не весовой — в клетке только прочерк: на карточке
                            телефона её нет (kt-empty), поле скидки встаёт рядом с упаковками */}
                        <td
                          className={'kt-pcs' + (!isVesovoy(i) && !isDiv(i) ? ' kt-empty' : '')}
                          data-label={isVesovoy(i) ? (isKg(i) ? t('Вес, кг') : `${t('Кол-во')}, ${t(edinica(i))}`) : t('Штук')}
                          data-tour="pos.pieces"
                        >
                          {isVesovoy(i) ? (
                            <span className="ves-cell">
                              <NumberInput
                                className="disc-input inp-ves"
                                value={vesValue(i)}
                                onChange={(e) => changeVes(i.productId, e.target.value)}
                                onKeyDown={(e) => onCellKey(e, i.productId)}
                                onMouseDown={vybratVse}
                                onFocus={(e) => {
                                  snapLine(i.productId)
                                  setVesDraft({ id: i.productId, val: vesNow(i) })
                                  e.target.select?.()
                                }}
                                onBlur={() => setVesDraft(null)}
                                placeholder="0"
                                title={isKg(i) ? t('Вес в килограммах, до грамма') : `${t('Количество')}, ${t(edinica(i))}`}
                                aria-label={isKg(i) ? t('Вес, кг') : `${t('Кол-во')}, ${t(edinica(i))}`}
                              />
                              <span className="ves-unit">{t(edinica(i))}</span>
                            </span>
                          ) : isDiv(i) ? (
                            <NumberInput
                              className="disc-input inp-pieces"
                              integer
                              value={i.pieces || ''}
                              onChange={(e) => changePieces(i.productId, e.target.value)}
                              onKeyDown={(e) => onCellKey(e, i.productId)}
                              onFocus={() => snapLine(i.productId)}
                              placeholder="0"
                              title={`${t('Штук из упаковки')} (${t('в уп.')} ${uppOf(i)})`}
                              aria-label={t('Штук')}
                            />
                          ) : (
                            <span className="tag-cat">—</span>
                          )}
                        </td>
                        <td className={'kt-disc' + (can('pos.discount') ? '' : ' kt-empty')} data-label={t('Скидка')} data-tour="pos.discount">
                          {can('pos.discount') ? (
                            <NumberInput
                              className="disc-input inp-discount"
                              integer
                              value={i.discount || ''}
                              onChange={(e) => setDiscount(i.productId, e.target.value)}
                              onKeyDown={(e) => onCellKey(e, i.productId)}
                              onFocus={() => snapLine(i.productId)}
                              placeholder="0"
                              readOnly={obshchaya}
                              title={obshchaya ? t('Скидка задана на весь чек') : t('Скидка на позицию, сомони')}
                              aria-label={t('Скидка')}
                            />
                          ) : (
                            <span className="tag-cat">—</span>
                          )}
                        </td>
                        <td className="num kt-sum">
                          {i.discount > 0 && <div className="tag-cat" style={{ textDecoration: 'line-through' }}>{money(lineGross(i))}</div>}
                          <b>{money(lineNet(i))}</b>
                        </td>
                        <td className="num kt-del">
                          {/* Отложить товар (1.8.15): уходит в список «Отложенные товары» (раздел
                              «Отложенные штрихкоды»), не продаётся. Показываем, только если этот
                              раздел у магазина есть — иначе товар некуда вернуть (1.8.17) */}
                          {otlozhOn && (
                            <button className="btn ghost sm icon" data-testid="pos-otlozhit" onClick={(e) => { e.stopPropagation(); otlozhitTovar(i) }} aria-label={t('Отложить товар')} title={t('Отложить товар')}>
                              <LuBookmark size={15} />
                            </button>
                          )}
                          <button className="btn ghost sm icon" data-tour="pos.remove" onClick={() => remove(i.productId)} aria-label={t('Убрать из чека')} title={t('Убрать из чека')}>
                            <LuTrash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Подсказка по клавишам — только там, где есть клавиатура */}
            <div className="kassa-keys" data-tour="pos.keys">
              <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> {t('строка')}</span>
              <span><kbd className="kbd">+</kbd><kbd className="kbd">−</kbd> {t('упаковки')}</span>
              <span><kbd className="kbd">Del</kbd> {t('убрать')}</span>
              <span><kbd className="kbd">F2</kbd> {t('скидка')}</span>
              <span><kbd className="kbd">F3</kbd> {t('скидка на чек')}</span>
              <span><kbd className="kbd">F4</kbd> {t('штуки')}, {t('кг')}</span>
              {otlozhOn && <span><kbd className="kbd">F7</kbd> {t('отложить товар')}</span>}
            </div>
          </div>

          <div className="cart-panel">
            {/* Итог виден издалека — и кассиру, и покупателю */}
            <div className="kassa-itogo" data-tour="pos.total">
              {can('pos.discount') && (
                <div className="chek-skidka" data-tour="pos.chek-discount">
                  <span className="cs-label">{t('Скидка на чек')}</span>
                  <NumberInput
                    className="cs-input inp-chek-discount"
                    value={chek.discValue}
                    onChange={(e) => setObshchaya(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); gotovoVPole(e) } }}
                    placeholder="0"
                    aria-label={t('Скидка на чек')}
                    title={t('Скидка на весь чек: сумма или процент. Разложится по строкам')}
                  />
                  {/* Валюта — тем же словом, что в суммах рядом (money): на таджикском перевод
                      давал «сомонӣ», а все суммы на экране пишут «сомони» */}
                  <div className="cs-mode" role="group" aria-label={t('Сумма или процент')}>
                    <button type="button" className={chek.discMode === 'sum' ? 'active' : ''} onClick={() => { setDiscMode('sum'); vernutKursor() }}>{valyuta()}</button>
                    <button type="button" className={chek.discMode === 'pct' ? 'active' : ''} onClick={() => { setDiscMode('pct'); vernutKursor() }}>%</button>
                  </div>
                  {obshchaya && (
                    <button type="button" className="cs-x" onClick={() => { setObshchaya(''); vernutKursor() }} title={t('Снять скидку с чека')} aria-label={t('Снять скидку с чека')}>
                      <LuX size={14} />
                    </button>
                  )}
                </div>
              )}
              <div className="total-row"><span>{t('Сумма')}</span><span>{money(total + discountTotal)}</span></div>
              <div className="total-row"><span>{t('Скидка')}</span><span>{discountTotal > 0 ? '−' : ''}{money(discountTotal)}</span></div>
              <div className="total-row"><span>{t('Товаров')}</span><span>{cart.length ? countText : '0'}</span></div>
              <div className="total-row big"><span>{t('Итого')}</span><SummaItogo text={money(total)} /></div>
            </div>

            <div className="kassa-oplata">
              <div className="pay-methods" data-tour="pos.pay-methods">
                {Object.entries(PAYMENTS).filter(([key]) => key !== 'debt' || can('pos.debt')).map(([key, m]) => (
                  <button key={key} className={payment === key ? 'active' : ''} onClick={() => vybratOplatu(key)}>
                    <span className="ic"><m.Icon size={19} /></span>{t(m.label)}
                  </button>
                ))}
              </div>

              {payment === 'transfer' && (
                <div className="field" data-tour="pos.pay-via">
                  <label>{t('Через какой сервис')}</label>
                  {payServices.length ? (
                    <div className="chips">
                      {payServices.map((s) => (
                        <button
                          key={s.id}
                          className={'chip ' + ((payVia || payServices[0]?.name) === s.name ? 'active' : '')}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setPayVia(s.name); vernutKursor() }}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="note err">{t('Добавьте сервис перевода в «Настройках»')}</div>
                  )}
                </div>
              )}

              {payment === 'debt' && (
                <div className="field" data-tour="pos.customer">
                  <label>{t('Клиент')}</label>
                  {/* kassa-klient: список не шире строки, сколько бы ни было в имени клиента (m-kassa.css) */}
                  <div className="kassa-klient" style={{ display: 'flex', gap: 8 }}>
                    <select value={customerId} onChange={(e) => vybratKlienta(e.target.value)}>
                      <option value="">{t('— выберите —')}</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} {c.debt ? `(${t('долг')} ${money(c.debt)})` : ''}</option>
                      ))}
                    </select>
                    {can('customers.create') && <button className="btn ghost icon" onClick={addCustomer} aria-label={t('Новый клиент')}><LuPlus size={17} /></button>}
                  </div>
                  {/* Телефон: в узком списке выбранный клиент обрезан на полуслове — «Магазин
                      «Сомон» (оп…». Под списком он целиком, с текущим долгом и телефоном: видно,
                      тому ли клиенту пишется долг */}
                  {telefon && klient && (
                    <div className="kassa-klient-kto" data-testid="kassa-klient-kto">
                      <b>{klient.name}</b>
                      <span>
                        {klient.debt ? `${t('Текущий долг')}: ${money(klient.debt)}` : t('нет долга')}
                        {klient.phone ? ` · ${klient.phone}` : ''}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {payment === 'cash' && (
                <div className="kassa-poluchen" data-tour="pos.received">
                  <div className="kp-line">
                    <label htmlFor="kassa-received">{t('Получено')}</label>
                    <NumberInput
                      id="kassa-received"
                      ref={receivedRef}
                      className="kp-input"
                      value={received}
                      onChange={(e) => onReceivedChange(e.target.value)}
                      onKeyDown={onReceivedKey}
                      placeholder="0"
                    />
                    <div className={'kp-sdacha ' + sd.state} aria-live="polite">
                      {sd.state === 'ok' && <>{t('Сдача')} <b>{money(sd.diff)}</b></>}
                      {sd.state === 'short' && <>{t('Не хватает')} <b>{money(-sd.diff)}</b></>}
                    </div>
                  </div>
                  {bills.length > 0 && (
                    <div className="kp-bills">
                      {/* Одно нажатие вместо набора суммы: покупатель дал купюру — нажали её.
                          На компьютере курсор встаёт в «Получено» — Enter там проводит продажу.
                          На телефоне нет: курсор в поле поднимал цифровую клавиатуру, и она
                          закрывала «Провести продажу», хотя купюры для того и сделаны, чтобы
                          ничего не печатать */}
                      <button onClick={() => { setReceived(String(Math.round(total * 100) / 100)); kPoluchenomu() }}>{t('Без сдачи')}</button>
                      {bills.map((b) => (
                        <button key={b} onClick={() => { setReceived(String(b)); kPoluchenomu() }}>{b}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}

            </div>

            <div className="kassa-deystviya">
              <button
                className="btn gold kassa-pay"
                data-tour="pos.pay"
                disabled={!cart.length || paying || !canSell || !smena || sd.state === 'short'}
                onClick={pay}
                title={canSell ? undefined : auth?.subscription?.message || ''}
              >
                <span className="ic"><LuCheck size={18} /></span> {paying ? t('Проведение…') : t('Провести продажу')} <kbd className="kbd">F9</kbd>
              </button>
            </div>
            {!canSell && (
              <div className="note err kassa-stop" data-testid="kassa-licence-stop">
                {auth?.standalone
                  ? soloMessage(desk?.activation, t) || t(auth?.subscription?.message || 'Срок работы программы закончился — продажи и изменения остановлены, просмотр и отчёты работают. Введите код активации: «Настройки» → «Профиль».')
                  : t('Продажи закрыты: подписка не оплачена. Товары и отчёты открыты, копию базы скачать можно.')}
              </div>
            )}
            {canSell && noShift && (
              <div className="note warn kassa-stop" data-tour="pos.noshift-note">
                {t('Смена не открыта — сначала откройте смену, тогда можно будет продавать.')}{' '}
                <button type="button" className="linklike" onClick={() => setNoShiftModal(true)}>{t('Открыть смену')}</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* ── Телефон: итог и «Провести продажу» всегда внизу (17.11.2026, просьба владельца) ──
          На узком экране панель оплаты стоит под чеком: с длинным чеком до неё надо листать.
          Полоса над нижней — та же кнопка (тот же pay и те же условия) и сумма к оплате; кнопка
          в панели на телефоне спрятана (index.css). На компьютере полосы нет. Пустой чек —
          полосы нет: продавать нечего (кроме «смены нет», см. ниже).
          Продать нельзя — кнопка говорит почему: бледная выключенная кнопка без слов выглядела
          поломкой, а объяснение стояло в самом низу панели. Смены нет — «Открыть смену» (то же
          окно, что при входе в кассу), и тогда полоса стоит даже при пустом чеке: кассир,
          закрывший окно при входе, открывает смену отсюда, не листая. Продажи закрыты — так и
          написано, подробности — в заметке внизу панели */}
      {mbar && (
        <div className="kassa-mbar" data-testid="kassa-mbar">
          <div className="kmb-sum">
            <span>{t('Итого')}</span>
            <SummaPolosa text={money(total)} />
            {/* Сумма — неразрывно: узкая колонка переносит строку после «Не хватает» */}
            {sd.state === 'short' && <small>{t('Не хватает')} <span className="kmb-nw">{money(-sd.diff)}</span></small>}
          </div>
          {/* Метка тура та же, что у кнопки в панели: тур берёт видимую из двух */}
          {!canSell ? (
            <button className="btn gold kmb-pay kmb-stop" data-tour="pos.pay" data-testid="kmb-closed" disabled title={prichinaStop}>
              <span className="ic"><LuLock size={17} /></span> {t('Продажи закрыты')}
            </button>
          ) : noShift ? (
            <button className="btn gold kmb-pay" data-tour="pos.pay" data-testid="kmb-smena" onClick={() => setNoShiftModal(true)}>
              <span className="ic"><LuClock size={17} /></span> {can('shift.open') ? t('Открыть смену') : t('Смена не открыта')}
            </button>
          ) : (
            <button
              className="btn gold kmb-pay"
              data-tour="pos.pay"
              disabled={!cart.length || paying || !smena || sd.state === 'short'}
              onClick={pay}
            >
              <span className="ic"><LuCheck size={18} /></span> {paying ? t('Проведение…') : t('Провести продажу')}
            </button>
          )}
        </div>
      )}
      {/* Кто работает, экранная клавиатура и блокировка — в полосе внизу окна, она
          теперь одна на весь проект (components/AppFoot.jsx). Открытые чеки хранятся
          на устройстве при каждом изменении, поэтому блокировка их не теряет; экранная
          клавиатура без курсора печатает в поле сканера (data-vkb-default) */}
      </div>

      {/* ── Смена не открыта ── Окно при входе в кассу и при попытке продать. Закрыть
          его можно — посмотреть цены и остатки; продать без смены всё равно нельзя */}
      {noShiftModal && noShift && (
        <Modal title={<><span className="ic"><LuLock size={18} /></span>{t('Смена не открыта')}</>} onClose={() => setNoShiftModal(false)}>
          <div data-tour="pos.noshift">
            <div className="note warn" style={{ marginBottom: 14 }}>
              {t('Сначала откройте смену: без открытой смены продажа невозможна.')}{' '}
              {t('Каждый чек попадает в отчёт смены — так вечером касса сойдётся.')}
            </div>
            {can('shift.open') ? (
              <>
                <div className="field">
                  <label htmlFor="posOpenCash">{t('Наличные в кассе на начало (сомони)')}</label>
                  <NumberInput id="posOpenCash" data-tour="pos.noshift-cash" value={openCash} onChange={(e) => setOpenCash(e.target.value)} placeholder="0" autoFocus onKeyDown={(e) => e.key === 'Enter' && openShiftHere()} />
                </div>
                <div className="modal-actions">
                  <button className="btn ghost" onClick={() => setNoShiftModal(false)} disabled={openingShift}>{t('Закрыть')}</button>
                  <button className="btn gold" data-tour="pos.noshift-open" onClick={openShiftHere} disabled={openingShift}>
                    <span className="ic"><LuClock size={16} /></span> {openingShift ? t('Открываем…') : t('Открыть смену')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 14, lineHeight: 1.6, margin: '0 0 6px' }}>
                  {t('Открыть смену может владелец или сотрудник с правом «Смена кассы: открыть и закрыть». Попросите его открыть смену — и можно продавать.')}
                </p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setNoShiftModal(false)}>{t('Закрыть')}</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
      {analogFor && (
        <Modal
          title={`«${analogFor.product.name}» — ${analogFor.allExpired ? t('весь остаток просрочен') : t('нет в наличии')}`}
          onClose={() => setAnalogFor(null)}
        >
          <div className={'note ' + (analogFor.allExpired ? 'err' : 'info')} style={{ marginBottom: 12 }}>
            {analogFor.allExpired
              ? t('Продавать этот товар нельзя — уберите его с полки и спишите. Есть аналоги в наличии:')
              : t('Есть аналоги в наличии — нажмите, чтобы добавить в корзину:')}
          </div>
          {/* На телефоне — карточками (table-cards): название крупно, цена и остаток с подписями;
              нажатие на карточку, как и на строку, кладёт аналог в корзину */}
          <table className="table-cards">
            <tbody>
              {analogFor.analogs.map((a) => (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => { addProduct(a); setAnalogFor(null) }}>
                  <td className="cell-main"><b>{a.name}</b>{a.dosage ? <div className="tag-cat">{a.dosage}</div> : null}</td>
                  <td className="num" data-label={t('Цена')}>{money(a.price)}</td>
                  <td className="num" data-label={t('Остаток')}><span className="badge ok">{stockText(a)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-actions"><button className="btn ghost" onClick={() => setAnalogFor(null)}>{t('Закрыть')}</button></div>
        </Modal>
      )}
      {receipt && <Receipt sale={receipt} onClose={zakrytOknoCheka} onCancel={can('returns.create') ? otmenitProdazhu : null} />}
      {/* Продажа не записалась. Окно — после чека, чтобы лечь поверх него: кассир
          должен увидеть отказ, а не закрыть его вместе с чеком одним Escape.
          Закрыть окно любым способом — значит вернуть товары в корзину, как в нём
          и написано: иначе продажа пропадала бы молча, а деньги покупателя — в кассе */}
      {failedSale && (
        <Modal
          title={<><span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>{t('Продажа не записана')}</>}
          onClose={vernutProdazhu}
        >
          <div className="note err" style={{ marginBottom: 12 }}>{failedSale.message}</div>
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
            {t('Товары возвращены в корзину, остаток на складе восстановлен. Проверьте связь и проведите продажу заново.')}
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={vernutProdazhu}>{t('Вернуть в корзину')}</button>
          </div>
        </Modal>
      )}
      {foto && <Lightbox src={foto.image} alt={foto.name} onClose={() => setFoto(null)} />}
      {camera && (
        <Suspense fallback={
          <div className="overlay" onClick={() => setCamera(false)}>
            <div className="modal" style={{ maxWidth: 320, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
              <div className="empty">{t('Запуск камеры…')}</div>
            </div>
          </div>
        }>
          <CameraScanner onDetect={onCameraDetect} onClose={() => setCamera(false)} />
        </Suspense>
      )}
      {newProduct &&
        (isFounder ? (
          <NewProductModal
            barcode={newProduct.barcode}
            stock="1"
            note={tr('товара нет в базе. Заполните карточку (добавится в корзину) или нажмите «Добавить позже» — штрихкод уйдёт в «Отложенные».')}
            confirmText={tr('Добавить и в корзину')}
            onSave={saveNewProduct}
            onDefer={can('pos.defer', 'deferred.manage') ? () => deferBarcode(newProduct.barcode) : null}
            onClose={() => setNewProduct(null)}
          />
        ) : (
          <UnknownBarcode
            barcode={newProduct.barcode}
            onDefer={can('pos.defer', 'deferred.manage') ? () => deferBarcode(newProduct.barcode) : null}
            onClose={() => setNewProduct(null)}
          />
        ))}
    </Layout>
  )
}

// ── Сумма «Итого»: в одну строку с подписью, число крупно, «сомони» мельче ──
// Длинная сумма («12 345,50 сомони») рядом с «ИТОГО» в узкую панель не помещается —
// тогда шрифт сам уменьшается ровно настолько, чтобы влезть. Строка всегда одна, а
// высота панели не меняется, пока кассир сканирует. Меряем один раз при полном
// размере: ширина растёт пропорционально шрифту («сомони» задано в em)
function SummaItogo({ text }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.parentElement
    if (!el || !row) return undefined
    const fit = () => {
      el.style.setProperty('--ki-fit', '1')
      const label = row.firstElementChild !== el ? row.firstElementChild : null
      // 16 — зазор между подписью и суммой (как в стилях), ещё 8 — чтобы они не слипались
      const avail = row.clientWidth - (label ? label.getBoundingClientRect().width : 0) - 24
      // Ширина содержимого — по частям (число и «сомони»): сумма прижата к правому краю,
      // и лишнее вылезает влево, а такое переполнение scrollWidth не учитывает
      const parts = [...el.children]
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0
      const natural = parts.reduce((w, c) => w + c.getBoundingClientRect().width, 0) + gap * Math.max(0, parts.length - 1)
      const k = natural > 0 && natural > avail ? Math.max(0.5, avail / natural) : 1
      el.style.setProperty('--ki-fit', String(Math.floor(k * 100) / 100))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(fit)
    ro.observe(row)
    return () => ro.disconnect()
  }, [text])
  const i = text.lastIndexOf(' ')
  return (
    <span className="ki-sum" ref={ref}>
      {i > 0 ? <><b>{text.slice(0, i)}</b> <small>{text.slice(i + 1)}</small></> : <b>{text}</b>}
    </span>
  )
}

// ── Сумма в полосе внизу телефона: число крупно, «сомони» мельче, как в табло «Итого» ──
// Полоса узкая: длинная сумма целиком крупным шрифтом отнимала место у кнопки рядом,
// и «Провести продажу» ломалась на две строки
function SummaPolosa({ text }) {
  const i = text.lastIndexOf(' ')
  return <b>{i > 0 ? <>{text.slice(0, i)} <em className="kmb-cur">{text.slice(i + 1)}</em></> : text}</b>
}

// ── Незнакомый штрихкод у кассира ──
// Заводить карточку кассир не может: цену продажи и закупочную задаёт владелец.
// Но и бросать покупателя нельзя, поэтому здесь ровно одно действие — отложить код.
// Он попадёт в «Отложенные», и владелец оформит товар оттуда.
function UnknownBarcode({ barcode, onDefer, onClose }) {
  return (
    <Modal title={<><span className="ic"><LuClock size={18} /></span>{tr('Товара нет в базе')}</>} onClose={onClose}>
      <div className="note info" style={{ marginBottom: 16 }}>
        {tr('Штрихкод')}: <b>{barcode}</b>
      </div>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 18 }}>
        {tr('Отложите штрихкод — он попадёт в «Отложенные», и владелец заведёт карточку с ценой. Продать этот товар можно будет после этого.')}
      </p>
      {!onDefer && <div className="note err" style={{ marginBottom: 14 }}>{tr('Нет права откладывать штрихкоды — обратитесь к владельцу')}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{tr('Закрыть')}</button>
        {onDefer && (
          <button className="btn" onClick={onDefer}>
            <span className="ic"><LuClock size={16} /></span> {tr('Отложить штрихкод')}
          </button>
        )}
      </div>
    </Modal>
  )
}



// ── Чек ──
// Собирается один раз в общий вид (lib/ticket.js): то, что на экране, без изменений
// уходит на ленту, в окно печати и в PDF
function Receipt({ sale, onClose, onCancel }) {
  const auth = useAuth()
  const customers = useCollection('customers')
  const toast = useToast()
  // «Отмена»: сначала спрашиваем, потом отменяем. Пока отмена идёт — кнопки заняты
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  // Печать: чековый принтер программы, её экран печати или окно браузера (lib/pechat.js)
  const print = (tk) => pechatTicket(tk).catch((e) => toast(tr(e.message), 'err'))
  // После продажи в долг покупатель видит в чеке, сколько он теперь должен магазину
  const dolg = sale.payment === 'debt' ? (customers.find((c) => c.id === (sale.customer?.id || sale.customerId))?.debt ?? null) : null
  const ticket = saleTicket(sale, {
    t: tr,
    money,
    when: fmtDateTime,
    pharmacy: auth?.pharmacy?.name,
    cashier: auth?.name,
    rekvizity: getRekvizity(auth?.pharmacy?.code),
    nomer: chekNomer(sale.date),
    customerDebt: dolg,
  })
  // «Печатать чек сразу после продажи» — настройка чекового принтера. Печатается
  // записанная продажа: её номер — тот, что в отчётах (на кассе запись — доли секунды).
  // Записи всё нет — через 2,5 с печатается то, что есть, чтобы покупатель не ждал;
  // продажа не записалась вовсе — чек не печатается. Один раз на чек
  const ticketRef = useRef(ticket)
  ticketRef.current = ticket
  const printedFor = useRef('')
  // Чек уже ушёл на принтер сам («сразу после продажи») — «Готово» второй раз не печатает
  const autoPrinted = useRef('')
  // …и наоборот: «Готово» уже отправило чек — запоздавшая самопечать его не повторяет
  const gotovoPrinted = useRef('')
  const key = sale._key || sale.id
  useEffect(() => {
    if (sale._failed || printedFor.current === key) return undefined
    let alive = true
    const go = () => {
      if (!alive || printedFor.current === key) return
      printedFor.current = key
      autoPrint().then((on) => {
        if (!on || gotovoPrinted.current === key) return
        autoPrinted.current = key
        print(ticketRef.current)
      })
    }
    if (sale._stored) {
      go()
      return () => {
        alive = false
      }
    }
    const timer = setTimeout(go, 2500)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sale._stored, sale._failed])
  return (
    <Modal title={<><span className="ic"><LuPrinter size={18} /></span>{tr('Чек продажи')}</>} onClose={busy ? () => {} : onClose}>
      <TicketView ticket={ticket} />
      {/* На бумагу — этот же чек, из печатного слоя */}
      <PrintDoc prio={2} kind="ticket" title={tr('Чек продажи')}><TicketView ticket={ticket} /></PrintDoc>
      {confirm ? (
        <div className="otmena-confirm" data-testid="otmena-confirm">
          <div className="note err" style={{ marginTop: 14 }}>
            <b>{tr('Отменить продажу на')} {money(sale.total)}?</b>
            <div style={{ marginTop: 4 }}>
              {tr('Товар вернётся на склад')}, {otmenaDengi(sale)}. {tr('Товары снова окажутся в корзине — можно поправить и провести заново.')}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>{tr('Назад')}</button>
            <button
              className="btn danger"
              data-testid="otmena-yes"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                Promise.resolve(onCancel())
                  .catch((e) => toast(tr(e?.message || 'Не получилось. Повторите.'), 'err'))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? tr('Отменяем…') : tr('Отменить продажу')}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions">
          {onCancel && !sale._failed && (
            <button className="btn ghost" data-testid="otmena" onClick={() => setConfirm(true)} title={tr('Отменить продажу и вернуть товары в корзину')}>
              <span className="ic"><LuUndo2 size={16} /></span> {tr('Отмена')}
            </button>
          )}
          {/* «Печать» — окно закрывается сразу, чек печатается без него (PrintKeeper.jsx):
              следующий покупатель не ждёт, пока принтер допечатает */}
          <button
            className="btn ghost"
            data-testid="chek-print"
            onClick={() => {
              onClose()
              pechatBezOkna(ticket, tr('Чек продажи')).catch((e) => toast(tr(e?.message || 'Не удалось отправить задание на принтер.'), 'err'))
            }}
          >
            <span className="ic"><LuPrinter size={16} /></span> {tr('Печать')}
          </button>
          {/* «Готово»: с галочкой «Печатать чек при нажатии „Готово“» (Настройки → Чек и печать)
              окно закрывается и чек печатается, как по «Печать». Не записанная продажа
              и уже напечатанный сам чек второй раз не печатаются */}
          <button
            className="btn"
            data-testid="chek-gotovo"
            onClick={() => {
              const pechat = pechatPoGotovo() && !sale._failed && autoPrinted.current !== key
              if (pechat) gotovoPrinted.current = key
              onClose()
              if (pechat) pechatBezOkna(ticket, tr('Чек продажи')).catch((e) => toast(tr(e?.message || 'Не удалось отправить задание на принтер.'), 'err'))
            }}
          >
            {tr('Готово')}
          </button>
        </div>
      )}
    </Modal>
  )
}

// Куда вернутся деньги при отмене — тем же способом, каким платили
function otmenaDengi(sale) {
  if (sale.payment === 'card') return tr('деньги — обратно на карту')
  if (sale.payment === 'transfer') return tr('деньги — обратно переводом') + (sale.payVia ? ` (${sale.payVia})` : '')
  if (sale.payment === 'debt') return tr('долг клиента уменьшится')
  return tr('деньги — покупателю наличными из кассы')
}
