import { useEffect, useMemo, useRef, useState } from 'react'
import { LuCircleCheck } from 'react-icons/lu'
import { stockText } from '../../db/store'
import { useT } from '../../lib/i18n'
import { normalizeScan } from '../../lib/scan'
import { beepError } from '../../lib/sound'
import { autoPickDelay, looksLikeCode, nameSuggest, productByCode } from '../../lib/pick'

// ── Товар: «Штрихкод» и «Наименование» ──
// Одно и то же в новом поступлении и в возврате поставщику (правила — lib/pick.js).
//   • «Штрихкод»: сканер стреляет сюда и сам жмёт Enter — товар находится сразу,
//     название появляется во втором поле, курсор уходит в количество. Вписали код
//     руками — товар подставится сам, как только код совпал (Enter и Tab — сразу).
//   • «Наименование»: заполняется само; можно и набрать название — ниже подсказки,
//     стрелки выбирают, Enter берёт выбранную. Штрихкод выбранного товара встанет
//     в первое поле сам.
// Незнакомый штрихкод — onUnknownCode (поступление открывает карточку нового товара),
// не найденное название — onUnknownName.
//
// code и name — что написано в полях; chosen — выбранный товар (или null). Пока в поле
// названия его название, подсказки не нужны, а Enter значит «дальше, к количеству».
// codeTour и nameTour — метки тура по программе на этих полях, tour — на обоих сразу.
//
// nov — новый товар: кода или названия нет в базе, товар заведётся из формы. Тогда
// поля друг друга не очищают, в названии — метка «новый», а подсказки под ним —
// «уже есть в базе»: выбрать их можно стрелками или мышью, но Enter сам их не
// берёт — он значит «название готово, дальше». nameRef — поле названия
export default function ProductPick({
  ids,
  products,
  code,
  name,
  chosen,
  onCode,
  onName,
  onPick,
  onUnknownCode,
  onUnknownName,
  onEnterChosen,
  codeRef,
  readOnly = false,
  autoFocus = true,
  hint,
  codeTour,
  nameTour,
  tour,
  nov = false,
  nameRef,
}) {
  const t = useT()
  const [active, setActive] = useState(0)
  // Подсказки видны, только пока курсор в поле названия: иначе список висел бы
  // поверх формы, когда название уже набрано, а курсор ушёл дальше
  const [nameFocus, setNameFocus] = useState(false)
  // Последний обработчик выбора — для отложенной подстановки: таймер не должен
  // позвать устаревший (у формы за это время могли поменяться строки)
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  const suggest = useMemo(() => {
    if (readOnly || (chosen && name === chosen.name)) return []
    return nameSuggest(products, name)
  }, [products, name, chosen, readOnly])
  // У нового товара подсказка не выбрана сама: Enter — «название готово», а не «возьми первую»
  useEffect(() => setActive(nov ? -1 : 0), [name, nov])

  // Код вписали руками — как только он совпал со штрихкодом товара, товар подставляется
  // сам (через короткую паузу; см. autoPickDelay)
  useEffect(() => {
    if (readOnly || chosen) return undefined
    const delay = autoPickDelay(products, code)
    if (delay === null) return undefined
    const id = setTimeout(() => {
      const p = productByCode(products, code)
      if (p) pickRef.current(p)
    }, delay)
    return () => clearTimeout(id)
  }, [code, chosen, readOnly, products])

  function resolveCode(raw) {
    const val = String(raw || '').trim()
    if (!val) return
    const p = productByCode(products, val)
    if (p) return onPick(p)
    beepError()
    onUnknownCode?.(normalizeScan(val))
  }

  const codeIsChosen = !!chosen && String(code || '').trim() !== '' && productByCode(products, code)?.id === chosen.id
  function onCodeKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (codeIsChosen) return onEnterChosen?.()
      if (nov) {
        const p = productByCode(products, code)
        if (p) return onPick(p)
        // Новый товар: код принят — дальше название, если его ещё нет, иначе количество
        if (!String(name || '').trim()) return nameRef?.current?.focus()
        return onEnterChosen?.()
      }
      resolveCode(code)
    } else if (e.key === 'Tab' && !e.shiftKey && !chosen && String(code || '').trim()) {
      // Tab с найденным кодом — товар сразу, как Enter. Не найден — курсор просто уходит
      // в название: может быть, товар найдут по нему
      const p = productByCode(products, code)
      if (p) {
        e.preventDefault()
        onPick(p)
      }
    }
  }

  function onNameKey(e) {
    if (e.key === 'ArrowDown' && suggest.length) {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, suggest.length - 1))
    } else if (e.key === 'ArrowUp' && suggest.length) {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, nov ? -1 : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const val = String(name || '').trim()
      if (chosen && name === chosen.name) return onEnterChosen?.()
      if (nov) {
        if (active >= 0 && suggest[active]) return onPick(suggest[active])
        if (looksLikeCode(val) && productByCode(products, val)) return onPick(productByCode(products, val))
        if (val) onEnterChosen?.()
        return
      }
      if (!val) return
      // Сканер выстрелил в поле названия — это код, а не название
      if (looksLikeCode(val) && productByCode(products, val)) return onPick(productByCode(products, val))
      if (suggest.length) return onPick(suggest[Math.min(active, suggest.length - 1)])
      if (looksLikeCode(val)) return resolveCode(val)
      beepError()
      onUnknownName?.(val)
    }
  }

  return (
    <div className={'prh-pick' + (chosen ? ' found' : '') + (nov ? ' nov' : '')} data-tour={tour}>
      <div className="prh-f prh-f-code" data-tour={codeTour}>
        <label htmlFor={ids.code}>{t('Штрихкод')}</label>
        <input
          id={ids.code}
          ref={codeRef}
          className="scan-input"
          value={code}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          readOnly={readOnly}
          onChange={(e) => onCode(e.target.value)}
          onKeyDown={onCodeKey}
          // Весь код выделяется: следующий скан заменит его, а не допишется в хвост
          onFocus={(e) => e.target.select()}
          placeholder={t('Сканируйте код')}
        />
      </div>
      <div className="prh-f prh-f-name" data-tour={nameTour}>
        <label htmlFor={ids.name}>{t('Наименование')}</label>
        <div className="prh-search">
          <input
            id={ids.name}
            ref={nameRef}
            className="scan-input"
            value={name}
            autoComplete="off"
            readOnly={readOnly}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={onNameKey}
            onFocus={(e) => { setNameFocus(true); e.target.select() }}
            onBlur={() => setNameFocus(false)}
            // Пусто — название появится само после скана; длинное видно целиком при наведении
            placeholder={nov ? t('Название нового товара') : t('Или наберите название')}
            title={name || undefined}
          />
          {chosen && name === chosen.name && <span className="prh-pick-ok" aria-hidden="true"><LuCircleCheck size={17} /></span>}
          {nov && <span className="prh-pick-new" aria-hidden="true">{t('новый')}</span>}
          {nameFocus && suggest.length > 0 && (
            <ul className="prh-suggest" role="listbox">
              {nov && <li className="prh-suggest-cap" role="presentation">{t('Уже есть в базе — выберите, если это он')}</li>}
              {suggest.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); onPick(p) }}>
                  <span className="prh-suggest-name">{p.name}</span>
                  <span className="tag-cat">{p.barcode || '—'} · {t('остаток')} {stockText(p)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {hint && <div className="scan-hint prh-pick-hint">{hint}</div>}
    </div>
  )
}
