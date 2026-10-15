import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { overlayHost } from './ui'
import { LuDelete, LuCornerDownLeft, LuX, LuLanguages, LuArrowBigUp, LuEraser } from 'react-icons/lu'
import { useT } from '../lib/i18n'

// ── Экранная клавиатура кассы ──
// У кассового места часто нет клавиатуры: сенсорный экран, сканер и всё. Набрать
// название товара, сумму «Получено» или имя клиента тогда нечем. Эта панель
// печатает в то поле, где стоит курсор, — любое поле кассы, включая формы в окнах.
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

  // Помним последнее поле, в котором стоял курсор: нажатие на кнопку панели фокус
  // не трогает, но поле могло потерять его иначе — закрылось окно, перерисовался чек
  useEffect(() => {
    if (godnoe(document.activeElement)) last.current = document.activeElement
    const onFocus = (e) => {
      const el = e.target
      if (el && !el.closest?.('.vkb') && godnoe(el)) last.current = el
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])

  // Пока клавиатура открыта, страница и окна отдают ей место снизу (см. index.css)
  useEffect(() => {
    document.documentElement.classList.add('kb-open')
    return () => document.documentElement.classList.remove('kb-open')
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('apteka_vkb_lang', lang)
    } catch {
      /* приватный режим */
    }
  }, [lang])

  // Поле, в которое печатаем: активное, иначе последнее, иначе поле сканера
  const pole = () => {
    const a = document.activeElement
    if (godnoe(a) && !a.closest?.('.vkb')) return a
    if (godnoe(last.current)) {
      last.current.focus()
      return last.current
    }
    const f = fallbackRef?.current
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

  // Enter — как с настоящей клавиатуры: поле сканера добавит товар, форма сохранится
  const vvod = () => {
    const el = pole()
    if (!el) return
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  }

  const derzhat = (e) => e.preventDefault() // кнопка не забирает фокус у поля
  const bukva = (ch) => (shift ? ch.toUpperCase() : ch)
  const rows = RASKLADKI[lang] || RU

  const host = overlayHost()
  const panel = (
    <div className="vkb" role="group" aria-label={t('Экранная клавиатура')} data-tour="pos.vkb">
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
