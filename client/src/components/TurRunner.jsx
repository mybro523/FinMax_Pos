import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { LuGraduationCap, LuX, LuArrowLeft, LuArrowRight } from 'react-icons/lu'
import { NAV } from './Layout'
import { useAuth } from '../db/auth'
import { useT, useLang } from '../lib/i18n'
import { OBUCHENIE_TG } from '../lib/obuchenie-tg'
import { stepsFor } from '../lib/tury'
import {
  OBSHIY, stopTour, setTourIndex, markTourDone, zapomnitObuchenie, setTourMenu, setTourPane, sredaTura,
} from '../lib/tur'

// ── Тур поверх настоящей программы ──
//
// Нужный элемент подсвечивается рамкой, остальное затемнено, рядом карточка с
// объяснением. Подсвечивается не картинка, а живая кнопка на странице: человек
// видит ровно то место, куда потом будет нажимать сам.
//
// Правила, на которых всё держится:
//   • тур никогда ничего не сохраняет и не проводит. Формы он открывает и закрывает,
//     а «Провести продажу», «Оприходовать», «Удалить» только показывает;
//   • пока тур идёт, по странице нажать нельзя и набрать ничего нельзя — иначе
//     случайное нажатие добавило бы товар в корзину или открыло чужое окно;
//   • элемента нет на экране (корзина пуста, приходов ещё не было) — шаг встаёт по
//     центру и объясняет, когда он появится. Тур не зависает и не пропускает шаг молча.

const PAD = 6 // отступ рамки от элемента
const GAP = 14 // зазор между рамкой и карточкой
const MARGIN = 12 // карточка не подходит к краю экрана ближе этого

const narrowQuery = '(max-width: 600px)'
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(narrowQuery)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  )
}

// Метка «grp:…» — группа элементов (пункты одного раздела меню), остальные — один
// элемент или несколько с одинаковой меткой, например два поля цены рядом
function find(key) {
  if (!key) return []
  const sel = key.startsWith('grp:')
    ? `[data-tour-grp="${CSS.escape(key.slice(4))}"]`
    : `[data-tour="${CSS.escape(key)}"]`
  return [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect()
    return el.isConnected && (r.width > 0 || r.height > 0)
  })
}

function unionRect(els) {
  const live = els.filter((el) => el.isConnected)
  if (!live.length) return null
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity
  for (const el of live) {
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    top = Math.min(top, r.top)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  if (top === Infinity) return null
  return { top, left, width: right - left, height: bottom - top, right, bottom }
}

const sameRect = (a, b) =>
  a === b ||
  (!!a && !!b &&
    Math.round(a.top) === Math.round(b.top) && Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Ждём, пока элемент появится: страница после перехода дорисовывается, форма
// открывается с анимацией, меню выезжает
async function waitFor(key, ms) {
  const until = Date.now() + ms
  let els = find(key)
  while (!els.length && Date.now() < until) {
    await wait(60)
    els = find(key)
  }
  return els
}

const countOverlays = () => document.querySelectorAll('.overlay').length

// Закрываем только то, что открыл сам тур. Окна программы закрываются по Escape —
// им и пользуемся, но пометив, что это тур, иначе тур сам поймал бы свою клавишу
async function closeFormsOpenedByTour(baseRef) {
  if (baseRef.current === null) return
  for (let i = 0; i < 5 && countOverlays() > baseRef.current; i++) {
    window.__turClosing = true
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.__turClosing = false
    await wait(80)
  }
  baseRef.current = null
}

export default function TurRunner({ id, index }) {
  const t = useT()
  const lang = useLang()
  const narrow = useNarrow()
  const user = useAuth()

  const navigate = useNavigate()
  const location = useLocation()

  // Устройство определяем один раз, на старте тура: если мерить на каждом шаге,
  // поворот телефона посреди тура сдвинул бы шаги под ногами у человека
  const steps = useMemo(() => stepsFor(id, user, sredaTura()), [id, user])
  const step = steps[index]
  const last = index === steps.length - 1

  // Текст шага: сначала словарь уроков, потом общий словарь интерфейса
  const tu = (s) => (lang === 'tg' ? OBUCHENIE_TG[s] ?? t(s) : s)

  const [rect, setRect] = useState(null)
  const [missing, setMissing] = useState(false)
  const [ready, setReady] = useState(false)
  const [pos, setPos] = useState(null)
  const targetsRef = useRef([])
  const baseOverlays = useRef(null)
  const cardRef = useRef(null)

  // ── Шагов нет — тура нет ──
  useEffect(() => {
    if (!steps.length) stopTour()
  }, [steps.length])

  // ── Фокус уводим со страницы: иначе клавиши попадали бы в поле сканера ──
  useEffect(() => {
    document.activeElement?.blur?.()
  }, [])

  // ── На телефоне странице нужен запас снизу ──
  // Карточка тура стоит внизу и закрывает собой нижнюю половину экрана. Элемент
  // в самом конце раздела — итог, кнопку оплаты — поднять над ней было нечем:
  // страница кончалась, и карточка ложилась прямо на то, о чём рассказывала.
  // На время тура удлиняем страницу — тогда наверх прокручивается любой элемент.
  useEffect(() => {
    if (!narrow) return
    document.documentElement.classList.add('tur-uzko')
    return () => document.documentElement.classList.remove('tur-uzko')
  }, [narrow])

  async function finish(completed) {
    await closeFormsOpenedByTour(baseOverlays)
    setTourMenu(false)
    // Касса после тура должна остаться такой, какой её открывают: с чеком
    setTourPane('check')
    if (completed) markTourDone(id)
    // Общий тур выскакивает сам только при первом входе. Закрыл, пропустил или
    // прошёл — больше не выскакивает: снова его запускают из «Обучения»
    if (id === OBSHIY) zapomnitObuchenie()
    stopTour()
  }

  const next = () => (last ? finish(true) : setTourIndex(index + 1))
  const back = () => index > 0 && setTourIndex(index - 1)
  const close = () => finish(false)

  // ── Клавиатура ──
  // Ловим раньше всех остальных обработчиков (на окне, в фазе захвата) и не
  // отдаём дальше: Escape закрыл бы форму под туром, а буквы ушли бы в сканер
  const keys = useRef({})
  keys.current = { next, back, close }
  useEffect(() => {
    const onKey = (e) => {
      if (window.__turClosing) return
      e.stopPropagation()
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        keys.current.next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        keys.current.back()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        keys.current.close()
      } else if (e.key !== 'Tab') {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ── Переход на страницу раздела ──
  useEffect(() => {
    if (step?.to && location.pathname !== step.to) navigate(step.to)
  }, [step, location.pathname, navigate])

  // ── Найти элемент шага ──
  useEffect(() => {
    if (!step) return
    if (step.to && location.pathname !== step.to) return // сначала дождёмся перехода
    let cancelled = false
    setReady(false)
    // Сразу забываем элемент прошлого шага. Иначе, пока ищется новый (до полутора
    // секунд, если его нет на экране), рамка ещё стояла бы на старой кнопке, а
    // карточка уже говорила бы про новую — и человек смотрел бы не туда
    targetsRef.current = []
    setRect(null)
    setMissing(false)

    ;(async () => {
      // Меню на телефоне открываем только для шагов про меню
      const mobileMenu = window.matchMedia('(max-width: 860px)').matches
      setTourMenu(!!(step.menu && mobileMenu))
      // Касса на узком экране показывает либо чек, либо каталог — просим нужное
      if (step.pane) setTourPane(step.pane)

      // Шаг не про форму — закрываем форму, открытую туром на прошлых шагах
      if (!step.open) await closeFormsOpenedByTour(baseOverlays)

      let els = []
      if (step.t) {
        els = find(step.t)
        if (!els.length && step.open) {
          // Элемент живёт в форме — открываем её той же кнопкой, что нажал бы человек.
          // Бывает цепочка: вкладка, а в ней своя вкладка («Новое поступление» →
          // «Сохранить поступление»). Жмём по порядку, пока элемент не покажется
          const openers = [].concat(step.open)
          for (let n = 0; n < openers.length && !els.length; n++) {
            const opener = find(openers[n])[0]
            if (opener && !opener.disabled) {
              if (baseOverlays.current === null) baseOverlays.current = countOverlays()
              opener.click()
            }
            els = await waitFor(step.t, n === openers.length - 1 ? 2500 : 700)
          }
        } else if (!els.length) {
          els = await waitFor(step.t, step.menu ? 900 : 1500)
        }
      }
      if (cancelled) return

      targetsRef.current = els
      setMissing(!!step.t && !els.length)
      if (els.length) {
        // На телефоне карточка стоит снизу — элемент поднимаем повыше, чтобы не прятался под ней
        els[0].scrollIntoView({ block: narrow ? 'start' : 'center', inline: 'nearest' })
        if (narrow) window.scrollBy(0, -80)
        setRect(unionRect(els))
      } else {
        setRect(null)
      }
      setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [step, location.pathname, narrow])

  // ── Следим за элементом: меню выезжает, форма открывается, страница прокручивается ──
  useEffect(() => {
    let raf
    const tick = () => {
      const els = targetsRef.current
      if (els.length) {
        const r = unionRect(els)
        setRect((prev) => (sameRect(prev, r) ? prev : r))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Где встать карточке ──
  // Под элементом, если помещается; иначе над ним; иначе справа или слева; иначе
  // внизу экрана. Карточка никогда не вылезает за край — её сначала меряем, потом ставим
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    if (narrow) {
      if (ready) setPos({ sheet: true })
      return
    }
    const w = window.innerWidth
    const h = window.innerHeight
    const cw = card.offsetWidth
    const ch = card.offsetHeight
    const clampX = (x) => Math.max(MARGIN, Math.min(x, w - cw - MARGIN))
    const clampY = (y) => Math.max(MARGIN, Math.min(y, h - ch - MARGIN))

    if (!ready) {
      // Элемент шага ещё ищется (до полутора секунд, если его нет на экране), а текст
      // в карточке уже новый — и бывает длиннее прежнего. Карточка остаётся, где
      // стояла, но за край экрана не вылезает: стоя у нижнего края, она на эти
      // полторы секунды уходила под него вместе с кнопкой «Дальше»
      setPos((prev) => {
        if (!prev || prev.sheet) return prev
        const p = { top: clampY(prev.top), left: clampX(prev.left) }
        return Math.round(p.top) === Math.round(prev.top) && Math.round(p.left) === Math.round(prev.left) ? prev : p
      })
      return
    }

    if (!rect) {
      setPos({ top: Math.max(MARGIN, (h - ch) / 2), left: Math.max(MARGIN, (w - cw) / 2) })
      return
    }
    const r = { top: rect.top - PAD, left: rect.left - PAD, bottom: rect.bottom + PAD, right: rect.right + PAD }
    let p
    if (r.bottom + GAP + ch <= h - MARGIN) p = { top: r.bottom + GAP, left: clampX(r.left) }
    else if (r.top - GAP - ch >= MARGIN) p = { top: r.top - GAP - ch, left: clampX(r.left) }
    else if (r.right + GAP + cw <= w - MARGIN) p = { top: clampY(r.top), left: r.right + GAP }
    else if (r.left - GAP - cw >= MARGIN) p = { top: clampY(r.top), left: r.left - GAP - cw }
    else p = { top: h - ch - MARGIN, left: clampX(r.left) }
    setPos((prev) => (prev && !prev.sheet && Math.round(prev.top) === Math.round(p.top) && Math.round(prev.left) === Math.round(p.left) ? prev : p))
  }, [rect, ready, narrow, index, lang, missing])

  if (!step) return null

  // Заголовок шага: у первого шага раздела это название самого раздела
  const раздел = NAV.find((n) => n.to === step.to)
  const title = step.intro ? t(раздел?.label || '') : tu(step.title || '')
  const kicker = id === OBSHIY ? t('Как устроена система') : `${t('Тур по разделу')} · ${t(раздел?.label || '')}`
  const List = step.numbered ? 'ol' : 'ul'

  const cardStyle = !pos
    ? { visibility: 'hidden', top: 0, left: 0 }
    : pos.sheet
      ? undefined
      : { top: pos.top, left: pos.left }

  return createPortal(
    <div className="tur-root" data-tour-step={index}>
      {/* Перехватывает нажатия по странице, пока идёт тур */}
      <div className="tur-block" onPointerDown={(e) => e.preventDefault()} />
      {rect ? (
        <div
          className="tur-spot"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tur-dim" />
      )}

      <div
        ref={cardRef}
        className={'tur-card' + (pos?.sheet ? ' tur-sheet' : '')}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="tur-head">
          <span className="ic"><LuGraduationCap size={16} /></span>
          <span className="tur-kicker">{kicker}</span>
          <span className="tur-count">{index + 1} / {steps.length}</span>
          <button className="tur-x" onClick={close} aria-label={t('Закрыть')} title={t('Закрыть')}>
            <LuX size={16} />
          </button>
        </div>

        <div className="tur-body">
          <h3>{title}</h3>
          {step.text && <p>{tu(step.text)}</p>}
          {step.list && (
            <List className={'tur-list' + (step.warn ? ' tur-list-warn' : '')}>
              {step.list.map((x) => <li key={x}>{tu(x)}</li>)}
            </List>
          )}
          {step.tip && <div className="tur-tip">{tu(step.tip)}</div>}
          {missing && (
            <div className="tur-tip tur-missing">
              {tu(step.missing || 'Сейчас этого на экране нет — появится, когда в разделе будут данные.')}
            </div>
          )}
        </div>

        <div className="tur-foot">
          {/* На телефоне три кнопки с подписями в ряд не влезают — там «Назад»
              остаётся одной стрелкой, подпись уходит в aria-label */}
          <button className="btn ghost" onClick={back} disabled={index === 0} aria-label={t('Назад')} title={t('Назад')}>
            <span className="ic"><LuArrowLeft size={16} /></span> <span className="tur-back-text">{t('Назад')}</span>
          </button>
          <div className="tur-foot-right">
            {!last && <button className="btn ghost" onClick={close}>{t('Пропустить')}</button>}
            <button className="btn" onClick={next} autoFocus>
              {last ? t('Готово') : <>{t('Дальше')} <span className="ic"><LuArrowRight size={16} /></span></>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
