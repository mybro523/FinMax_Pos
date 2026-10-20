import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LuBanknote, LuCreditCard, LuClock, LuCalculator, LuTrash2, LuScanLine, LuPackagePlus, LuEraser,
  LuPlus, LuCheck, LuListChecks, LuReceipt, LuSearch, LuRotateCcw,
} from 'react-icons/lu'
import { useToast, useDialog } from '../../components/ui'
import NumberInput from '../../components/NumberInput'
import NewProductModal from '../../components/NewProductModal'
import { productPayload } from '../../components/ProductForm'
import { useCashSources, sourceName } from '../../components/SupplierMoney'
import { db, money, stockText } from '../../db/store'
import { receiveArrival } from '../../db/ops'
import { useCan } from '../../db/auth'
import { useT, translate as tr } from '../../lib/i18n'
import { normalizeScan, canonBarcode } from '../../lib/scan'
import { beepOk, beepError } from '../../lib/sound'
import { isVesovoy } from '../../lib/units'
import { priceFromMarkup, markupOf } from '../../lib/pricing'
import {
  lineFromProduct, lineCost, lineTotal, lineRetail, summary, qtyText, packText, lineProblem, toItem,
  piecePrice, discCost, n2, pct, num,
} from '../../lib/prihod'
import { usePrihod, setPrihod, setForm, setPay, resetDraft, blankForm } from './store'
import { SupplierPick } from './SupplierPick'
import ProductPick from './ProductPick'

// ── Новое поступление ──
// Как в привычных программах приёмки: по центру — накладная таблицей, справа — итоги
// тёмно-синей панелью, снизу — форма. Форма добавляет товар (сканер стреляет в поле
// «Штрихкод», название встаёт в «Наименование» само, курсор уходит в количество,
// Enter — строка в таблице), правит строку
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
  const qtyRef = useRef(null)
  const [focusQty, setFocusQty] = useState(0)
  const [newProduct, setNewProduct] = useState(null)
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
  const baseLine = editing || (chosen ? lineFromProduct(chosen) : null)
  const draft = baseLine
    ? { ...baseLine, qty: form.qty, pieces: form.pieces, base: form.base, disc: form.disc, price: form.price, expiryDate: form.expiryDate }
    : null

  function editLine(l) {
    setPrihod({
      sub: 'add',
      form: { productId: l.productId, code: l.barcode || '', q: l.name, qty: l.qty, pieces: l.pieces, base: l.base, disc: l.disc, price: l.price, price0: l.price0, mk: null, expiryDate: l.expiryDate, editKey: l.key },
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
    setForm({ productId: p.id, code: p.barcode || '', q: p.name, qty: l.qty, pieces: '', base: l.base, disc, price: l.price, price0: l.price0, mk: null, expiryDate: '', editKey: '' })
    beepOk()
    setFocusQty((n) => n + 1)
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

  // ── Товара нет в базе: заводим карточку и сразу ставим строкой в этот приход ──
  // «Остаток» из карточки — это сколько пришло (весовой — в килограммах),
  // закупочная — цена поставщика. Сам товар заводится с нулём: остаток даст приход
  async function saveNewProduct(f) {
    if (!f.name.trim() || !(f.barcode || '').trim()) return toast(tr('Укажите название и штрихкод'), 'err')
    const data = productPayload(f, { normalizeBarcode: normalizeScan })
    const dup = products.find((p) => canonBarcode(p.barcode) === canonBarcode(data.barcode))
    if (dup) return toast(tr('Такой штрихкод уже есть') + ': ' + dup.name, 'err')
    try {
      const created = await db.push('products', { ...data, stock: 0, looseUnits: 0 })
      setNewProduct(null)
      const raw = String(f.stock ?? '').trim()
      const n = Number(raw.replace(',', '.'))
      const l = lineFromProduct(created, { disc: st.discAll ? form.disc : '' })
      l.qty = !raw || !(n > 0) ? '1' : isVesovoy(created) ? raw : String(Math.max(1, Math.floor(n)))
      setPrihod((x) => ({ lines: [...x.lines, l], flash: l.key, form: { ...blankForm(), disc: x.discAll ? x.form.disc : '' } }))
      toast(`«${created.name}» ${tr('добавлен в базу')}`)
      focusScan()
    } catch (e) {
      toast(tr(e.message), 'err')
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
            <div className="prh-add-main">
              <ProductPick
                ids={{ code: 'prh-q', name: 'prh-name' }}
                codeTour="af.scan"
                nameTour="af.name"
                codeRef={scanRef}
                products={products}
                code={form.code || ''}
                name={form.q}
                chosen={chosen}
                // Поменяли одно поле — другое относится к прежнему товару и очищается
                onCode={(v) => setForm({ code: v, q: '', productId: '' })}
                onName={(v) => setForm({ q: v, code: '', productId: '' })}
                readOnly={!!editing}
                onPick={choose}
                onEnterChosen={() => setFocusQty((n) => n + 1)}
                onUnknownCode={(barcode) => (can('products.create') ? setNewProduct({ barcode }) : toast(tr('Товар с таким штрихкодом не найден'), 'err'))}
                onUnknownName={(name) => (can('products.create') ? setNewProduct({ barcode: '', name }) : toast(tr('Товар не найден'), 'err'))}
                hint={
                  <>
                    <span className="ic"><LuScanLine size={15} /></span>
                    {editing ? t('Правите строку из таблицы. Enter — сохранить её.') : t('USB-сканер работает как клавиатура. Незнакомый штрихкод — заведём карточку прямо здесь')}
                  </>
                }
              />
              {can('products.create') && !editing && (
                <button type="button" className="btn ghost prh-newprod" data-tour="af.newprod" onClick={() => setNewProduct({ barcode: '' })}>
                  <span className="ic"><LuPackagePlus size={15} /></span> {t('Новый товар')}
                </button>
              )}
            </div>

            <div className="prh-add-cols">
              <div className="prh-add-col">
                <div className="prh-f" data-tour="af.qty">
                  <label>{t('Количество')}</label>
                  <div className="prh-qty">
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
                  <label className={draft && String(form.base).trim() === '' ? 'req' : ''}>{t('Цена поставщика')}</label>
                  <NumberInput value={form.base} onChange={numField('base')} onKeyDown={onEnter} disabled={!draft} placeholder="0" />
                </div>
                <div className="prh-f" data-tour="af.disc">
                  <label>{t('Скидка, %')}</label>
                  <div className="prh-disc">
                    <NumberInput value={form.disc} onChange={(e) => setDisc(e.target.value)} onKeyDown={onEnter} placeholder="0" aria-label={t('Скидка, %')} />
                    <label className="prh-check">
                      <input type="checkbox" checked={st.discAll} onChange={(e) => toggleDiscAll(e.target.checked)} />
                      {t('На все товары')}
                    </label>
                  </div>
                </div>
                <div className="prh-f">
                  <label>{t('Срок годности')}</label>
                  <input type="date" value={form.expiryDate} onChange={(e) => setForm({ expiryDate: e.target.value })} onKeyDown={onEnter} disabled={!draft} />
                </div>
              </div>

              <div className="prh-add-col">
                <div className="prh-info">
                  <div><span>{t('В упаковке')}</span><b>{draft ? packText(draft, t) : '—'}</b></div>
                  <div><span>{t('Категория')}</span><b>{draft?.category || '—'}</b></div>
                  <div><span>{t('На складе')}</span><b>{chosen || editing ? stockText(products.find((p) => p.id === draft.productId) || {}) : '—'}</b></div>
                  <div><span>{t('Цена со скидкой')}</span><b>{draft ? money(discCost(form.base, form.disc)) : '—'}</b></div>
                </div>
                <div className="prh-f" data-tour="af.markup">
                  <label>{t('Розничная цена')}</label>
                  <div className="prh-price">
                    <NumberInput
                      className={draft && num(form.price) !== form.price0 ? 'changed' : ''}
                      value={form.price}
                      onChange={(e) => setForm({ price: e.target.value, mk: null })}
                      onKeyDown={onEnter}
                      disabled={!draft}
                      title={draft && num(form.price) !== form.price0 ? `${t('Было')}: ${money(form.price0)}` : undefined}
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
                  </div>
                  {draft && num(form.price) !== form.price0 && <div className="prh-was">{t('Было')}: {money(form.price0)}</div>}
                </div>
                {draft?.div && (
                  <div className="prh-info">
                    <div><span>{t('Цена за 1 шт')}</span><b>{money(piecePrice(draft))}</b></div>
                  </div>
                )}
                <div className="prh-info">
                  <div><span>{t('Сумма строки')}</span><b>{draft ? money(lineTotal(draft)) : '—'}</b></div>
                </div>
              </div>
            </div>

            <div className="prh-add-actions">
              <button type="button" className="btn ghost" onClick={clearForm}>
                <span className="ic"><LuEraser size={15} /></span> {editing ? t('Отмена') : t('Очистить форму')}
              </button>
              {editing && (
                <button type="button" className="btn ghost danger-text" onClick={() => { removeLine(editing.key); focusScan() }}>
                  <span className="ic"><LuTrash2 size={15} /></span> {t('Убрать строку')}
                </button>
              )}
              <button type="button" className="btn green" data-tour="af.add" onClick={commit} disabled={!draft}>
                <span className="ic">{editing ? <LuCheck size={16} /> : <LuPlus size={16} />}</span> {editing ? t('Сохранить строку') : t('Добавить')}
              </button>
            </div>
          </div>
        )}

        {sub === 'sel' && <SelectedPanel lines={lines} checked={checked} dialog={dialog} />}

        {sub === 'finish' && (
          <FinishPanel suppliers={suppliers} sup={sup} total={s.total} lines={lines} dialog={dialog} toast={toast} onSaved={onSaved} editLine={editLine} />
        )}
      </section>

      {newProduct && (
        <NewProductModal
          barcode={newProduct.barcode}
          name={newProduct.name}
          arrival
          note={tr('Заполните карточку — товар заведётся и сразу встанет в этот приход. «Остаток» и закупочная цена из карточки станут количеством и ценой в строке прихода, там их можно поправить (весовой — в килограммах).')}
          confirmText={tr('Завести и добавить в приход')}
          onSave={saveNewProduct}
          onClose={() => {
            setNewProduct(null)
            focusScan()
          }}
        />
      )}
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

