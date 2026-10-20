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
// codeTour и nameTour — метки тура по программе на этих полях, tour — на обоих сразу
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
}) {
  const t = useT()
  const [active, setActive] = useState(0)
  // Последний обработчик выбора — для отложенной подстановки: таймер не должен
  // позвать устаревший (у формы за это время могли поменяться строки)
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  const suggest = useMemo(() => {
    if (readOnly || (chosen && name === chosen.name)) return []
    return nameSuggest(products, name)
  }, [products, name, chosen, readOnly])
  useEffect(() => setActive(0), [name])

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
      if (codeIsChosen) onEnterChosen?.()
      else resolveCode(code)
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
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const val = String(name || '').trim()
      if (chosen && name === chosen.name) return onEnterChosen?.()
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
    <div className={'prh-pick' + (chosen ? ' found' : '')} data-tour={tour}>
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
            className="scan-input"
            value={name}
            autoComplete="off"
            readOnly={readOnly}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={onNameKey}
            onFocus={(e) => e.target.select()}
            // Пусто — название появится само после скана; длинное видно целиком при наведении
            placeholder={t('Или наберите название')}
            title={name || undefined}
          />
          {chosen && name === chosen.name && <span className="prh-pick-ok" aria-hidden="true"><LuCircleCheck size={17} /></span>}
          {suggest.length > 0 && (
            <ul className="prh-suggest" role="listbox">
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
