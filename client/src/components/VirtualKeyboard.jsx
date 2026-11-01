import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayHost } from './ui'
import { LuDelete, LuCornerDownLeft, LuX, LuLanguages, LuArrowBigUp, LuEraser } from 'react-icons/lu'
import { useT } from '../lib/i18n'

// ── Экранная клавиатура ──
// У кассового места часто нет клавиатуры: сенсорный моноблок, сканер и всё. Набрать
// название товара, сумму «Получено», имя клиента или пароль на входе тогда нечем. Эта
// панель печатает в то поле, где стоит курсор, — в любом разделе, включая формы в окнах.
// Кнопка «Клавиатура» — в полосе внизу каждого раздела и в углу экрана входа.
//
// Клавиатура лежит ПОВЕРХ страницы и ничего не сдвигает: касса не сжимается, корзина
// остаётся на месте (так попросил владелец, 1.5.5) — низ кассы с оплатой, пока клавиатура
// открыта, под ней; закрыли — всё на виду. Открытое окно (форма, вопрос) поднимается, только
// если клавиатура закрыла бы его низ, — ровно настолько, чтобы он встал над ней. Поле длинной
// страницы, на которое поставили курсор, а оно под клавишами, — страница доводит до него
// прокрутку. Пока открыто окно, клавиатура печатает только в его поля.
//
// Поле остаётся активным, пока нажимают кнопки: у кнопок отменено перехватывание
// фокуса (onMouseDown → preventDefault). Знаки вставляются в позицию курсора через
// родной сеттер значения, чтобы React увидел ввод как обычный набор с клавиатуры.
// Enter отправляется как настоящая клавиша: поле сканера добавит товар, форма
// сохранится — всё как с физической клавиатуры.
//
// Рисуется там же, где окна форм (overlayHost), а не внутри кассы: иначе затемнение
// открытого окна ложилось бы поверх клавиш, и в карточку нового товара было бы не
// напечатать — а это как раз тот случай, ради которого клавиатура и нужна.

const RU = [
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
  ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э', 'ё'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '.', ',', '-'],
]
// Таджикские буквы: ввод по-таджикски — обычное дело в названиях и именах
const TG = [
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'ҷ', 'з', 'х', 'ъ'],
  ['ф', 'ӣ', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ҳ', 'э', 'ё'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ғ', 'қ', 'ӯ', 'ю', '.', '-'],
]
const EN = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", '/'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-', '_', '@'],
]
const RASKLADKI = { ru: RU, tg: TG, en: EN }
const SLED = { ru: 'tg', tg: 'en', en: 'ru' }
const LANG_LABEL = { ru: 'РУ', tg: 'ТҶ', en: 'EN' }
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const NUMPAD = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00', '.']

// Куда можно печатать: текстовые поля и многострочные. Дата и выпадающие списки — нет
const TEKSTOVYE = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number'])
const godnoe = (el) =>
  !!el &&
  el.isConnected &&
  !el.disabled &&
  !el.readOnly &&
  (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEKSTOVYE.has((el.type || 'text').toLowerCase())))

// Значение ставим родным сеттером: React подменяет свойство value на элементе,
// и прямое присваивание он не замечает — поле осталось бы с прежним текстом
function postavit(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// У поля number нет позиции курсора — печатаем в конец
const kursor = (el) => {
  try {
    const a = el.selectionStart
    const b = el.selectionEnd
    if (typeof a === 'number' && typeof b === 'number') return [a, b]
  } catch {
    /* number */
  }
  return [el.value.length, el.value.length]
}
const vernutKursor = (el, pos) => {
  try {
    el.setSelectionRange(pos, pos)
  } catch {
    /* number */
  }
}

const vidno = (el) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

// Куда печатать, если курсора нет нигде: первое поле открытого окна (верхнего), иначе поле
// с пометкой data-vkb-default (поле сканера кассы), иначе первое поле страницы — обычно поиск
export function poleDlyaVvoda() {
  if (typeof document === 'undefined') return null
  const okna = [...document.querySelectorAll('.overlay .modal')].reverse()
  for (const m of okna) for (const el of m.querySelectorAll('input, textarea')) if (godnoe(el) && vidno(el)) return el
  const d = document.querySelector('[data-vkb-default]')
  if (godnoe(d) && vidno(d)) return d
  const page = document.querySelector('.content') || document.body
  for (const el of page.querySelectorAll('input, textarea')) if (godnoe(el) && vidno(el)) return el
  return null
}

const ZAZOR = 12 // окно и поле не подходят к клавиатуре ближе этого

// Что поднимается над клавиатурой: открытые окна и то, что помечено data-vkb-lift
// (форма входа: под клавишами оказались бы «Войти» и выбор языка)
const PODNYAT = '.overlay > .modal, [data-vkb-lift]'

// Поднятое над клавиатурой — вернуть на место
function opustitOkna() {
  for (const m of document.querySelectorAll('[data-kb-lift]')) {
    m.style.removeProperty('top')
    m.style.removeProperty('max-height')
    m.removeAttribute('data-kb-lift')
    const o = m.parentElement
    if (o?.classList.contains('overlay')) {
      o.style.removeProperty('align-items')
      o.style.removeProperty('padding-top')
    }
  }
}

export default function VirtualKeyboard({ fallbackRef, onClose }) {
  const t = useT()
  const [lang, setLang] = useState(() => {
    try {
      const v = localStorage.getItem('apteka_vkb_lang')
      return RASKLADKI[v] ? v : 'ru'
    } catch {
      return 'ru'
    }
  })
  const [shift, setShift] = useState(false)
  const last = useRef(null)
  const panelRef = useRef(null)

  // Верх клавиатуры на экране: над ним должно оставаться то, во что печатают. Клавиатуры не
  // видно (окно сузили меньше 1280 — она спрятана стилями) — верха нет, поднимать нечего
  const verh = () => {
    const r = panelRef.current?.getBoundingClientRect()
    return r && r.height > 0 ? r.top : null
  }

  // Поле страницы под клавишами — довести до него прокрутку (поля окон поднимает само окно)
  const pokazat = (el) => {
    if (!el || el.closest?.('.modal')) return
    const top = verh()
    if (top !== null && el.getBoundingClientRect().bottom > top - ZAZOR) el.scrollIntoView({ block: 'center' })
  }

  // Помним последнее поле, в котором стоял курсор: нажатие на кнопку панели фокус
  // не трогает, но поле могло потерять его иначе — закрылось окно, перерисовался чек
  useEffect(() => {
    if (godnoe(document.activeElement)) {
      last.current = document.activeElement
      pokazat(document.activeElement)
    }
    const onFocus = (e) => {
      const el = e.target
      if (el && !el.closest?.('.vkb') && godnoe(el)) {
        last.current = el
        pokazat(el)
      }
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Пока клавиатура открыта, у длинной страницы снизу есть запас прокрутки — последние
  // поля можно поднять над клавишами. Видимое при этом не сдвигается (см. index.css)
  useEffect(() => {
    document.documentElement.classList.add('kb-open')
    return () => document.documentElement.classList.remove('kb-open')
  }, [])

  // ── Окно не прячется под клавиатурой ──
  // Низ открытого окна ниже верха клавиатуры — окно поднимается ровно настолько, чтобы
  // встать над ней (сдвигом top, а не transform: transform ломал бы всплывающие списки
  // внутри окна). Выше свободного места — встаёт к верху экрана и листается внутри себя.
  // Пересчёт — когда окно открылось, закрылось или поменяло размер и при смене размера экрана
  useLayoutEffect(() => {
    let raf = 0
    const seen = new Set()
    let sizes = null
    const fit = () => {
      raf = 0
      // Высокое окно листается внутри себя: пересчёт не должен сбрасывать его прокрутку
      const prokrutka = new Map([...document.querySelectorAll('[data-kb-lift]')].map((m) => [m, m.scrollTop]))
      opustitOkna()
      const top = verh()
      if (top === null) return
      for (const m of document.querySelectorAll(PODNYAT)) {
        if (sizes && !seen.has(m)) {
          seen.add(m)
          sizes.observe(m)
        }
        const r = m.getBoundingClientRect()
        if (!r.height || r.bottom <= top - ZAZOR) continue
        m.setAttribute('data-kb-lift', '')
        const nado = r.bottom - (top - ZAZOR)
        const mozhno = Math.max(0, r.top - ZAZOR)
        const o = m.parentElement
        if (nado <= mozhno || !o?.classList.contains('overlay')) {
          m.style.top = `-${Math.ceil(Math.min(nado, mozhno))}px`
        } else {
          o.style.alignItems = 'flex-start'
          o.style.paddingTop = ZAZOR + 'px'
          m.style.maxHeight = Math.max(160, Math.floor(top - 2 * ZAZOR)) + 'px'
        }
      }
      for (const [m, st] of prokrutka) if (st && m.isConnected) m.scrollTop = st
    }
    const plan = () => {
      if (!raf) raf = requestAnimationFrame(fit)
    }
    // Перерисовки самой клавиатуры (смена раскладки, Shift) окна не двигают
    const vne = (r) => !(r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.('.vkb')
    if (typeof ResizeObserver === 'function') sizes = new ResizeObserver(plan)
    fit()
    // Окна форм — в #overlay-root, вопросы и подтверждения (useDialog) — прямо в body
    const host = document.getElementById('overlay-root')
    const changes = new MutationObserver((list) => {
      if (list.some(vne)) plan()
    })
    if (host) changes.observe(host, { childList: true, subtree: true })
    changes.observe(document.body, { childList: true })
    window.addEventListener('resize', plan)
    if (sizes && panelRef.current) sizes.observe(panelRef.current)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      changes.disconnect()
      if (sizes) sizes.disconnect()
      window.removeEventListener('resize', plan)
      opustitOkna()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('apteka_vkb_lang', lang)
    } catch {
      /* приватный режим */
    }
  }, [lang])

  // Поле, в которое печатаем: активное, иначе последнее, иначе поле по умолчанию (сканер
  // кассы, первое поле страницы). Открыто окно — только его поля: иначе цифры суммы ушли бы
  // в поиск страницы за затемнением, а курсор — из окна
  const pole = () => {
    const okno = [...document.querySelectorAll('.overlay > .modal')].pop() || null
    const goditsya = (el) => godnoe(el) && !el.closest?.('.vkb') && (!okno || okno.contains(el))
    const a = document.activeElement
    if (goditsya(a)) return a
    if (goditsya(last.current)) {
      last.current.focus()
      return last.current
    }
    const f = okno ? poleDlyaVvoda() : fallbackRef?.current
    if (godnoe(f)) {
      f.focus()
      return f
    }
    return null
  }

  const vstavit = (ch) => {
    const el = pole()
    if (!el) return
    const [a, b] = kursor(el)
    const v = el.value
    postavit(el, v.slice(0, a) + ch + v.slice(b))
    vernutKursor(el, a + ch.length)
    if (shift) setShift(false)
  }

  const steret = () => {
    const el = pole()
    if (!el) return
    const [a, b] = kursor(el)
    const v = el.value
    if (a !== b) {
      postavit(el, v.slice(0, a) + v.slice(b))
      vernutKursor(el, a)
    } else if (a > 0) {
      // Стираем целый знак, а не половину суррогатной пары
      const prev = [...v.slice(0, a)].pop() || ''
      postavit(el, v.slice(0, a - prev.length) + v.slice(a))
      vernutKursor(el, a - prev.length)
    }
  }

  const ochistit = () => {
    const el = pole()
    if (el) postavit(el, '')
  }

  // Enter — как с настоящей клавиатуры: поле сканера добавит товар, форма сохранится.
  // Нажатие, созданное программой, браузер форму сам не отправляет — отправляем сами,
  // как отправил бы настоящий Enter: поле в форме и никто Enter не перехватил (вход,
  // формы в окнах)
  const vvod = () => {
    const el = pole()
    if (!el) return
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    const down = new KeyboardEvent('keydown', init)
    el.dispatchEvent(down)
    el.dispatchEvent(new KeyboardEvent('keyup', init))
    const form = el.tagName === 'INPUT' ? el.form : null
    if (form && !down.defaultPrevented && el.isConnected) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }
  }

  const derzhat = (e) => e.preventDefault() // кнопка не забирает фокус у поля
  const bukva = (ch) => (shift ? ch.toUpperCase() : ch)
  const rows = RASKLADKI[lang] || RU

  const host = overlayHost()
  const panel = (
    <div className="vkb" ref={panelRef} role="group" aria-label={t('Экранная клавиатура')} data-tour="pos.vkb">
      <div className="vkb-rows">
        <div className="vkb-row">
          {DIGITS.map((d) => (
            <button key={d} type="button" className="vkb-key" onMouseDown={derzhat} onClick={() => vstavit(d)}>{d}</button>
          ))}
          <button type="button" className="vkb-key fn wide" onMouseDown={derzhat} onClick={steret} aria-label={t('Стереть')} title={t('Стереть')}>
            <LuDelete size={20} />
          </button>
        </div>
        {rows.map((row, n) => (
          <div key={n} className="vkb-row">
            {n === 2 && (
              <button type="button" className={'vkb-key fn' + (shift ? ' on' : '')} onMouseDown={derzhat} onClick={() => setShift((v) => !v)} aria-pressed={shift} aria-label="Shift" title="Shift">
                <LuArrowBigUp size={20} />
              </button>
            )}
            {row.map((ch) => (
              <button key={ch} type="button" className="vkb-key" onMouseDown={derzhat} onClick={() => vstavit(bukva(ch))}>{bukva(ch)}</button>
            ))}
            {n === 1 && (
              <button type="button" className="vkb-key enter wide" onMouseDown={derzhat} onClick={vvod} aria-label={t('Ввод')} title={t('Ввод')}>
                <LuCornerDownLeft size={20} />
              </button>
            )}
          </div>
        ))}
        <div className="vkb-row">
          <button type="button" className="vkb-key fn wide" onMouseDown={derzhat} onClick={() => setLang(SLED[lang] || 'ru')} title={t('Сменить язык')}>
            <LuLanguages size={17} /> {LANG_LABEL[lang] || 'РУ'}
          </button>
          <button type="button" className="vkb-key space" onMouseDown={derzhat} onClick={() => vstavit(' ')}>{t('Пробел')}</button>
          <button type="button" className="vkb-key fn wide" onMouseDown={derzhat} onClick={ochistit} title={t('Очистить поле')}>
            <LuEraser size={17} /> {t('Очистить')}
          </button>
          <button type="button" className="vkb-key fn wide" onMouseDown={derzhat} onClick={onClose} title={t('Закрыть клавиатуру')}>
            <LuX size={17} /> {t('Закрыть')}
          </button>
        </div>
      </div>
      <div className="vkb-num" role="group" aria-label={t('Цифры')}>
        {NUMPAD.map((d) => (
          <button key={d} type="button" className="vkb-key" onMouseDown={derzhat} onClick={() => vstavit(d)}>{d}</button>
        ))}
        <button type="button" className="vkb-key fn" onMouseDown={derzhat} onClick={steret} aria-label={t('Стереть')} title={t('Стереть')}><LuDelete size={20} /></button>
        <button type="button" className="vkb-key enter num-enter" onMouseDown={derzhat} onClick={vvod} aria-label={t('Ввод')} title={t('Ввод')}><LuCornerDownLeft size={20} /></button>
      </div>
    </div>
  )
  return host ? createPortal(panel, host) : panel
}
