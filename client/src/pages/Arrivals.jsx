import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { LuBanknote, LuCreditCard, LuClock, LuCalculator, LuPlus, LuTrash2, LuScanLine, LuPackagePlus, LuPencil } from 'react-icons/lu'
import Layout from '../components/Layout'
import { isVesovoy, kgText, gramsOfKg } from '../lib/units'
import { Modal, useToast, useDialog } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import { JournalFilter, JournalCount, useJournalFilter } from '../components/JournalFilter'
import { useCollection, money, db } from '../db/store'
import { api } from '../db/api'
import { receiveArrival, findByBarcode, getArrival, updateArrival, deleteArrival } from '../db/ops'
import { useCan } from '../db/auth'
import { fmtDateTime } from '../lib/time'
import { useT, translate as tr } from '../lib/i18n'
import { normalizeScan } from '../lib/scan'
import { beepOk, beepError } from '../lib/sound'
import NumberInput from '../components/NumberInput'
import NewProductModal from '../components/NewProductModal'
import { productPayload } from '../components/ProductForm'
import { canonBarcode } from '../lib/scan'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import { skachatXlsx } from '../lib/excel'
import { getUser } from '../db/auth'

export default function Arrivals() {
  const arrivals = useCollection('arrivals')
  const products = useCollection('products')
  const suppliers = useCollection('suppliers')
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(null)
  const [edit, setEdit] = useState(null) // приход, загруженный для правки
  const [busy, setBusy] = useState(false)

  // Оформить приход может и кассир, а переписать или стереть уже оформленный —
  // только владелец: иначе недостачу легко спрятать, поправив вчерашний приход
  const can = useCan()

  // Для правки нужен не тот приход, что лежит в списке, а подробный: с ним
  // приходит, сколько от каждой строки уже продано и ниже чего нельзя опускать
  async function openEdit(a) {
    setBusy(true)
    try {
      setEdit(await getArrival(a.id))
      setView(null)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function askDelete(a) {
    const позиций = a.items?.length || 0
    const ok = await dialog.confirm({
      title: t('Удалить приход?'),
      message:
        `${t('Поставщик')}: ${a.supplier} · ${money(a.total)} · ${позиций} ${t('поз.')}
` +
        t('Со склада снимется всё, что от этого прихода ещё не продано, а закупочная цена товаров пересчитается по оставшимся партиям. Проданное останется в чеках как есть.'),
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    setView(null)
    try {
      await deleteArrival(a.id)
      toast(t('Приход удалён, склад пересчитан'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  // Поиск и период по журналу поставок: «когда приходил вот этот товар»
  // раньше выяснялось только перелистыванием
  const journal = useJournalFilter('arrivals', {
    textOf: (a) => (a.supplier || '') + ' ' + (a.items || []).map((i) => i.name).join(' '),
  })

  const pg = usePagination(journal.rows, 10, journal.controls.period + journal.controls.q)

  // Выгрузка и печать журнала — то, что отфильтровано (период и поиск), все страницы
  const exCols = [
    { header: t('Дата'), key: 'date', width: 18 },
    { header: t('Поставщик'), key: 'supplier', width: 30 },
    { header: t('Оплата'), key: 'pay', width: 20 },
    { header: t('Позиций'), key: 'poz', width: 10, num: true },
    { header: t('Сумма'), key: 'total', width: 14, money: true },
  ]
  const sposob = (a) =>
    a.payMethod === 'cash' ? t('Из кассы')
      : a.payMethod === 'own' ? t('Наличными')
        : a.payMethod === 'card' ? t('Картой')
          : Number(a.debt) > 0 ? `${t('В долг')} (${money(a.debt)})` : '—'
  const exRows = journal.rows.map((a) => ({
    date: fmtDateTime(a.date),
    supplier: a.supplier || '—',
    pay: sposob(a),
    poz: (a.items || []).length,
    total: Number(a.total) || 0,
  }))
  const exItogi = { date: t('Итого'), poz: journal.rows.reduce((s, a) => s + (a.items || []).length, 0), total: journal.rows.reduce((s, a) => s + (Number(a.total) || 0), 0) }
  const exPodzag = `${t('Найдено записей')}: ${journal.rows.length}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Приход товара'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Приход товара')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout
      title={t('Приход товара')}
      subtitle={`${arrivals.length} ${t('поставок')}`}
      actions={<>
        <ExportPechat onExcel={exportExcel} />
        {can('arrivals.create') && <button className="btn" data-tour="arr.new" onClick={() => setOpen(true)}><span className="ic"><LuPlus size={16} /></span> {t('Новый приход')}</button>}
      </>}
    >
      <PrintSheet zagolovok={t('Приход товара')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />
      <div className="panel" style={{ padding: 0 }}>
        <div data-tour="arr.filter" style={{ padding: '16px 16px 0' }}>
          <JournalFilter controls={journal.controls} placeholder={t('Поиск по поставщику или товару…')} />
          <JournalCount rows={journal.rows.length} loading={journal.loading} />
        </div>
        <table>
          <thead>
            <tr><th>{t('Дата')}</th><th>{t('Поставщик')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('Сумма')}</th><th></th></tr>
          </thead>
          <tbody>
            {pg.slice.map((a) => (
              <tr key={a.id}>
                <td>{fmtDateTime(a.date)}</td>
                <td>
                  <b>{a.supplier}</b>
                  {Number(a.debt) > 0 && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('в долг')} {money(a.debt)}</div>}
                  {a.payMethod === 'cash' && <div className="tag-cat">{t('оплачен из кассы')}</div>}
                  {a.payMethod === 'own' && <div className="tag-cat">{t('наличными')}</div>}
                  {a.payMethod === 'card' && <div className="tag-cat">{t('картой')}</div>}
                </td>
                <td className="num">{a.items.length}</td>
                <td className="num"><b>{money(a.total)}</b></td>
                <td className="num"><button className="btn ghost sm" data-tour="arr.details" onClick={() => setView(a)}>{t('Подробно')}</button></td>
              </tr>
            ))}
            {journal.rows.length === 0 && !journal.loading && (
              <tr><td colSpan="5" className="empty">{arrivals.length ? t('За выбранный период ничего не найдено') : t('Приходов пока нет. Нажмите «Новый приход».')}</td></tr>
            )}
          </tbody>
        </table>
        <Pagination {...pg} />
      </div>

      {open && (
        <ArrivalForm
          products={products}
          suppliers={suppliers}
          toast={toast}
          onClose={() => setOpen(false)}
          onSave={(data) => {
            try {
              // мгновенно: склад пополняется сразу; при ошибке сети — откат и тост
              receiveArrival(data).catch((e) => toast(e.message, 'err'))
              toast(t('Приход оприходован, склад пополнен'))
              setOpen(false)
            } catch (e) {
              toast(e.message, 'err')
            }
          }}
        />
      )}

      {view && (
        <Modal title={t('Приход · детали')} onClose={() => setView(null)}>
          <div className="tag-cat" style={{ marginBottom: 12 }}>
            {view.supplier} · {fmtDateTime(view.date)}
          </div>
          <table>
            <thead><tr><th>{t('Товар')}</th><th className="num">{t('Кол-во')}</th><th className="num">{t('Закуп.')}</th><th className="num">{t('Сумма')}</th></tr></thead>
            <tbody>
              {view.items.map((i, n) => (
                <tr key={n}>
                  <td>{i.name}</td>
                  <td className="num">{i.pieces > 0 ? `${kgText(i.qty * 1000 + i.pieces)} ${t('кг')}` : i.qty}</td>
                  <td className="num">{money(i.cost)}</td>
                  <td className="num">{money(i.cost * (i.qty + (i.pieces || 0) / 1000))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="total-row big"><span>{t('Итого')}</span><span>{money(view.total)}</span></div>
          {Number(view.debt) > 0 && (
            <>
              <div className="total-row"><span>{t('Оплачено при получении')}</span><span>{money(Number(view.total) - Number(view.debt))}</span></div>
              <div className="total-row"><span>{t('В долг поставщику')}</span><span style={{ color: 'var(--danger)' }}>{money(view.debt)}</span></div>
            </>
          )}

          {/* Кассиру этих кнопок не видно, и запрос от него сервер тоже отклонит */}
          {can('arrivals.edit') && (
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={() => askDelete(view)} disabled={busy}>
                <span className="ic"><LuTrash2 size={16} /></span> {t('Удалить')}
              </button>
              <button className="btn" onClick={() => openEdit(view)} disabled={busy}>
                <span className="ic"><LuPencil size={16} /></span> {t('Изменить')}
              </button>
            </div>
          )}
        </Modal>
      )}

      {edit && (
        <EditArrival
          arrival={edit}
          suppliers={suppliers}
          t={t}
          onClose={() => setEdit(null)}
          onSave={async (data) => {
            try {
              await updateArrival(edit.id, data)
              toast(t('Приход изменён, склад пересчитан'))
              setEdit(null)
            } catch (e) {
              toast(e.message, 'err')
            }
          }}
        />
      )}
    </Layout>
  )
}

// Приёмка идёт коробка за коробкой, поэтому работает как касса: сканер стреляет
// в одно поле, товар сам встаёт строкой, а незнакомый штрихкод заводится на месте.
function ArrivalForm({ products, suppliers, toast, onClose, onSave }) {
  const can = useCan()
  const dialog = useDialog()
  const [supplierId, setSupplierId] = useState('')
  // Чем заплатили поставщику: из кассы, своими наличными, картой или в долг.
  // Пока не выбрано — приход не проводится, как и просил владелец
  const [payMethod, setPayMethod] = useState('')
  const [paid, setPaid] = useState('') // оплачено сейчас (для «в долг»)
  const [paidFromCash, setPaidFromCash] = useState(false) // оплаченное — из ящика кассы
  // Открытые смены, из ящика которых можно взять деньги
  const [tills, setTills] = useState([])
  const [sourceId, setSourceId] = useState('')
  useEffect(() => {
    let alive = true
    api
      .get('/shifts/cash-sources')
      .then((list) => {
        if (!alive) return
        setTills(list || [])
        setSourceId(((list || []).find((x) => !x.deviceId) || (list || [])[0])?.shiftId || '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const [lines, setLines] = useState([])
  const [pick, setPick] = useState('')
  const [code, setCode] = useState('')
  const [newProduct, setNewProduct] = useState(null) // незнакомый штрихкод — заводим карточку
  const [flash, setFlash] = useState(null) // подсветить строку, которая уже в приходе
  const [focusId, setFocusId] = useState(null) // куда поставить курсор после добавления

  const scanRef = useRef(null)
  const qtyRefs = useRef({})
  const focusScanner = useCallback(() => scanRef.current?.focus(), [])

  // После добавления курсор уходит в «Кол-во»: набрал число — и стреляй дальше
  useEffect(() => {
    if (!focusId) return
    const el = qtyRefs.current[focusId]
    if (el) {
      el.focus()
      el.select()
    }
    setFocusId(null)
  }, [focusId, lines.length])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(id)
  }, [flash])

  const matches = (v) => {
    const q = String(v || '').trim().toLowerCase()
    if (!q) return []
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.barcode.includes(q)).slice(0, 6)
  }

  // Считаем от текущего списка товаров, а не запоминаем в момент набора: иначе
  // подсказки, набранные до прихода данных, так и остались бы пустыми
  const suggest = useMemo(() => matches(code), [code, products]) // eslint-disable-line react-hooks/exhaustive-deps

  // Возвращает true, если товар реально добавлен новой строкой
  function addProduct(p) {
    if (lines.some((l) => l.productId === p.id)) {
      // Не задваиваем: показываем, где эта позиция, и ставим курсор в её количество
      toast(`«${p.name}» ${tr('уже в этом приходе')}`, 'err')
      beepError()
      setFlash(p.id)
      setFocusId(p.id)
      return false
    }
    setLines((ls) => [...ls, { productId: p.id, name: p.name, qty: 1, cost: p.cost, expiryDate: '', category: p.category, ves: isVesovoy(p) }])
    setFocusId(p.id)
    beepOk()
    return true
  }

  // Разбирает то, что пришло из сканера или было набрано руками
  function addByCode(raw) {
    const val = String(raw || '').trim()
    if (!val) return
    setCode('')

    const p = findByBarcode(val) // понимает и обычный штрихкод, и DataMatrix/QR маркировки
    if (p) return void addProduct(p)

    // Набрали название, а не код — берём первую подсказку
    const list = matches(val)
    if (list.length && val.replace(/\D/g, '').length < 6) return void addProduct(list[0])

    beepError()
    setNewProduct({ barcode: normalizeScan(val) })
  }

  function addLine() {
    if (!pick) {
      toast(tr('Сначала выберите товар из списка'), 'err')
      return
    }
    const p = products.find((x) => x.id === pick)
    if (p) addProduct(p)
    setPick('')
  }

  const upd = (id, k, v) => setLines((ls) => ls.map((l) => (l.productId === id ? { ...l, [k]: v } : l)))
  const rm = (id) => setLines((ls) => ls.filter((l) => l.productId !== id))

  // В поле количества мог «выстрелить» сканер: для количества и цены таких чисел не бывает.
  // Значение не подменяем, а возвращаем фокус сканеру — иначе штрихкод уехал бы в приход.
  const looksLikeScan = (v) => String(v).replace(/\D/g, '').length >= 8
  function updNum(id, key, v) {
    if (looksLikeScan(v)) {
      beepError()
      toast(tr('Это похоже на штрихкод — сканируйте ещё раз'), 'err')
      focusScanner()
      return
    }
    upd(id, key, v)
  }
  function onCellKey(e) {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      focusScanner()
    }
  }

  // Товара нет в базе: заводим карточку и сразу ставим строкой в этот же приход.
  // Остаток и закупочную здесь не спрашиваем — их даст сама строка прихода,
  // иначе количество учлось бы дважды: и в карточке, и приходом.
  async function saveNewProduct(form) {
    if (!form.name.trim() || !(form.barcode || '').trim()) return toast(tr('Укажите название и штрихкод'), 'err')
    const data = productPayload(form, { normalizeBarcode: normalizeScan })
    const dup = products.find((p) => canonBarcode(p.barcode) === canonBarcode(data.barcode))
    if (dup) return toast(tr('Такой штрихкод уже есть') + ': ' + dup.name, 'err')
    try {
      // Остаток принудительно нулевой: сколько пришло, скажет строка прихода
      const created = await db.push('products', { ...data, stock: 0, looseUnits: 0 })
      setNewProduct(null)
      addProduct(created)
      toast(`«${created.name}» ${tr('добавлен в базу')}`)
      focusScanner()
    } catch (e) {
      toast(tr(e.message), 'err')
    }
  }


  const total = lines.reduce((s, l) => s + (Number(l.cost) || 0) * (l.ves ? gramsOfKg(l.qty) / 1000 : Number(l.qty) || 0), 0)

  function submit() {
    // Валидация: целое кол-во >= 1 (у весового — вес больше нуля), цена >= 0
    for (const l of lines) {
      const qty = Number(l.qty)
      if (l.ves) {
        if (gramsOfKg(l.qty) <= 0) {
          toast(`«${l.name}»: ${tr('укажите вес в килограммах')}`, 'err')
          return
        }
      } else if (!Number.isInteger(qty) || qty < 1) {
        toast(`«${l.name}»: ${tr('количество должно быть целым числом ≥ 1')}`, 'err')
        return
      }
      if (Number(l.cost) < 0 || Number.isNaN(Number(l.cost))) {
        toast(`«${l.name}»: ${tr('некорректная закупочная цена')}`, 'err')
        return
      }
    }
    const sup = suppliers.find((s) => s.id === supplierId)
    if (!payMethod) {
      toast(tr('Выберите, чем заплатили поставщику'), 'err')
      return
    }
    if ((payMethod === 'cash' || payMethod === 'debt') && !sup) {
      toast(tr('Для этого способа выберите поставщика из справочника'), 'err')
      return
    }
    const debt = payMethod === 'debt' ? Math.max(0, total - Math.max(0, Number(paid) || 0)) : 0
    const paidNow = payMethod === 'debt' ? Math.min(Math.max(0, Number(paid) || 0), total) : 0
    const paidCash = payMethod === 'cash' ? total : paidFromCash ? paidNow : 0
    if (paidCash > 0 && !tills.length) {
      toast(tr('Нет открытой смены — из кассы взять нечего.'), 'err')
      return
    }
    onSave({
      payMethod,
      paidCash,
      shiftId: paidCash > 0 ? sourceId || '' : '',
      supplier: sup?.name || '',
      supplierId: sup?.id || '',
      debt,
      items: lines.map((l) => {
        if (!l.ves) return l
        const g = gramsOfKg(l.qty)
        return { ...l, qty: Math.floor(g / 1000), pieces: g % 1000 }
      }),
    })
  }

  return (
    <Modal wide title={tr('Новый приход товара')} onClose={onClose}>
      <SupplierPick suppliers={suppliers} value={supplierId} onChange={setSupplierId} dialog={dialog} toast={toast} tour="af.supplier" />

      <div className="field" data-tour="af.scan">
        <label>{tr('Отсканируйте штрихкод или введите название')}</label>
        <input
          ref={scanRef}
          className="scan-input"
          value={code}
          autoFocus
          onChange={(e) => {
            setCode(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            addByCode(code)
          }}
          placeholder={tr('Наведите сканер на товар…')}
        />
        <div className="scan-hint">
          <span className="ic"><LuScanLine size={15} /></span>
          {tr('USB-сканер работает как клавиатура. Незнакомый штрихкод — заведём карточку прямо здесь')}
        </div>
        {suggest.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <tbody>
              {suggest.map((p) => (
                <tr
                  key={p.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    addProduct(p)
                    setCode('')
                  }}
                >
                  <td>
                    {p.name}
                    <div className="tag-cat">{p.barcode}</div>
                  </td>
                  <td className="num tag-cat">{tr('остаток')} {p.stock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="field" data-tour="af.pick">
        <label>{tr('Или выберите из списка')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{tr('— выберите товар —')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({tr('остаток')} {p.stock})</option>)}
          </select>
          <button className="btn icon" onClick={addLine}><LuPlus size={17} /></button>
          {/* Товара ещё нет в списке — карточка заводится прямо отсюда, не бросая приёмку */}
          <button className="btn ghost" data-tour="af.newprod" style={{ flexShrink: 0 }} onClick={() => setNewProduct({ barcode: '' })}>
            <span className="ic"><LuPackagePlus size={15} /></span> {tr('Новый товар')}
          </button>
        </div>
      </div>

      {lines.length > 0 && (
        <div className="arr-lines" data-tour="af.line">
          {lines.map((l) => (
            <div className={'arr-line' + (flash === l.productId ? ' arr-flash' : '')} key={l.productId}>
              <div className="arr-line-top">
                <span className="arr-line-name">{l.name}</span>
                <button className="btn ghost sm icon" onClick={() => rm(l.productId)} title={tr('Убрать из прихода')}>
                  <LuTrash2 size={15} />
                </button>
              </div>
              <div className="arr-fields">
                <label className="arr-f">
                  <span>{l.ves ? tr('Кг') : tr('Кол-во')}</span>
                  {/* Именно NumberInput, а не обычное поле: в остальной программе
                      минус и буквы в числа не попадают физически, а здесь стояло
                      обычное поле с нерабочим признаком integer — браузер такой
                      признак не понимает и просто ругался в консоли.
                      У весового товара количество — это килограммы с дробью */}
                  <NumberInput
                    ref={(el) => { qtyRefs.current[l.productId] = el }}
                    className="arr-qty"
                    integer={!l.ves}
                    value={l.qty}
                    onChange={(e) => updNum(l.productId, 'qty', e.target.value)}
                    onKeyDown={onCellKey}
                  />
                </label>
                <label className="arr-f">
                  <span>{tr('Закуп. цена')}</span>
                  <NumberInput
                    className="arr-cost"
                    value={l.cost}
                    onChange={(e) => updNum(l.productId, 'cost', e.target.value)}
                    onKeyDown={onCellKey}
                  />
                </label>
                <label className="arr-f">
                  <span>{tr('Срок годности')}</span>
                  <input
                    className="arr-exp" type="date"
                    value={l.expiryDate || ''}
                    onChange={(e) => upd(l.productId, 'expiryDate', e.target.value)}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="total-row big" data-tour="af.total"><span>{tr('Итого')}</span><span>{money(total)}</span></div>
      <PayBlock
        method={payMethod}
        setMethod={setPayMethod}
        paid={paid}
        setPaid={setPaid}
        fromCash={paidFromCash}
        setFromCash={setPaidFromCash}
        tills={tills}
        sourceId={sourceId}
        setSourceId={setSourceId}
        total={total}
        canDebt={can('arrivals.debt')}
        tour="af.credit"
      />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{tr('Отмена')}</button>
        <button className="btn" data-tour="af.submit" disabled={!lines.length} onClick={submit}>{tr('Оприходовать')}</button>
      </div>

      {newProduct && (
        <NewProductModal
          barcode={newProduct.barcode}
          hideStock
          note={tr('Заполните карточку — товар заведётся и сразу встанет в этот приход. Количество и закупочную цену введёте в строке прихода (весовой — в килограммах).')}
          confirmText={tr('Завести и добавить в приход')}
          onSave={saveNewProduct}
          onClose={() => {
            setNewProduct(null)
            focusScanner()
          }}
        />
      )}
    </Modal>
  )
}


// ── Правка прихода ──
//
// Тут важно не то, что можно поменять, а то, чего поменять уже нельзя. Приход
// не запись в журнале: он положил товар на полку, и часть этого товара мог
// забрать покупатель. Ниже проданного количество не опустить — упаковок нет
// физически. Поэтому у каждой строки написано, сколько от неё уже ушло.
//
// Цену и срок годности править можно всегда: они на остаток не влияют.
// ── Поставщик прихода ──
// Из справочника, а не свободным текстом: только так приход в долг ляжет на нужного
// поставщика. Нового заводят тут же — приёмку не бросают ради справочника
function SupplierPick({ suppliers, value, onChange, dialog, toast, tour }) {
  async function add() {
    const r = await dialog.prompt({
      title: tr('Новый поставщик'),
      fields: [
        { name: 'name', label: tr('Название'), placeholder: tr('Напр. Фарм-опт') },
        { name: 'phone', label: tr('Телефон') },
      ],
      confirmText: tr('Добавить'),
    })
    const name = (r?.name || '').trim()
    if (!r || !name) return
    const same = suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase())
    if (same) return onChange(same.id)
    try {
      const created = await db.push('suppliers', { name, phone: (r.phone || '').trim() })
      onChange(created.id)
      toast(tr('Поставщик добавлен'))
    } catch (e) {
      toast(tr(e.message), 'err')
    }
  }
  return (
    <div className="field" data-tour={tour}>
      <label>{tr('Поставщик')}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{tr('— без поставщика —')}</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="btn ghost icon" onClick={add} title={tr('Новый поставщик')} aria-label={tr('Новый поставщик')}><LuPlus size={17} /></button>
      </div>
    </div>
  )
}

// Оплачено ли сразу. Не всё — остаток становится долгом перед поставщиком
// ── Чем заплатили поставщику ──
// Четыре кнопки: из кассы (деньги уходят из ящика открытой смены — записывается
// оплата поставщику и попадает в Z-отчёт), наличными мимо кассы, картой, в долг
// (с полем «оплачено сейчас»; оплаченную часть тоже можно взять из ящика)
function PayBlock({ method, setMethod, paid, setPaid, fromCash, setFromCash, tills, sourceId, setSourceId, total, canDebt, tour }) {
  const debt = Math.max(0, total - Math.max(0, Number(paid) || 0))
  const KNOPKI = [
    ['cash', tr('Из кассы'), LuCalculator],
    ['own', tr('Наличными'), LuBanknote],
    ['card', tr('Картой'), LuCreditCard],
    ...(canDebt ? [['debt', tr('В долг'), LuClock]] : []),
  ]
  const nuzhenYashik = method === 'cash' || (method === 'debt' && fromCash)
  return (
    <div data-tour={tour} style={{ margin: '10px 0 4px' }}>
      <label style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>{tr('Чем заплатили')}</label>
      <div className="arr-pay">
        {KNOPKI.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            className={'arr-pay-btn' + (method === key ? ' active' : '')}
            disabled={key === 'cash' && !tills.length}
            title={key === 'cash' && !tills.length ? tr('Нет открытой смены — из кассы взять нечего.') : undefined}
            onClick={() => setMethod(key)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {!method && <div className="arr-pay-hint">{tr('Выберите, чем заплатили поставщику')}</div>}
      {method === 'debt' && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>{tr('Оплачено сейчас (сомони)')}</label>
            <NumberInput value={paid} placeholder="0" onChange={(e) => setPaid(e.target.value)} />
          </div>
          <div className="total-row" style={{ flex: 1, margin: '0 0 6px' }}>
            <span>{tr('В долг поставщику')}</span>
            <span style={{ color: 'var(--danger)' }}>{money(debt)}</span>
          </div>
        </div>
      )}
      {method === 'debt' && Number(paid) > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginTop: 8 }}>
          <input type="checkbox" checked={fromCash} disabled={!tills.length} onChange={(e) => setFromCash(e.target.checked)} style={{ width: 16, height: 16 }} />
          {tr('оплаченное — из кассы')}
          {!tills.length && <span className="tag-cat">{tr('Нет открытой смены — из кассы взять нечего.')}</span>}
        </label>
      )}
      {nuzhenYashik && tills.length > 1 && (
        <div className="field" style={{ maxWidth: 320, marginTop: 8, marginBottom: 0 }}>
          <label>{tr('Из какой кассы')}</label>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {tills.map((x) => <option key={x.shiftId} value={x.shiftId}>{x.label || x.deviceName || tr('Касса сайта')}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}

function CreditBlock({ credit, setCredit, paid, setPaid, total, tour }) {
  const debt = Math.max(0, total - Math.max(0, Number(paid) || 0))
  return (
    <div data-tour={tour} style={{ margin: '10px 0 4px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} style={{ width: 17, height: 17 }} />
        {tr('В долг (оплачено не полностью)')}
      </label>
      {credit && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>{tr('Оплачено сейчас (сомони)')}</label>
            <NumberInput value={paid} placeholder="0" onChange={(e) => setPaid(e.target.value)} />
          </div>
          <div className="total-row" style={{ flex: 1, margin: '0 0 6px' }}>
            <span>{tr('В долг поставщику')}</span>
            <span style={{ color: 'var(--danger)' }}>{money(debt)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function EditArrival({ arrival, suppliers, t, onClose, onSave }) {
  const dialog = useDialog()
  const toast = useToast()
  const [supplierId, setSupplierId] = useState(arrival.supplierId || '')
  const [credit, setCredit] = useState(Number(arrival.debt) > 0)
  const [paid, setPaid] = useState(String(Math.max(0, Number(arrival.total) - Number(arrival.debt || 0))))
  const [lines, setLines] = useState(() =>
    arrival.items.map((i) => {
      const ves = i.unit === 'кг'
      return {
        id: i.id,
        name: i.name,
        // Весовая строка правится в килограммах одним числом
        qty: ves ? String((i.qty * 1000 + (i.pieces || 0)) / 1000) : String(i.qty),
        ves,
        cost: String(i.cost),
        expiryDate: i.expiryDate || '',
        soldUnits: i.soldUnits || 0,
        minQty: i.minQty || 0,
        unitsPerPack: i.unitsPerPack || 1,
        exists: i.exists !== false,
      }
    }),
  )
  const [saving, setSaving] = useState(false)

  const set = (n, k, v) => setLines(lines.map((l, i) => (i === n ? { ...l, [k]: v } : l)))
  const kolvo = (l) => (l.ves ? gramsOfKg(l.qty) / 1000 : Number(l.qty) || 0)
  const total = lines.reduce((s, l) => s + (Number(l.cost) || 0) * kolvo(l), 0)

  // Проданное вернуть нельзя — эту строку сервер отвергнет, поэтому
  // не даём даже нажать и объясняем почему
  const плохо = lines.find((l) => (l.ves ? gramsOfKg(l.qty) < l.soldUnits : (Number(l.qty) || 0) < l.minQty))
  const пусто = !lines.some((l) => kolvo(l) > 0)

  async function save() {
    setSaving(true)
    try {
      const sup = suppliers.find((s) => s.id === supplierId)
      if (credit && !sup) {
        toast(t('Для прихода в долг выберите поставщика'), 'err')
        return
      }
      await onSave({
        supplier: sup?.name || '',
        supplierId: sup?.id || '',
        debt: credit ? Math.max(0, total - Math.max(0, Number(paid) || 0)) : 0,
        items: lines.map((l) => {
          const g = l.ves ? gramsOfKg(l.qty) : 0
          return {
            id: l.id,
            qty: l.ves ? Math.floor(g / 1000) : Math.max(0, Number(l.qty) || 0),
            ...(l.ves ? { pieces: g % 1000 } : {}),
            cost: Number(l.cost) || 0,
            ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}),
          }
        }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('Изменить приход')} onClose={onClose} wide>
      <div className="note info" style={{ marginBottom: 14 }}>
        {t('Склад и закупочная цена пересчитаются сразу. Прибыль по уже пробитым чекам не изменится: каждый чек хранит себестоимость на момент продажи, иначе вчерашние отчёты менялись бы задним числом.')}
      </div>

      <SupplierPick suppliers={suppliers} value={supplierId} onChange={setSupplierId} dialog={dialog} toast={toast} />

      <table>
        <thead>
          <tr>
            <th>{t('Товар')}</th>
            <th className="num">{t('Кол-во')}</th>
            <th className="num">{t('Закуп.')}</th>
            <th>{t('Срок годности')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, n) => (
            <tr key={l.id}>
              <td>
                <b>{l.name}</b>
                {l.soldUnits > 0 && (
                  <div className="tag-cat">
                    {t('уже продано')}: {l.soldUnits} {t('шт')}
                    {l.minQty > 0 ? ` · ${t('меньше')} ${l.minQty} ${t('уп')} ${t('нельзя')}` : ''}
                  </div>
                )}
                {!l.exists && <div className="tag-cat" style={{ color: 'var(--danger)' }}>{t('товар удалён из базы')}</div>}
                {(Number(l.qty) || 0) === 0 && <div className="tag-cat" style={{ color: 'var(--warn)' }}>{t('строка будет убрана')}</div>}
              </td>
              <td className="num" style={{ width: 92 }}>
                <NumberInput
                  integer={!l.ves}
                  className="disc-input"
                  value={l.qty}
                  onChange={(e) => set(n, 'qty', e.target.value)}
                />
              </td>
              <td className="num" style={{ width: 104 }}>
                <NumberInput
                  className="disc-input"
                  value={l.cost}
                  onChange={(e) => set(n, 'cost', e.target.value)}
                />
              </td>
              <td style={{ width: 168 }}>
                <input
                  type="date"
                  style={{ width: '100%' }}
                  value={l.expiryDate}
                  onChange={(e) => set(n, 'expiryDate', e.target.value)}
                  title={t('Пусто — срок останется прежним')}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="total-row big"><span>{t('Итого')}</span><span>{money(total)}</span></div>
      <CreditBlock credit={credit} setCredit={setCredit} paid={paid} setPaid={setPaid} total={total} />

      {плохо && (
        <div className="note err" style={{ marginTop: 10 }}>
          «{плохо.name}»: {t('уже продано')} {плохо.soldUnits} {t('шт')} — {t('меньше')} {плохо.minQty} {t('уп')} {t('поставить нельзя')}
        </div>
      )}
      {пусто && (
        <div className="note err" style={{ marginTop: 10 }}>
          {t('В приходе не осталось ни одной позиции. Чтобы убрать его целиком, удалите приход.')}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={saving}>{t('Отмена')}</button>
        <button className="btn" onClick={save} disabled={saving || !!плохо || пусто}>
          {saving ? t('Сохранение…') : t('Сохранить')}
        </button>
      </div>
    </Modal>
  )
}
