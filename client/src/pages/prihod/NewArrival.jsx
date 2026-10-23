import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LuBanknote, LuCreditCard, LuClock, LuCalculator, LuTrash2, LuScanLine, LuPackagePlus, LuEraser,
  LuPlus, LuCheck, LuListChecks, LuReceipt, LuSearch, LuRotateCcw,
} from 'react-icons/lu'
import { useToast, useDialog } from '../../components/ui'
import NumberInput from '../../components/NumberInput'
import { productPayload, emptyProduct } from '../../components/ProductForm'
import { useCashSources, sourceName } from '../../components/SupplierMoney'
import { db, money, stockText } from '../../db/store'
import { receiveArrival } from '../../db/ops'
import { useCan } from '../../db/auth'
import { useT, translate as tr } from '../../lib/i18n'
import { normalizeScan, canonBarcode } from '../../lib/scan'
import { beepOk, beepError } from '../../lib/sound'
import { isVesovoy, KG, EDINICY, uppOf } from '../../lib/units'
import { AddCategoryBtn } from '../../components/CategorySelect'
import { generateEan13 } from '../../lib/barcode'
import { useCategories, categoryOptions, categoryNames } from '../../lib/categories'
import { priceFromMarkup, markupOf } from '../../lib/pricing'
import {
  lineFromProduct, lineCost, lineTotal, lineRetail, lineUnits, summary, qtyText, packText, lineProblem, toItem,
  piecePrice, discCost, n2, pct, num,
} from '../../lib/prihod'
import { usePrihod, setPrihod, setForm, setPay, resetDraft, blankForm } from './store'
import { SupplierPick } from './SupplierPick'
import ProductPick from './ProductPick'

// ── Новое поступление ──
// Как в привычных программах приёмки: по центру — накладная таблицей, справа — итоги
// тёмно-синей панелью, снизу — форма: подписи слева от полей, два плотных столбца
// (слева — что, сколько и почём пришло; справа — упаковка, категория и цена продажи).
// Форма добавляет товар (сканер стреляет в поле
// «Штрихкод», название встаёт в «Наименование» само, курсор уходит в количество,
// Enter — строка в таблице), заводит новый товар (кода или названия нет в базе —
// форма сама становится «новым товаром»: название, единица, категория, количество и
// цены; «Завести и добавить» кладёт его в «Товары» и строкой в приход), правит строку
// (щелчок по строке открывает её в форме), правит сразу отмеченные строки и проводит
// приход: чем заплатили и «Оприходовать».
//
// Всё набранное живёт в store.js — вкладку можно оставить и вернуться.

// В поле количества или цены мог «выстрелить» сканер: для них таких чисел не бывает
const looksLikeScan = (v) => String(v ?? '').replace(/\D/g, '').length >= 8

export default function NewArrival({ products, suppliers, onSaved }) {
  const t = useT()
  const can = useCan()
  const toast = useToast()
  const dialog = useDialog()
  const st = usePrihod()
  const { lines, form, checked, sub } = st
  const sup = suppliers.find((s) => s.id === st.supplierId) || null
  const s = useMemo(() => summary(lines), [lines])

  const scanRef = useRef(null)
  const nameRef = useRef(null)
  const qtyRef = useRef(null)
  const [focusQty, setFocusQty] = useState(0)
  const [savingNew, setSavingNew] = useState(false)
  const catList = useCategories()
  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0)

  useEffect(() => {
    if (!focusQty) return
    const el = qtyRef.current
    if (el) {
      el.focus()
      el.select?.()
    }
  }, [focusQty])

  // Подсветка строки, которую только что добавили или нашли сканером, — на миг
  useEffect(() => {
    if (!st.flash) return
    const id = setTimeout(() => setPrihod({ flash: '' }), 1400)
    return () => clearTimeout(id)
  }, [st.flash])

  // ── Товар в форме ──
  const chosen = form.productId ? products.find((p) => p.id === form.productId) || null : null
  const editing = form.editKey ? lines.find((l) => l.key === form.editKey) || null : null
  // Новый товар — его ещё нет в базе: строку собираем из того, что вписано в форме.
  // Штук в упаковке у дробного (кг, л…) — тысячные, у штуки — одна
  const novUnit = form.novUnit || 'уп'
  const novUpp = isVesovoy({ unit: novUnit }) ? KG : novUnit === 'шт' ? 1 : Math.max(1, Math.trunc(Number(form.novUpp) || 1))
  const nov = !!form.nov && !editing && !chosen
  const novLine = nov
    ? {
        ...lineFromProduct({ id: null, name: String(form.q || '').trim(), barcode: String(form.code || '').trim(), category: form.novCat || '', unit: novUnit, unitsPerPack: novUpp }),
        key: 'nov',
      }
    : null
  const baseLine = editing || (chosen ? lineFromProduct(chosen) : novLine)
  const draft = baseLine
    ? { ...baseLine, qty: form.qty, pieces: form.pieces, base: form.base, disc: form.disc, price: form.price, expiryDate: form.expiryDate }
    : null

  function editLine(l) {
    setPrihod({
      sub: 'add',
      form: { ...blankForm(), productId: l.productId, code: l.barcode || '', q: l.name, qty: l.qty, pieces: l.pieces, base: l.base, disc: l.disc, price: l.price, price0: l.price0, mk: null, expiryDate: l.expiryDate, editKey: l.key },
    })
    setFocusQty((n) => n + 1)
  }

  function choose(p) {
    const was = lines.find((l) => l.productId === p.id)
    if (was) {
      // Не задваиваем: открываем строку этого товара — поправить количество
      beepError()
      toast(`«${p.name}» ${tr('уже в этом приходе — исправьте строку')}`, 'err')
      setPrihod({ flash: was.key })
      return editLine(was)
    }
    const disc = st.discAll ? form.disc : ''
    const l = lineFromProduct(p, { disc })
    setForm({ productId: p.id, code: p.barcode || '', q: p.name, qty: l.qty, pieces: '', base: l.base, disc, price: l.price, price0: l.price0, mk: null, expiryDate: '', editKey: '', nov: false })
    beepOk()
    setFocusQty((n) => n + 1)
  }

  // ── Новый товар: кода или названия нет в базе ──
  // Форма сама становится «новым товаром». Пришёл код — впишут название; пришло
  // название — отсканируют код упаковки (или оставят пустым: тогда код даст программа)
  function startNew({ code = '', q = '' }) {
    setPrihod((x) => ({
      form: { ...blankForm(), disc: x.discAll ? x.form.disc : '', nov: true, code, q },
    }))
    setTimeout(() => (q ? scanRef : nameRef).current?.focus(), 0)
  }

  function clearForm() {
    setPrihod((x) => ({ form: { ...blankForm(), disc: x.discAll ? x.form.disc : '' } }))
    focusScan()
  }

  // Числа формы: штрихкод в количестве или цене — не принимаем, возвращаем курсор сканеру
  const numField = (key) => (e) => {
    const v = e.target.value
    if (looksLikeScan(v)) {
      beepError()
      toast(tr('Это похоже на штрихкод — сканируйте ещё раз'), 'err')
      return focusScan()
    }
    setForm({ [key]: v })
  }

  // Скидка «на все товары»: та же скидка у всех строк, и у новых тоже
  function setDisc(v) {
    if (looksLikeScan(v)) return focusScan()
    setPrihod((x) => ({ form: { ...x.form, disc: v }, ...(x.discAll ? { lines: x.lines.map((l) => ({ ...l, disc: v })) } : {}) }))
  }
  function toggleDiscAll(on) {
    setPrihod((x) => ({
      discAll: on,
      ...(on && String(x.form.disc).trim() !== '' ? { lines: x.lines.map((l) => ({ ...l, disc: x.form.disc })) } : {}),
    }))
  }

  // Наценка ↔ цена продажи: вписали процент — цена посчиталась от закупа со скидкой
  const cost = draft ? lineCost(draft) : 0
  // Наценка в подписи «Розничная цена 40%» — зелёным, как в привычных программах приёмки
  const mkRaw = form.mk ?? markupOf(cost, form.price)
  const mkShown = draft && cost > 0 && String(form.price).trim() !== '' && mkRaw !== '' && mkRaw !== null && mkRaw !== undefined ? String(mkRaw).replace('.', ',') : ''
  // «Штук в упаковке» есть у упаковки и рулона; у штуки и дробных единиц (кг, л…) — нет
  const novUppEditable = nov && !isVesovoy({ unit: novUnit }) && novUnit !== 'шт'
  function setMarkup(v) {
    const p = priceFromMarkup(cost, v)
    setForm({ mk: v, ...(p !== null ? { price: String(p) } : {}) })
  }

  // ── В таблицу ──
  function commit() {
    if (!draft) {
      toast(tr('Сначала выберите товар: отсканируйте штрихкод или найдите по названию'), 'err')
      return focusScan()
    }
    if (nov) return commitNew()
    const problem = lineProblem(draft)
    if (problem) return toast(`«${draft.name}»: ${tr(problem)}`, 'err')
    const l = { ...draft, mk: null }
    setPrihod((x) => ({
      lines: x.form.editKey ? x.lines.map((y) => (y.key === x.form.editKey ? l : y)) : [...x.lines, l],
      form: { ...blankForm(), disc: x.discAll ? x.form.disc : '' },
      flash: l.key,
    }))
    if (!editing) beepOk()
    focusScan()
  }
  const onEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  function removeLine(key) {
    setPrihod((x) => ({
      lines: x.lines.filter((l) => l.key !== key),
      checked: x.checked.filter((k) => k !== key),
      ...(x.form.editKey === key ? { form: blankForm() } : {}),
    }))
  }

  // ── Новый товар: заводим карточку и сразу ставим строкой в этот приход ──
  // В «Товарах» он появляется с тем же названием, штрихкодом, единицей, категорией,
  // закупочной (цена поставщика со скидкой), ценой продажи и сроком, что в строке.
  // Сам товар заводится с нулём: остаток даст «Оприходовать», как у всех товаров.
  // Штрихкода нет — даём свой внутренний код (его можно распечатать этикеткой)
  async function commitNew() {
    if (savingNew) return
    const name = String(form.q || '').trim()
    if (!name) {
      toast(tr('Впишите название нового товара'), 'err')
      return nameRef.current?.focus()
    }
    const problem = lineProblem(draft)
    if (problem) return toast(`«${name}»: ${tr(problem)}`, 'err')
    const barcode = normalizeScan(String(form.code || '').trim()) || generateEan13(products.map((p) => p.barcode))
    if (!barcode) return toast(tr('Не удалось сгенерировать код'), 'err')
    const dup = products.find((p) => p.barcode && canonBarcode(p.barcode) === canonBarcode(barcode))
    if (dup) return toast(tr('Такой штрихкод уже есть') + ': ' + dup.name, 'err')
    const f = {
      ...emptyProduct,
      name,
      barcode,
      category: form.novCat || '',
      unit: novUnit,
      unitsPerPack: String(novUpp),
      cost: String(lineCost(draft)),
      price: String(form.price ?? ''),
      expiryDate: form.expiryDate || '',
      minStock: '5',
    }
    setSavingNew(true)
    try {
      const created = await db.push('products', { ...productPayload(f), stock: 0, looseUnits: 0 })
      const l = {
        ...lineFromProduct(created, { disc: form.disc }),
        qty: form.qty,
        pieces: form.pieces,
        base: form.base,
        disc: form.disc,
        price: form.price,
        expiryDate: form.expiryDate,
      }
      setPrihod((x) => ({ lines: [...x.lines, l], flash: l.key, form: { ...blankForm(), disc: x.discAll ? x.form.disc : '' } }))
      beepOk()
      toast(`«${created.name}» ${tr('заведён в «Товарах» и добавлен в приход')}`)
      focusScan()
    } catch (e) {
      toast(tr(e.message), 'err')
    } finally {
      setSavingNew(false)
    }
  }

  // ── Отмеченные строки ──
  const allKeys = lines.map((l) => l.key)
  const toggle = (key) => setPrihod((x) => ({ checked: x.checked.includes(key) ? x.checked.filter((k) => k !== key) : [...x.checked, key] }))
  const allChecked = lines.length > 0 && checked.length === lines.length

  // ── Поиск по строкам накладной ──
  const [lq, setLq] = useState('')
  const shown = useMemo(() => {
    const q = lq.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((l) => l.name.toLowerCase().includes(q) || String(l.barcode || '').includes(q))
  }, [lines, lq])

  return (
    <div className="prh-new">
      {/* ── Накладная ── */}
      <section className="panel prh-sheet" data-tour="af.line">
        <div className="prh-sheet-head">
          <h2><span className="h2-title"><span className="ic"><LuReceipt size={17} /></span>{t('Накладная')}</span></h2>
          <div className="prh-sheet-search">
            <LuSearch size={15} aria-hidden="true" />
            <input value={lq} onChange={(e) => setLq(e.target.value)} placeholder={t('Поиск по строкам…')} aria-label={t('Поиск по строкам…')} />
          </div>
        </div>
        <div className="prh-grid-wrap">
          <table className="prh-grid">
            <thead>
              <tr>
                <th className="prh-c-chk">
                  <input type="checkbox" checked={allChecked} disabled={!lines.length} onChange={(e) => setPrihod({ checked: e.target.checked ? allKeys : [] })} aria-label={t('Отметить все строки')} />
                </th>
                <th className="num">№</th>
                <th>{t('Наименование')}</th>
                <th>{t('Штрихкод')}</th>
                <th>{t('В упаковке')}</th>
                <th>{t('Срок годности')}</th>
                <th className="num">{t('Кол-во')}</th>
                <th className="num">{t('Цена')}</th>
                <th className="num">{t('Скидка')}</th>
                <th className="num">{t('Цена со скидкой')}</th>
                <th className="num">{t('Розн. цена')}</th>
                <th className="num">{t('Итого')}</th>
                <th className="num">{t('Сумма в рознице')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const n = lines.indexOf(l) + 1
                const cls = [form.editKey === l.key ? 'sel' : '', st.flash === l.key ? 'flash' : '', checked.includes(l.key) ? 'chk' : ''].join(' ').trim()
                return (
                  <tr key={l.key} className={cls} onClick={() => editLine(l)} title={t('Открыть строку в форме')}>
                    <td className="prh-c-chk" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={checked.includes(l.key)} onChange={() => toggle(l.key)} aria-label={`${t('Отметить')}: ${l.name}`} />
                    </td>
                    <td className="num muted">{n}</td>
                    <td className="prh-c-name" title={l.name}>{l.name}</td>
                    <td className="muted prh-c-code">{l.barcode || '—'}</td>
                    <td className="muted">{packText(l, t)}</td>
                    <td className="muted">{l.expiryDate ? l.expiryDate.split('-').reverse().join('.') : '—'}</td>
                    <td className="num"><b>{qtyText(l, t)}</b></td>
                    <td className="num">{n2(num(l.base))}</td>
                    <td className="num">{num(l.disc) > 0 ? pct(l.disc) : '—'}</td>
                    <td className="num">{n2(lineCost(l))}</td>
                    <td className={'num' + (num(l.price) !== l.price0 ? ' prh-changed' : '')} title={num(l.price) !== l.price0 ? `${t('Было')}: ${money(l.price0)}` : undefined}>{n2(num(l.price))}</td>
                    <td className="num"><b>{n2(lineTotal(l))}</b></td>
                    <td className="num">{n2(lineRetail(l))}</td>
                    <td className="prh-c-act" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="btn ghost sm icon" onClick={() => removeLine(l.key)} title={t('Убрать из прихода')} aria-label={`${t('Убрать из прихода')}: ${l.name}`}>
                        <LuTrash2 size={15} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!lines.length && (
                <tr className="prh-empty"><td colSpan="14">{t('Строк пока нет. Отсканируйте штрихкод или найдите товар по названию в форме ниже.')}</td></tr>
              )}
              {lines.length > 0 && !shown.length && (
                <tr className="prh-empty"><td colSpan="14">{t('Ничего не найдено')}</td></tr>
              )}
            </tbody>
            {lines.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan="6">{t('Итого')}: {s.count} {t('поз.')}</td>
                  <td className="num">{n2(s.packs)}</td>
                  <td className="num">{n2(s.base)}</td>
                  <td className="num">{s.discount > 0 ? pct(s.discountPct) : '—'}</td>
                  <td></td>
                  <td></td>
                  <td className="num">{n2(s.total)}</td>
                  <td className="num">{n2(s.retail)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* ── Итоги ── */}
      <aside className="prh-sum" data-tour="af.total" aria-label={t('Итоги прихода')}>
        <div className="prh-sum-sup">
          <span>{t('Поставщик')}</span>
          <b className={sup ? '' : 'none'}>{sup ? sup.name : t('Без поставщика')}</b>
        </div>
        <dl>
          <div><dt>{t('Позиций')}</dt><dd>{s.count}</dd></div>
          <div><dt>{t('Кол-во')}</dt><dd>{n2(s.packs)}</dd></div>
          <div><dt>{t('Сумма')}</dt><dd>{money(s.base)}</dd></div>
          <div><dt>{t('Скидка')}</dt><dd>{pct(s.discountPct)}{s.discount > 0 ? ` · ${money(s.discount)}` : ''}</dd></div>
          <div className="prh-sum-total"><dt>{t('Итого')}</dt><dd>{money(s.total)}</dd></div>
          <div><dt>{t('Ожидаемая наценка')}</dt><dd>{pct(s.markupPct)} · {money(s.markup)}</dd></div>
          <div><dt>{t('Ожидаемая выручка')}</dt><dd>{money(s.retail)}</dd></div>
        </dl>
      </aside>

      {/* ── Форма под таблицей ── */}
      <section className="panel prh-form">
        <div className="prh-subtabs" role="tablist">
          <button type="button" role="tab" aria-selected={sub === 'add'} className={sub === 'add' ? 'active' : ''} data-tour="af.tab-add" onClick={() => setPrihod({ sub: 'add' })}>
            <LuPlus size={15} /> {editing ? t('Правка строки') : t('Добавить товар')}
          </button>
          <button type="button" role="tab" aria-selected={sub === 'sel'} className={sub === 'sel' ? 'active' : ''} data-tour="af.tab-sel" onClick={() => setPrihod({ sub: 'sel' })}>
            <LuListChecks size={15} /> {t('Отмеченные строки')}{checked.length ? <span className="prh-badge">{checked.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={sub === 'finish'} className={sub === 'finish' ? 'active' : ''} data-tour="af.tab-oplata" onClick={() => setPrihod({ sub: 'finish' })}>
            <LuCheck size={15} /> {t('Сохранить поступление')}
          </button>
        </div>

        {sub === 'add' && (
          <div className="prh-add">
            <div className="prh-av">
              <div className="prh-av-col">
                <ProductPick
                  rows
                  ids={{ code: 'prh-q', name: 'prh-name' }}
                  labels={{ code: t('Штрих-код | Код'), name: t('Наименование') }}
                  codeTour="af.scan"
                  nameTour="af.name"
                  codeRef={scanRef}
                  products={products}
                  code={form.code || ''}
                  name={form.q}
                  chosen={chosen}
                  // Поменяли одно поле — другое относится к прежнему товару и очищается.
                  // У нового товара оба поля — его собственные и друг друга не трогают
                  onCode={(v) => (nov ? setForm({ code: v }) : setForm({ code: v, q: '', productId: '' }))}
                  onName={(v) => (nov ? setForm({ q: v }) : setForm({ q: v, code: '', productId: '' }))}
                  readOnly={!!editing}
                  nov={nov}
                  nameRef={nameRef}
                  onPick={choose}
                  onEnterChosen={() => setFocusQty((n) => n + 1)}
                  onUnknownCode={(barcode) => (can('products.create') ? startNew({ code: barcode }) : toast(tr('Товар с таким штрихкодом не найден'), 'err'))}
                  onUnknownName={(name) => (can('products.create') ? startNew({ q: name }) : toast(tr('Товар не найден'), 'err'))}
                />
                <div className="prh-f" data-tour="af.qty">
                  <label className={draft && lineUnits(draft) <= 0 ? 'req' : ''}>{t('Количество')}<span className="prh-star" aria-hidden="true">*</span></label>
                  <div className="prh-ctl prh-qty">
                    <label className="prh-unit">
                      <NumberInput ref={qtyRef} integer={!draft?.ves} value={form.qty} onChange={numField('qty')} onKeyDown={onEnter} disabled={!draft} aria-label={t('Количество')} />
                      <span>{draft ? t(draft.unit) : t('уп')}</span>
                    </label>
                    {draft?.div && (
                      <label className="prh-unit">
                        <NumberInput integer value={form.pieces} placeholder="0" onChange={numField('pieces')} onKeyDown={onEnter} aria-label={t('Штук сверх упаковок')} />
                        <span>{t('шт')}</span>
                      </label>
                    )}
                  </div>
                </div>
                <div className="prh-f">
                  <label className={draft && String(form.base).trim() === '' ? 'req' : ''}>{t('Цена поставщика')}<span className="prh-star" aria-hidden="true">*</span></label>
                  <div className="prh-ctl">
                    <NumberInput className="prh-num" value={form.base} onChange={numField('base')} onKeyDown={onEnter} disabled={!draft} placeholder="0" aria-label={t('Цена поставщика')} />
                    {/* Цена поставщика со скидкой — именно она станет закупочной на складе */}
                    {draft && <span className="prh-note">{t('включая скидку')}: <b>{money(discCost(form.base, form.disc))}</b></span>}
                  </div>
                </div>
                <div className="prh-f" data-tour="af.disc">
                  <label>{t('Скидка')}</label>
                  <div className="prh-ctl prh-disc">
                    <label className="prh-unit">
                      <NumberInput value={form.disc} onChange={(e) => setDisc(e.target.value)} onKeyDown={onEnter} placeholder="0" aria-label={t('Скидка, %')} />
                      <span>%</span>
                    </label>
                    <label className="prh-check">
                      <input type="checkbox" checked={st.discAll} onChange={(e) => toggleDiscAll(e.target.checked)} />
                      {t('На все товары')}
                    </label>
                  </div>
                </div>
                <div className="prh-f">
                  <label>{t('Срок годности')}</label>
                  <div className="prh-ctl">
                    <input type="date" value={form.expiryDate} onChange={(e) => setForm({ expiryDate: e.target.value })} onKeyDown={onEnter} disabled={!draft} aria-label={t('Срок годности')} />
                    <span className="prh-note">{t('Текущий остаток')}: <b>{chosen || editing ? stockText(products.find((p) => p.id === draft.productId) || {}) : '—'}</b></span>
                  </div>
                </div>
              </div>

              <div className="prh-av-col">
                {/* У товара из базы упаковка и категория — из карточки, менять их здесь нельзя;
                    у нового товара — задаются тут же */}
                <div className="prh-f" data-tour="af.pack">
                  <label htmlFor={nov ? 'prh-nov-upp' : undefined}>{t('Кол-во в упаковке')}</label>
                  <div className="prh-ctl">
                    {nov ? (
                      <>
                        <NumberInput
                          id="prh-nov-upp"
                          integer
                          className="prh-num-s"
                          value={novUppEditable ? form.novUpp : ''}
                          placeholder={novUppEditable ? '1' : '—'}
                          disabled={!novUppEditable}
                          onChange={numField('novUpp')}
                          onKeyDown={onEnter}
                          aria-label={t('Штук в упаковке')}
                        />
                        <select
                          id="prh-nov-unit"
                          value={novUnit}
                          aria-label={t('Единица измерения')}
                          // Дробная единица и штука — без «штук в упаковке»: штуки сверх упаковок обнуляем
                          onChange={(e) => setForm({ novUnit: e.target.value, ...(isVesovoy({ unit: e.target.value }) || e.target.value === 'шт' ? { novUpp: '1', pieces: '' } : {}) })}
                        >
                          {EDINICY.map((x) => (
                            <option key={x.v} value={x.v}>{t(x.v) === t(x.name) ? t(x.v) : `${t(x.v)} — ${t(x.name)}`}</option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <label className="prh-unit prh-ro">
                        <input readOnly tabIndex={-1} value={draft ? (draft.ves ? '—' : String(uppOf(draft))) : ''} placeholder="—" aria-label={t('Кол-во в упаковке')} />
                        <span>{draft?.ves ? t(draft.unit) : t('шт')}</span>
                      </label>
                    )}
                  </div>
                </div>
                <div className="prh-f">
                  <label htmlFor={nov ? 'prh-nov-cat' : undefined}>{t('Категория')}</label>
                  <div className="prh-ctl">
                    {nov ? (
                      <>
                        <select id="prh-nov-cat" value={form.novCat || ''} onChange={(e) => setForm({ novCat: e.target.value })} aria-label={t('Категория')}>
                          <option value="">{t('— без категории —')}</option>
                          {categoryOptions(form.novCat || '', catList).map((o) => <option key={o.value} value={o.value}>{t(o.value)}</option>)}
                        </select>
                        <AddCategoryBtn dialog={dialog} toast={toast} options={categoryNames(catList)} onPicked={(name) => setForm({ novCat: name })} />
                      </>
                    ) : (
                      <input className="prh-ro" readOnly tabIndex={-1} value={draft?.category || ''} placeholder="—" aria-label={t('Категория')} />
                    )}
                  </div>
                </div>
                <div className="prh-f" data-tour="af.markup">
                  <label className={draft && String(form.price).trim() === '' ? 'req' : ''}>
                    {t('Розничная цена')}
                    {mkShown !== '' && <em className="prh-mk-tag">{mkShown}%</em>}
                  </label>
                  <div className="prh-ctl prh-price">
                    <NumberInput
                      className={'prh-num' + (draft && !nov && num(form.price) !== form.price0 ? ' changed' : '')}
                      value={form.price}
                      onChange={(e) => setForm({ price: e.target.value, mk: null })}
                      onKeyDown={onEnter}
                      disabled={!draft}
                      aria-label={t('Розничная цена')}
                      title={draft && !nov && num(form.price) !== form.price0 ? `${t('Было')}: ${money(form.price0)}` : undefined}
                    />
                    <label className="prh-unit prh-mk">
                      <NumberInput
                        value={form.mk ?? markupOf(cost, form.price)}
                        onChange={(e) => setMarkup(e.target.value)}
                        onBlur={() => setForm({ mk: null })}
                        onKeyDown={onEnter}
                        disabled={!draft || !(cost > 0)}
                        placeholder="—"
                        aria-label={t('Наценка, %')}
                      />
                      <span>%</span>
                    </label>
                    {draft && !nov && num(form.price) !== form.price0 && <span className="prh-was">{t('Было')}: {money(form.price0)}</span>}
                  </div>
                </div>
                {draft?.div && (
                  <div className="prh-f prh-f-info">
                    <label>{t('Цена за 1 шт')}</label>
                    <b className="prh-val">{money(piecePrice(draft))}</b>
                  </div>
                )}
                <div className="prh-f prh-f-info">
                  <label>{t('Сумма строки')}</label>
                  <b className="prh-val">{draft ? money(lineTotal(draft)) : '—'}</b>
                </div>
              </div>
            </div>

            <div className="scan-hint prh-av-hint">
              <span className="ic">{nov ? <LuPackagePlus size={15} /> : <LuScanLine size={15} />}</span>
              {editing
                ? t('Правите строку из таблицы. Enter — сохранить её.')
                : nov
                  ? t('Нового товара нет в базе — он заведётся в «Товарах», когда нажмёте «Завести и добавить». Без штрихкода программа даст свой код.')
                  : t('USB-сканер работает как клавиатура. Незнакомый штрихкод — заведём товар прямо в этой форме')}
            </div>

            <div className="prh-add-actions prh-av-actions">
              <button type="button" className="btn ghost" onClick={clearForm}>
                <span className="ic"><LuEraser size={15} /></span> {editing ? t('Отмена') : t('Очистить форму')}
              </button>
              <button type="button" className="btn green" data-tour="af.add" onClick={commit} disabled={!draft || savingNew}>
                <span className="ic">{editing ? <LuCheck size={16} /> : nov ? <LuPackagePlus size={16} /> : <LuPlus size={16} />}</span>{' '}
                {editing ? t('Сохранить строку') : nov ? (savingNew ? t('Сохранение…') : t('Завести и добавить')) : t('Добавить')}
              </button>
              {editing && (
                <button type="button" className="btn ghost danger-text" onClick={() => { removeLine(editing.key); focusScan() }}>
                  <span className="ic"><LuTrash2 size={15} /></span> {t('Убрать строку')}
                </button>
              )}
            </div>
          </div>
        )}

        {sub === 'sel' && <SelectedPanel lines={lines} checked={checked} dialog={dialog} />}

        {sub === 'finish' && (
          <FinishPanel suppliers={suppliers} sup={sup} total={s.total} lines={lines} dialog={dialog} toast={toast} onSaved={onSaved} editLine={editLine} />
        )}
      </section>

    </div>
  )
}

// ── Отмеченные строки: одно действие сразу на все ──
function SelectedPanel({ lines, checked, dialog }) {
  const t = useT()
  const toast = useToast()
  const [disc, setDisc] = useState('')
  const [mk, setMk] = useState('')
  const [exp, setExp] = useState('')
  const marked = lines.filter((l) => checked.includes(l.key))
  const apply = (fn, done) => {
    setPrihod((x) => ({ lines: x.lines.map((l) => (x.checked.includes(l.key) ? fn(l) : l)) }))
    toast(done)
  }

  if (!marked.length) {
    return (
      <div className="prh-sel">
        <div className="note info">{t('Отметьте строки галочками в таблице — здесь им можно разом задать скидку, наценку или срок годности, или убрать их из прихода.')}</div>
        {lines.length > 0 && (
          <button type="button" className="btn ghost" onClick={() => setPrihod({ checked: lines.map((l) => l.key) })}>
            <span className="ic"><LuListChecks size={15} /></span> {t('Отметить все строки')}
          </button>
        )}
      </div>
    )
  }

  async function removeMarked() {
    const ok = await dialog.confirm({
      title: t('Убрать отмеченные строки?'),
      message: `${t('Отмечено строк')}: ${marked.length}. ${t('Они исчезнут из этого прихода, товары в базе останутся.')}`,
      danger: true,
      confirmText: t('Убрать'),
    })
    if (!ok) return
    setPrihod((x) => ({
      lines: x.lines.filter((l) => !x.checked.includes(l.key)),
      checked: [],
      ...(x.checked.includes(x.form.editKey) ? { form: blankForm() } : {}),
    }))
  }

  return (
    <div className="prh-sel">
      <div className="prh-sel-head">
        <b>{t('Отмечено строк')}: {marked.length} {t('из')} {lines.length}</b>
        <button type="button" className="btn ghost sm" onClick={() => setPrihod({ checked: lines.map((l) => l.key) })}>{t('Отметить все строки')}</button>
        <button type="button" className="btn ghost sm" onClick={() => setPrihod({ checked: [] })}>{t('Снять отметки')}</button>
      </div>
      <div className="prh-sel-grid">
        <div className="prh-f">
          <label>{t('Скидка, %')}</label>
          <div className="prh-sel-row">
            <NumberInput value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" />
            <button type="button" className="btn" disabled={String(disc).trim() === '' || num(disc) > 100} onClick={() => apply((l) => ({ ...l, disc }), t('Скидка задана отмеченным строкам'))}>{t('Задать')}</button>
          </div>
        </div>
        <div className="prh-f">
          <label>{t('Наценка, %')}</label>
          <div className="prh-sel-row">
            <NumberInput value={mk} onChange={(e) => setMk(e.target.value)} placeholder="0" />
            <button
              type="button"
              className="btn"
              disabled={String(mk).trim() === ''}
              onClick={() => apply((l) => { const p = priceFromMarkup(lineCost(l), mk); return p !== null ? { ...l, price: String(p) } : l }, t('Цена продажи пересчитана по наценке'))}
            >
              {t('Задать')}
            </button>
          </div>
        </div>
        <div className="prh-f">
          <label>{t('Срок годности')}</label>
          <div className="prh-sel-row">
            <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
            <button type="button" className="btn" disabled={!exp} onClick={() => apply((l) => ({ ...l, expiryDate: exp }), t('Срок годности задан отмеченным строкам'))}>{t('Задать')}</button>
          </div>
        </div>
      </div>
      <div className="prh-add-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn ghost danger-text" onClick={removeMarked}>
          <span className="ic"><LuTrash2 size={15} /></span> {t('Убрать отмеченные из прихода')}
        </button>
      </div>
    </div>
  )
}

// ── Сохранить поступление: поставщик, чем заплатили, «Оприходовать» ──
function FinishPanel({ suppliers, sup, total, lines, dialog, toast, onSaved, editLine }) {
  const t = useT()
  const can = useCan()
  const st = usePrihod()
  const { method, paid, fromCash, sourceId } = st.pay
  const sources = useCashSources()
  const tills = useMemo(() => sources || [], [sources])
  // Касса по умолчанию — касса сайта (без устройства), иначе первая открытая
  useEffect(() => {
    if (tills.length && !tills.some((x) => x.shiftId === sourceId)) setPay({ sourceId: (tills.find((x) => !x.deviceId) || tills[0]).shiftId })
  }, [tills, sourceId])

  function submit() {
    if (!lines.length) return toast(tr('Добавьте хотя бы один товар'), 'err')
    for (const l of lines) {
      const problem = lineProblem(l)
      if (problem) {
        toast(`«${l.name}»: ${tr(problem)}`, 'err')
        return editLine(l)
      }
    }
    if (!method) return toast(tr('Выберите, чем заплатили поставщику'), 'err')
    if ((method === 'cash' || method === 'debt') && !sup) return toast(tr('Для этого способа выберите поставщика из справочника'), 'err')
    const debt = method === 'debt' ? Math.max(0, total - Math.max(0, Number(paid) || 0)) : 0
    const paidNow = method === 'debt' ? Math.min(Math.max(0, Number(paid) || 0), total) : 0
    const paidCash = method === 'cash' ? total : fromCash ? paidNow : 0
    if (paidCash > 0 && !tills.length) return toast(tr('Нет открытой смены — из кассы взять нечего.'), 'err')
    try {
      // Мгновенно: склад пополняется сразу; при ошибке сети — откат и сообщение
      receiveArrival({
        payMethod: method,
        paidCash,
        shiftId: paidCash > 0 ? sourceId || '' : '',
        supplier: sup?.name || '',
        supplierId: sup?.id || '',
        debt,
        items: lines.map(toItem),
      }).catch((e) => toast(e.message, 'err'))
      toast(tr('Приход оприходован, склад пополнен'))
      resetDraft()
      onSaved?.()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function startOver() {
    const ok = await dialog.confirm({
      title: t('Начать приход заново?'),
      message: t('Все строки этого прихода будут убраны. Товары в базе останутся.'),
      danger: true,
      confirmText: t('Начать заново'),
    })
    if (ok) resetDraft()
  }

  return (
    <div className="prh-finish">
      <div className="prh-finish-cols">
        <div>
          <SupplierPick
            suppliers={suppliers}
            value={st.supplierId}
            onChange={(id) => setPrihod({ supplierId: id })}
            dialog={dialog}
            toast={toast}
            tour="af.supplier"
            canAdd={can('suppliers.edit')}
          />
          <PayBlock tills={tills} total={total} canDebt={can('arrivals.debt')} tour="af.credit" />
        </div>
        <div className="prh-finish-total">
          <span>{t('К оплате поставщику')}</span>
          <b>{money(total)}</b>
          <small>{lines.length} {t('поз.')}{sup ? ` · ${sup.name}` : ''}</small>
          <button type="button" className="btn green big" data-tour="af.submit" disabled={!lines.length} onClick={submit}>
            <span className="ic"><LuCheck size={18} /></span> {t('Оприходовать')}
          </button>
          {lines.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={startOver}>
              <span className="ic"><LuRotateCcw size={14} /></span> {t('Начать заново')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Чем заплатили поставщику ──
// Четыре кнопки: из кассы (деньги уходят из ящика открытой смены — записывается
// оплата поставщику и попадает в Z-отчёт), наличными мимо кассы, картой, в долг
// (с полем «оплачено сейчас»; оплаченную часть тоже можно взять из ящика)
function PayBlock({ tills, total, canDebt, tour }) {
  const st = usePrihod()
  const { method, paid, fromCash, sourceId } = st.pay
  const debt = Math.max(0, total - Math.max(0, Number(paid) || 0))
  const KNOPKI = [
    ['cash', tr('Из кассы'), LuCalculator],
    ['own', tr('Наличными'), LuBanknote],
    ['card', tr('Картой'), LuCreditCard],
    ...(canDebt ? [['debt', tr('В долг'), LuClock]] : []),
  ]
  const nuzhenYashik = method === 'cash' || (method === 'debt' && fromCash)
  return (
    <div data-tour={tour} style={{ margin: '4px 0 4px' }}>
      <label style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>{tr('Чем заплатили')}</label>
      <div className="arr-pay">
        {KNOPKI.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            className={'arr-pay-btn' + (method === key ? ' active' : '')}
            disabled={key === 'cash' && !tills.length}
            title={key === 'cash' && !tills.length ? tr('Нет открытой смены — из кассы взять нечего.') : undefined}
            onClick={() => setPay({ method: key })}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {!method && <div className="arr-pay-hint">{tr('Выберите, чем заплатили поставщику')}</div>}
      {method === 'debt' && (
        <div className="prh-debt-row">
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>{tr('Оплачено сейчас (сомони)')}</label>
            <NumberInput value={paid} placeholder="0" onChange={(e) => setPay({ paid: e.target.value })} />
          </div>
          <div className="total-row" style={{ flex: 1, margin: '0 0 6px' }}>
            <span>{tr('В долг поставщику')}</span>
            <span style={{ color: 'var(--danger)' }}>{money(debt)}</span>
          </div>
        </div>
      )}
      {method === 'debt' && Number(paid) > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginTop: 8 }}>
          <input type="checkbox" checked={fromCash} disabled={!tills.length} onChange={(e) => setPay({ fromCash: e.target.checked })} style={{ width: 16, height: 16 }} />
          {tr('оплаченное — из кассы')}
          {!tills.length && <span className="tag-cat">{tr('Нет открытой смены — из кассы взять нечего.')}</span>}
        </label>
      )}
      {nuzhenYashik && tills.length > 1 && (
        <div className="field" style={{ maxWidth: 320, marginTop: 8, marginBottom: 0 }}>
          <label>{tr('Из какой кассы')}</label>
          <select value={sourceId} onChange={(e) => setPay({ sourceId: e.target.value })}>
            {tills.map((x) => <option key={x.shiftId} value={x.shiftId}>{x.label || sourceName(x, tr)}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}

