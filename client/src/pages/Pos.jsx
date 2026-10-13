import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue, lazy, Suspense } from 'react'
import {
  LuCamera, LuShoppingCart, LuPlus, LuMinus, LuTrash2, LuCheck, LuPrinter, LuScanLine, LuPackagePlus, LuClock,
  LuTriangleAlert, LuX,
} from 'react-icons/lu'
import Layout from '../components/Layout'
import { Modal, useToast, useDialog, PAYMENTS } from '../components/ui'
// Сканер камеры тянет за собой тяжёлую библиотеку распознавания (~400 КБ).
// Грузим её только при нажатии «Камера», иначе она замедляла открытие Кассы каждый раз.
const CameraScanner = lazy(() => import('../components/CameraScanner'))
import KassaCatalog, { LIMIT } from '../components/KassaCatalog'
import Lightbox from '../components/Lightbox'
import { useCollection, useFirstLoading, money, db, stockText, realId } from '../db/store'
import { useAuth, useCan } from '../db/auth'
import { isVesovoy, kgText, KG, gramsOfKg,
  uppOf, isDivisible as isDiv, lineUnits, lineGross, lineNet,
  sellableUnits, expiredUnits, hasExpired, stockUnits,
  fitLine,
} from '../lib/units'
import {
  MAX_CHEKOV, klyuch, chitat, pisat, razobrat, novyChek, svobodnyNomer,
  osvezhit, sdacha, kupyury, pohozheNaKod, estBukva,
} from '../lib/cheki'
import { findByBarcode, checkout } from '../db/ops'
import ProductForm, { emptyProduct, productPayload } from '../components/ProductForm'
import { beepOk, beepError, unlockAudio } from '../lib/sound'
import { fmtDateTime, chekNomer } from '../lib/time'
import { normalizeScan } from '../lib/scan'
import { parseVesEtiketku, productPoVesKodu } from '../lib/vesy'
import { useT, translate as tr } from '../lib/i18n'
import { blockUpdate } from '../lib/version'
import { sellsBelowCost } from '../lib/pricing'
import { saleTicket } from '../lib/ticket'
import { autoPrint } from '../lib/print'
import TicketView from '../components/TicketView'
import { usePechat } from '../components/PrintDialog'
import { getRekvizity } from '../lib/rekvizity'
import { useCategories, categoryNames } from '../lib/categories'
import NumberInput from '../components/NumberInput'

// ── Хелперы штучной продажи ──
// Сама арифметика упаковок и штук живёт в lib/units — одна на всю программу.
// Доступно к продаже только ГОДНОЕ: просроченные партии лежат на складе,
// но покупателю не уходят, поэтому касса считает остаток без них.
const availUnits = (p) => sellableUnits(p)
// ── Строка чека: числа обязаны сходиться ──
// Покупатель умножает то, что видит. Раньше в строке стояло количество упаковок,
// а рядом цена ОДНОЙ ШТУКИ: «1 уп × 7,5 сомони», итог 150. Для товара, который
// делится на двадцать таблеток, это выглядело как ошибка кассы — и объяснить
// её у прилавка было нечем.
//
// Поэтому показываем то, что перемножается: целые упаковки — по цене упаковки,
// всё остальное — в штуках по цене штуки.

// «Все категории» — отдельное значение, а не слово «Все»: иначе категория,
// которую владелец сам назвал «Все», стала бы неотличима от сброса фильтра
const VSE = '\u0000vse'
// Ниже этой ширины чек и каталог рядом не помещаются — там переключатель.
// Число то же, что в стилях кассы (index.css) и в туре (lib/tur.js): разойдутся —
// и касса будет считать экран широким, пока на нём показан переключатель
const UZKO = '(max-width: 1279px)'
// Один сравниватель на всю кассу. localeCompare с указанием языка заводит его заново
// на каждое сравнение, а каталог в настоящей аптеке — это тысячи названий
const poAlfavitu = new Intl.Collator('ru').compare

export default function Pos() {
  const products = useCollection('products')
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
  const canSell = auth?.subscription ? auth.subscription.canWrite : true
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const phCode = auth?.pharmacy?.code || ''

  // ── Открытые чеки ──
  // Чек больше не живёт в памяти страницы: он хранится на устройстве и переживает
  // уход в другой раздел и перезагрузку. Состояние помнит, чьей аптеки эти чеки, —
  // чтобы при смене аптеки в том же браузере не записать чужие под новый ключ.
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
  const [selId, setSelId] = useState(null) // выбранная строка чека — с ней работают клавиши
  const [cat, setCat] = useState(VSE)
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
  const focusScanner = useCallback(() => inputRef.current?.focus(), [])
  useEffect(() => {
    if (camera || newProduct || receipt || analogFor) return
    const el = document.activeElement
    const typingElsewhere =
      el && el !== inputRef.current &&
      (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    if (!typingElsewhere) focusScanner()
  }, [cart, receipt, camera, newProduct, analogFor, focusScanner])

  // ── Защита числовых полей от «выстрела» сканера ──
  // Кассир мог поправить количество и, не нажав Enter, взяться за сканер. Тогда штрихкод
  // печатается в поле числа. Слои защиты: Enter/Tab, откат по длине и «глушение»
  // остатка выстрела.
  //
  // Возврата фокуса «по паузе» здесь больше НЕТ намеренно: раньше стоял таймер на
  // 1,5 с, и у кассира, который задумался над количеством, курсор вырывало на сканер —
  // следующие цифры улетали в поиск. Пока человек в поле, курсор его. Выстрел сканера
  // в поле числа и без таймера ловится ниже — по скорости набора и длине кода.

  // 1) Enter/Tab — сразу возвращаем фокус на сканер.

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
      focusScanner()
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
  // а дальше кассир правит его в строке. Хранится граммами в «штуках» строки.
  const addWeight = useCallback(
    (p, grams) => {
      const avail = availUnits(p)
      const ex = cartRef.current.find((i) => i.productId === p.id)
      const used = ex ? lineUnits(ex) : 0
      if (avail <= used || avail <= 0) {
        toast(`${t('Максимум на складе')}: ${kgText(avail)} ${t('кг')}`, 'err')
        return false
      }
      const add = Math.min(Math.max(1, Math.trunc(grams) || 0), avail - used)
      if (add < grams) toast(`${t('Максимум на складе')}: ${kgText(avail)} ${t('кг')}`, 'err')
      setCart((c) => {
        const e = c.find((i) => i.productId === p.id)
        if (e) return c.map((i) => (i.productId === p.id ? { ...i, qty: 0, pieces: lineUnits(i) + add } : i))
        return [
          ...c,
          {
            productId: p.id, name: p.name, price: p.price, cost: p.cost,
            unitsPerPack: uppOf(p), unit: p.unit, stock: p.stock, looseUnits: p.looseUnits,
            qty: 0, pieces: add, discount: 0,
          },
        ]
      })
      setSelId(p.id)
      return true
    },
    [toast, setCart, t],
  )

  // Возвращает true, если товар реально добавлен в корзину (false — нет на складе / лимит)
  const addProduct = useCallback(
    (p) => {
      // Весовой добавляется килограммом, а не «упаковкой»
      if (isVesovoy(p)) return addWeight(p, KG)
      const upp = uppOf(p)
      const avail = availUnits(p)
      if (avail <= 0) {
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
        toast(`«${p.name}»: ${expiredUnits(p)} ${t('шт просрочено — уберите с полки')}`, 'err')
      }
      const ex = cartRef.current.find((i) => i.productId === p.id)
      const used = ex ? ex.qty * upp + (ex.pieces || 0) : 0
      if (used >= avail) {
        toast(`${t('Максимум на складе')}: ${avail} ${t('шт')}`, 'err')
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
                : { ...i, pieces: (i.pieces || 0) + 1 }
              : i,
          )
        }
        return [
          ...c,
          {
            productId: p.id, name: p.name, price: p.price, cost: p.cost,
            unitsPerPack: upp, unit: p.unit, stock: p.stock, looseUnits: p.looseUnits,
            qty: addPack ? 1 : 0, pieces: addPack ? 0 : 1, discount: 0,
          },
        ]
      })
      // Только что добавленная строка становится выбранной: клавиши «+», «−»,
      // F2 и F4 относятся к тому, что кассир пробил последним
      setSelId(p.id)
      return true
    },
    [toast, products, setCart, t, addWeight],
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
          toast(`${wp.name}: ${kgText(ves.grams)} ${t('кг')} ${t('добавлен в корзину')}`)
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

  const sorted = useMemo(() => [...products].sort((a, b) => poAlfavitu(a.name, b.name)), [products])
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
        // другие формы того же лекарства, и искать их заново кассиру незачем
        beepError()
      }
      focusScanner()
    },
    [addProduct, toast, t, focusScanner],
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
  // или выбрали стрелкой, не должна остаться за краем
  const selLine = sel?.productId
  useEffect(() => {
    if (!selLine) return
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

    // Свои короткие коды (четыре-пять цифр) аптеки тоже заводят. Если такого кода
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
    if (!form.category.trim()) return toast(t('Выберите категорию'), 'err')
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
      // а кассиру нужны три таблетки из неё: штук на складе хватает, места не хватает
      // только из-за упаковки. Раньше он видел просто «максимум 5 шт» и не понимал,
      // что делать, — а сделать было и правда нечего.
      toast(
        isVesovoy(item)
          ? `${t('Максимум на складе')}: ${kgText(avail)} ${t('кг')}`
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
        const gross = (i.price / upp) * (qty * upp + pieces)
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
  const vesValue = (i) => (vesDraft?.id === i.productId ? vesDraft.val : String(lineUnits(i) / KG || ''))
  const changeVes = (id, val) => {
    setVesDraft({ id, val })
    applyLine(id, 0, gramsOfKg(val))
  }

  const changeQty = (id, delta) => {
    const it = cart.find((i) => i.productId === id)
    if (!it) return
    // Весовому «упаковкой больше/меньше» означает ±1 кг
    if (isVesovoy(it)) return applyLine(id, 0, Math.max(0, lineUnits(it) + delta * KG))
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

  const remove = (id) => setCart((c) => c.filter((i) => i.productId !== id))
  // «Очистить корзину» — покупатель передумал. Сам чек остаётся открытым, пустым
  const ochistit = () => {
    patch({ cart: [], received: '' })
    setIzm(null)
    focusScanner()
  }
  const total = cart.reduce((s, i) => s + lineNet(i), 0)
  const discountTotal = cart.reduce((s, i) => s + Math.min(i.discount || 0, lineGross(i)), 0)
  // Весовые позиции в сводке — килограммами, остальные — упаковками и штуками
  const obychnye = cart.filter((i) => !isVesovoy(i))
  const packsCount = obychnye.reduce((s, i) => s + i.qty, 0)
  const piecesCount = obychnye.reduce((s, i) => s + (i.pieces || 0), 0)
  const vesCount = cart.filter(isVesovoy).reduce((s, i) => s + lineUnits(i), 0)
  const countText = [
    packsCount || !cart.length || obychnye.length ? `${packsCount} ${t('уп')}` : '',
    piecesCount ? `${piecesCount} ${t('шт')}` : '',
    vesCount ? `${kgText(vesCount)} ${t('кг')}` : '',
  ]
    .filter(Boolean)
    .join(' + ') || `0 ${t('уп')}`
  // Сдача считается только для наличных: картой и в долг «получено» не бывает
  const sd = payment === 'cash' ? sdacha(total, received) : { state: 'none', diff: 0, received: null }
  const bills = payment === 'cash' ? kupyury(total) : []

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
                ? `«${n.name}»: ${t('на складе осталось')} ${n.avail} ${t('шт')} — ${t('количество уменьшено')}`
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
      focusScanner()
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
      toast(auth?.subscription?.message || t('Продажи закрыты: подписка не оплачена'), 'err')
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
    try {
      // Чек печатаем сразу по локальной записи — покупатель не ждёт ответа сервера,
      // запись уходит в фоне (цифры в чеке те же, что уйдут на сервер).
      const { sale, synced } = checkout({
        items: items.map((i) => ({
          productId: i.productId, name: i.name, qty: i.qty, pieces: i.pieces || 0,
          price: i.price, cost: i.cost, unitsPerPack: uppOf(i), unit: i.unit || '', discount: i.discount,
        })),
        payment,
        payVia: via,
        customer,
      })
      // «Получено» и «Сдача» — только для бумажного чека. На сервер они не уходят:
      // на деньги смены сдача не влияет, в кассе остаётся ровно сумма чека
      setReceipt({ ...sale, received: sd.state === 'ok' ? sd.received : null, change: sd.state === 'ok' ? sd.diff : 0 })
      // Чек продан — вкладка остаётся пустой и готовой к следующему покупателю
      patch({ cart: [], payment: 'cash', customerId: '', received: '', payVia: '' })
      setIzm(null)
      pokazat('check')
      toast(t('Продажа проведена'))

      // Деньги нельзя терять молча: если запись так и не прошла — возвращаем корзину
      synced.catch((e) => {
        setFailedSale({ message: e.message, cart: soldCart, payment, payVia: via, customerId })
        beepError()
      })
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setPaying(false)
    }
  }

  // Продажа не записалась — возвращаем её чеком. Если кассир уже начал следующего
  // покупателя, не смешиваем их: несостоявшаяся продажа встаёт отдельной вкладкой
  function vernutProdazhu() {
    const data = {
      cart: failedSale.cart, payment: failedSale.payment, payVia: failedSale.payVia || '',
      customerId: failedSale.customerId || '', received: '',
    }
    setCheki((s) => {
      const cur = s.list.find((c) => c.id === s.active)
      if (cur && !cur.cart.length) {
        return { ...s, list: s.list.map((c) => (c.id === cur.id ? { ...c, ...data } : c)) }
      }
      const c = { ...novyChek(svobodnyNomer(s.list)), ...data }
      return { ...s, list: [...s.list, c].sort((a, b) => a.n - b.n), active: c.id }
    })
    setFailedSale(null)
    setReceipt(null)
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
      setCustomerId(c.id)
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

  // F9 — к оплате. Наличными: курсор встаёт в «Получено», Enter там проводит
  // продажу. Картой и в долг получать нечего — продажа проводится сразу.
  function kOplate() {
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
  const keys = useRef({})
  keys.current = { novyyChek, kOplate, focusCell, moveSel, changeSel, removeSel, focusScanner }
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return
      // Открыто окно (чек, камера, карточка товара, подтверждение) или идёт тур —
      // клавиши принадлежат им, а не кассе
      if (document.querySelector('.overlay, .tur-root')) return
      const k = keys.current
      if (e.key === 'F2') { e.preventDefault(); k.focusCell('inp-discount'); return }
      if (e.key === 'F4') { e.preventDefault(); k.focusCell('inp-pieces', 'inp-ves'); return }
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
      <div className={'kassa pane-' + pane}>
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
                    autoFocus
                  />
                </div>
                <button className="btn ghost" data-tour="pos.camera" title={t('Камера')} aria-label={t('Камера')} onClick={() => { unlockAudio(); setCamera(true) }}>
                  <span className="ic"><LuCamera size={17} /></span> <span className="cam-text">{t('Камера')}</span>
                </button>
              </div>
            </div>
            <div className="scan-hint">
              <span className="ic"><LuScanLine size={15} /></span>
              {t('USB-сканер работает как клавиатура · для деления на таблетки укажите «штук в упаковке» в карточке товара')}
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
            {cats.length > 0 && (
              <div className="chips kc-cats" data-tour="pos.cats">
                <button className={'chip ' + (cat === VSE ? 'active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => setCat(VSE)}>{t('Все')}</button>
                {cats.map((c) => (
                  <button key={c} className={'chip ' + (cat === c ? 'active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => setCat(c)}>{t(c)}</button>
                ))}
              </div>
            )}
            <KassaCatalog
              onFoto={setFoto}
              rows={shown}
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
                            {isVesovoy(i) ? ` / ${t('кг')}` : isDiv(i) && ` · ${money(i.price / uppOf(i))}/${t('шт')}`}
                            {/* На телефоне колонки «В уп.» нет — число переезжает сюда */}
                            {!isVesovoy(i) && isDiv(i) && <span className="kt-upp-m"> · {t('в уп.')} {uppOf(i)}</span>}
                          </div>
                        </td>
                        <td className="num kt-upp">{isVesovoy(i) ? <span className="tag-cat">{t('кг')}</span> : isDiv(i) ? uppOf(i) : <span className="tag-cat">—</span>}</td>
                        {/* data-label — подпись поля на телефоне: заголовка таблицы там нет */}
                        <td className="kt-qty" data-label={isVesovoy(i) ? t('Вес, кг') : t('Упаковок')}>
                          {isVesovoy(i) ? (
                            <NumberInput
                              className="disc-input inp-ves"
                              value={vesValue(i)}
                              onChange={(e) => changeVes(i.productId, e.target.value)}
                              onKeyDown={(e) => onCellKey(e, i.productId)}
                              onFocus={() => { snapLine(i.productId); setVesDraft({ id: i.productId, val: String(lineUnits(i) / KG || '') }) }}
                              onBlur={() => setVesDraft(null)}
                              placeholder="0.000"
                              title={t('Вес в килограммах, до грамма')}
                              aria-label={t('Вес, кг')}
                            />
                          ) : (
                            <div className="qty-ctrl" data-tour="pos.qty">
                              <button onClick={() => changeQty(i.productId, -1)} aria-label={t('Упаковкой меньше')}><LuMinus size={14} /></button>
                              <b>{i.qty}</b>
                              <button onClick={() => changeQty(i.productId, 1)} aria-label={t('Упаковкой больше')}><LuPlus size={14} /></button>
                            </div>
                          )}
                        </td>
                        <td className="kt-pcs" data-label={t('Штук')} data-tour="pos.pieces">
                          {isVesovoy(i) ? (
                            <span className="tag-cat">—</span>
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
                        <td className="kt-disc" data-label={t('Скидка')} data-tour="pos.discount">
                          {can('pos.discount') ? (
                            <NumberInput
                              className="disc-input inp-discount"
                              integer
                              value={i.discount || ''}
                              onChange={(e) => setDiscount(i.productId, e.target.value)}
                              onKeyDown={(e) => onCellKey(e, i.productId)}
                              onFocus={() => snapLine(i.productId)}
                              placeholder="0"
                              title={t('Скидка на позицию, сомони')}
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
              <span><kbd className="kbd">F4</kbd> {t('штуки')}</span>
            </div>
          </div>

          <div className="cart-panel">
            {/* Итог виден издалека — и кассиру, и покупателю */}
            <div className="kassa-itogo" data-tour="pos.total">
              <div className="total-row"><span>{t('Сумма')}</span><span>{money(total + discountTotal)}</span></div>
              <div className="total-row"><span>{t('Скидка')}</span><span>{discountTotal > 0 ? '−' : ''}{money(discountTotal)}</span></div>
              <div className="total-row"><span>{t('Товаров')}</span><span>{cart.length ? countText : '0'}</span></div>
              <div className="total-row big"><span>{t('Итого')}</span><span>{money(total)}</span></div>
            </div>

            <div className="kassa-oplata">
              <div className="pay-methods" data-tour="pos.pay-methods">
                {Object.entries(PAYMENTS).filter(([key]) => key !== 'debt' || can('pos.debt')).map(([key, m]) => (
                  <button key={key} className={payment === key ? 'active' : ''} onClick={() => { setPayment(key); focusScanner() }}>
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
                          onClick={() => { setPayVia(s.name); focusScanner() }}
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
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                      <option value="">{t('— выберите —')}</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} {c.debt ? `(${t('долг')} ${money(c.debt)})` : ''}</option>
                      ))}
                    </select>
                    {can('customers.create') && <button className="btn ghost icon" onClick={addCustomer} aria-label={t('Новый клиент')}><LuPlus size={17} /></button>}
                  </div>
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
                      {/* Одно нажатие вместо набора суммы: покупатель дал купюру — нажали её */}
                      <button onClick={() => { setReceived(String(Math.round(total * 100) / 100)); receivedRef.current?.focus() }}>{t('Без сдачи')}</button>
                      {bills.map((b) => (
                        <button key={b} onClick={() => { setReceived(String(b)); receivedRef.current?.focus() }}>{b}</button>
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
                disabled={!cart.length || paying || !canSell || sd.state === 'short'}
                onClick={pay}
                title={canSell ? undefined : auth?.subscription?.message || ''}
              >
                <span className="ic"><LuCheck size={18} /></span> {paying ? t('Проведение…') : t('Провести продажу')} <kbd className="kbd">F9</kbd>
              </button>
            </div>
            {!canSell && (
              <div className="note err kassa-stop">
                {t('Продажи закрыты: подписка не оплачена. Товары и отчёты открыты, копию базы скачать можно.')}
              </div>
            )}
          </div>
        </div>
      </div>

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
          <table>
            <tbody>
              {analogFor.analogs.map((a) => (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => { addProduct(a); setAnalogFor(null) }}>
                  <td><b>{a.name}</b>{a.dosage ? <div className="tag-cat">{a.dosage}</div> : null}</td>
                  <td className="num">{money(a.price)}</td>
                  <td className="num"><span className="badge ok">{stockText(a)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-actions"><button className="btn ghost" onClick={() => setAnalogFor(null)}>{t('Закрыть')}</button></div>
        </Modal>
      )}
      {failedSale && (
        <Modal
          title={<><span className="ic" style={{ color: 'var(--danger)' }}><LuTriangleAlert size={18} /></span>{t('Продажа не записана')}</>}
          onClose={() => setFailedSale(null)}
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
      {receipt && <Receipt sale={receipt} onClose={() => setReceipt(null)} />}
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
          <QuickAdd
            barcode={newProduct.barcode}
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

// ── Быстрое добавление незнакомого товара ──
function QuickAdd({ barcode, onSave, onDefer, onClose }) {
  // Та же форма, что в разделе «Товары», — буквально тот же компонент.
  // Прежде здесь была своя, укороченная: без дозировки, срока годности,
  // минимального остатка, вскрытых штук и аналогов. Владелец заводил товар
  // с кассы и половину карточки не заполнял, потому что не знал, что она есть.
  const [f, setF] = useState({ ...emptyProduct, barcode, stock: '1', minStock: '5' })
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (saving) return
    setSaving(true)
    try {
      await onSave(f)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuPackagePlus size={18} /></span>{tr('Новый товар по штрихкоду')}</>} onClose={onClose}>
      <div className="note info" style={{ marginBottom: 14 }}>
        {tr('Штрихкод')}: <b>{barcode}</b> — {tr('товара нет в базе. Заполните карточку (добавится в корзину) или нажмите «Добавить позже» — штрихкод уйдёт в «Отложенные».')}
      </div>

      {/* ── Курсор встаёт в штрихкод, а не в название ──
          Сканер уже вписал код, но верить ему до конца нельзя: помятая упаковка,
          блик, чужая наклейка — и в поле окажется не то. Поэтому кассир видит код
          там, где его можно тут же переснять или поправить. Код при этом выделен
          целиком: повторный скан заменит его, а не допишет в конец. Если код верный,
          поле просто не трогают — Enter уводит в название. */}
      <ProductForm value={f} onChange={setF} autoFocus="barcode" />

      {/* ── Кнопки остаются кассовыми ──
          «Сохранить», как в «Товарах», завела бы товар, но не положила его
          в корзину: кассиру пришлось бы сканировать заново, а покупатель ждёт.
          И отложить незнакомый штрихкод было бы нечем. */}
      <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
        {onDefer ? (
          <button className="btn ghost" onClick={onDefer} disabled={saving} title={tr('Отложить штрихкод')}>
            <span className="ic"><LuClock size={16} /></span> {tr('Добавить позже')}
          </button>
        ) : <span />}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>{tr('Отмена')}</button>
          <button className="btn" onClick={submit} disabled={saving}>{saving ? tr('Сохранение…') : tr('Добавить и в корзину')}</button>
        </div>
      </div>
    </Modal>
  )
}


// ── Чек ──
// Собирается один раз в общий вид (lib/ticket.js): то, что на экране, без изменений
// уходит на ленту, в окно печати и в PDF
function Receipt({ sale, onClose }) {
  const auth = useAuth()
  const customers = useCollection('customers')
  const { print, dialog } = usePechat()
  // После продажи в долг покупатель видит в чеке, сколько он теперь должен аптеке
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
  // «Печатать чек сразу после продажи» — настройка чекового принтера
  useEffect(() => {
    let alive = true
    autoPrint().then((on) => on && alive && print(ticket))
    return () => {
      alive = false
    }
    // Один раз на чек: печатается то, что продано, а не то, что перерисовалось
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.id])
  return (
    <Modal className="printable" title={<><span className="ic"><LuPrinter size={18} /></span>{tr('Чек продажи')}</>} onClose={onClose}>
      <TicketView ticket={ticket} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={() => print(ticket)}><span className="ic"><LuPrinter size={16} /></span> {tr('Печать')}</button>
        <button className="btn" onClick={onClose}>{tr('Готово')}</button>
      </div>
      {dialog}
    </Modal>
  )
}
