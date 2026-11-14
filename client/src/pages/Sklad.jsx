import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LuWarehouse, LuPackagePlus, LuStore, LuPencil, LuBoxes, LuWallet, LuBanknote, LuSearch, LuHistory } from 'react-icons/lu'
import Layout from '../components/Layout'
import Metric from '../components/Metric'
import StickyBar from '../components/StickyBar'
import { Modal, useToast } from '../components/ui'
import { Pagination, usePagination } from '../components/Pagination'
import ExportPechat, { PrintSheet } from '../components/ExportPechat'
import NumberInput from '../components/NumberInput'
import { PerenosForm, QtyFields, unitsFrom, partsFrom } from '../components/SkladPerenos'
import { useCollection, useCollectionIf, money, stockText } from '../db/store'
import { useCan, getUser } from '../db/auth'
import { skladEdit } from '../db/ops'
import { useT } from '../lib/i18n'
import { skladPoTovaram, skladItogo, skladUnitsOf } from '../lib/sklad'
import { poiskZapros, tovarPodhodit } from '../lib/poisk'
import { unitsText, packLabel } from '../lib/units'
import { fmtDate, fmtDateTime } from '../lib/time'
import { skachatXlsx } from '../lib/excel'

// ── Склад (1.8.0) ──
// Отдельный запас магазина: товар, который не помещается в торговый зал. Касса продаёт
// только из магазина; закончился товар на полке — его переносят со склада («В магазин»
// здесь или «Свой склад» в «Приходе товара»). На склад товар приходит приходом от
// поставщика с «Куда: Склад» или правкой остатка (так вносят то, что уже лежит на складе).
// Сверху — итоги (кликабельные), ниже — товары склада и история движений.

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export default function Sklad() {
  const t = useT()
  const can = useCan()
  const nav = useNavigate()
  const products = useCollection('products')
  const batches = useCollection('skladBatches')
  const moves = useCollection('skladMoves')
  const arrivals = useCollectionIf('arrivals', can('arrivals.view'))
  const mozhno = can('sklad.move')
  const [tab, setTab] = useState('tovary') // tovary | istoriya
  const [q, setQ] = useState('')
  const [okno, setOkno] = useState(null) // { kind: 'perenos' | 'edit' | 'card' | 'doc', … }

  const rows = useMemo(() => skladPoTovaram(batches, products), [batches, products])
  const itogo = useMemo(() => skladItogo(rows), [rows])
  const z = useMemo(() => poiskZapros(q), [q])
  const list = useMemo(() => rows.filter((r) => tovarPodhodit(z, `${r.product.name} ${r.product.dosage || ''} ${r.product.category || ''}`, r.product.barcode)), [rows, z])
  const pg = usePagination(list, 25, q)

  // История: документы склада и приходы на склад — вместе, новые сверху
  const istoriya = useMemo(() => {
    const docs = (moves || []).map((m) => ({
      id: m.id,
      date: m.date,
      kind: m.kind === 'edit' ? 'edit' : 'toShop',
      who: m.user?.name || '',
      items: (Array.isArray(m.items) ? m.items : []).map((i) => ({ productId: i.productId, name: i.name, units: num(i.units), cost: num(i.cost), expiryDate: i.expiryDate || null })),
      total: num(m.total),
      note: m.note || '',
    }))
    const prihody = (arrivals || [])
      .filter((a) => a.place === 'sklad')
      .map((a) => ({
        id: a.id,
        date: a.date,
        kind: 'arrival',
        who: a.user?.name || '',
        supplier: a.supplier || '',
        items: (a.items || []).map((i) => ({ productId: i.productId, name: i.name, units: num(i.qty) * Math.max(1, num(i.unitsPerPack) || 1) + num(i.pieces), cost: num(i.cost), upp: Math.max(1, num(i.unitsPerPack) || 1) })),
        total: num(a.total),
      }))
    return [...docs, ...prihody].sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [moves, arrivals])
  const pgH = usePagination(istoriya, 20, tab)
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const KIND = { toShop: t('Перенос в магазин'), edit: t('Правка остатка'), arrival: t('Приход на склад') }

  // ── Excel и печать: товары склада (с учётом поиска) ──
  const exCols = [
    { header: t('Товар'), key: 'name', width: 34 },
    { header: t('Штрихкод'), key: 'code', width: 16 },
    { header: t('На складе'), key: 'qty', width: 16 },
    { header: t('Ближайший срок'), key: 'exp', width: 14 },
    { header: t('По закупке'), key: 'cost', width: 14, money: true },
    { header: t('По цене продажи'), key: 'value', width: 15, money: true },
  ]
  const exRows = list.map((r) => ({
    name: r.product.name + (r.product.dosage ? ` · ${r.product.dosage}` : ''),
    code: r.product.barcode || '',
    qty: unitsText(r.units, r.product, t),
    exp: r.expiry ? fmtDate(r.expiry) : '',
    cost: r.cost,
    value: r.value,
  }))
  const exItog = skladItogo(list)
  const exItogi = { name: t('Итого'), cost: exItog.cost, value: exItog.value }
  const exPodzag = `${t('Товаров')}: ${list.length} · ${t('по закупке')} ${money(exItog.cost)} · ${t('по цене продажи')} ${money(exItog.value)}`
  const exportExcel = () =>
    skachatXlsx({ fayl: t('Склад'), zagolovok: `${getUser()?.pharmacy?.name || ''} — ${t('Склад')}`, podzag: exPodzag, cols: exCols, rows: exRows, itogi: exItogi })

  return (
    <Layout
      title={t('Склад')}
      actions={
        <>
          {can('arrivals.create') && (
            <button type="button" className="btn ghost" data-tour="sklad.prihod" data-testid="sklad-prihod" onClick={() => nav('/arrivals?kuda=sklad')}>
              <span className="ic"><LuPackagePlus size={16} /></span> {t('Приход на склад')}
            </button>
          )}
          {mozhno && (
            <button type="button" className="btn ghost" data-tour="sklad.edit" data-testid="sklad-edit-btn" onClick={() => setOkno({ kind: 'edit' })}>
              <span className="ic"><LuPencil size={16} /></span> {t('Поправить остаток')}
            </button>
          )}
          {mozhno && (
            <button type="button" className="btn" data-tour="sklad.to-shop" data-testid="sklad-to-shop" onClick={() => setOkno({ kind: 'perenos' })}>
              <span className="ic"><LuStore size={16} /></span> {t('В магазин')}
            </button>
          )}
          <ExportPechat onExcel={exportExcel} />
        </>
      }
    >
      <PrintSheet zagolovok={t('Склад')} podzag={exPodzag} cols={exCols} rows={exRows} itogi={exItogi} />

      <div className="cards" data-tour="sklad.cards" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 16 }}>
        <Metric testid="card-sklad-tovary" label={t('Товаров на складе')} value={itogo.tovarov} Icon={LuBoxes} tint="blue" sub={itogo.tovarov ? t('наименований') : t('На складе пока пусто')} onClick={() => setOkno({ kind: 'card', what: 'units' })} />
        <Metric testid="card-sklad-value" label={t('Остаток по цене продажи')} value={money(itogo.value)} Icon={LuWallet} tint="accent" sub={t('нажмите для деталей')} onClick={() => setOkno({ kind: 'card', what: 'value' })} />
        <Metric testid="card-sklad-cost" label={t('По закупке')} value={money(itogo.cost)} Icon={LuBanknote} tint="green" sub={t('нажмите для деталей')} onClick={() => setOkno({ kind: 'card', what: 'cost' })} />
      </div>

      <StickyBar>
        <div className="chips">
          <button className={'chip ' + (tab === 'tovary' ? 'active' : '')} data-testid="sklad-tab-tovary" onClick={() => setTab('tovary')}><LuWarehouse size={13} style={{ verticalAlign: '-2px' }} /> {t('Товары на складе')}</button>
          <button className={'chip ' + (tab === 'istoriya' ? 'active' : '')} data-tour="sklad.history" data-testid="sklad-tab-istoriya" onClick={() => setTab('istoriya')}><LuHistory size={13} style={{ verticalAlign: '-2px' }} /> {t('История')}</button>
        </div>
        {tab === 'tovary' && (
          <label className="prh-sheet-search" style={{ marginTop: 10, maxWidth: 420 }}>
            <LuSearch size={15} aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Название или штрихкод…')} aria-label={t('Поиск товара на складе')} data-testid="sklad-q" />
          </label>
        )}
      </StickyBar>

      {tab === 'tovary' ? (
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-cards-wrap">
            <table className="table-cards" data-tour="sklad.table" data-testid="sklad-table">
              <thead>
                <tr>
                  <th>{t('Товар')}</th><th className="num">{t('На складе')}</th><th className="num">{t('В магазине')}</th><th>{t('Ближайший срок')}</th>
                  <th className="num">{t('По закупке')}</th><th className="num">{t('По цене продажи')}</th>{mozhno && <th></th>}
                </tr>
              </thead>
              <tbody>
                {pg.slice.map((r) => (
                  <tr key={r.productId} data-testid="sklad-row">
                    <td className="cell-main">
                      <b>{r.product.name}</b>{r.product.dosage ? <span className="tag-cat"> · {r.product.dosage}</span> : null}
                      <div className="tag-cat">{r.product.barcode}{r.product.category ? ` · ${t(r.product.category)}` : ''}</div>
                    </td>
                    <td className="num" data-label={t('На складе')}><b>{unitsText(r.units, r.product, t)}</b></td>
                    <td className="num" data-label={t('В магазине')}>{stockText(r.product)}</td>
                    <td data-label={t('Ближайший срок')}>{r.expiry ? fmtDate(r.expiry) : '—'}</td>
                    <td className="num" data-label={t('По закупке')}>{money(r.cost)}</td>
                    <td className="num" data-label={t('По цене продажи')}><b>{money(r.value)}</b></td>
                    {mozhno && (
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn ghost sm" data-testid="sklad-row-edit" onClick={() => setOkno({ kind: 'edit', productId: r.productId })} title={t('Поправить остаток')}>
                          <LuPencil size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {!list.length && (
                  <tr><td colSpan={mozhno ? 7 : 6} className="empty">{rows.length ? t('Ничего не найдено') : t('На складе пока пусто. Оформите «Приход на склад» или поправьте остаток.')}</td></tr>
                )}
              </tbody>
              {list.length > 0 && (
                <tfoot>
                  <tr className="zak-total">
                    <td colSpan="4">{t('Итого')} · {t('Товаров')}: {list.length}</td>
                    <td className="num">{money(exItog.cost)}</td>
                    <td className="num">{money(exItog.value)}</td>
                    {mozhno && <td></td>}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <Pagination {...pg} />
        </div>
      ) : (
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-cards-wrap">
            <table className="table-cards" data-testid="sklad-istoriya">
              <thead>
                <tr><th>{t('Дата')}</th><th>{t('Документ')}</th><th className="num">{t('Позиций')}</th><th className="num">{t('По закупке')}</th><th>{t('Кто')}</th></tr>
              </thead>
              <tbody>
                {pgH.slice.map((d) => (
                  <tr key={d.kind + d.id} className="clickable" tabIndex={0} data-testid="sklad-doc" onClick={() => setOkno({ kind: 'doc', doc: d })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOkno({ kind: 'doc', doc: d }) } }}>
                    <td data-label={t('Дата')} style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(d.date)}</td>
                    <td className="cell-main">
                      <b>{KIND[d.kind]}</b>
                      {d.supplier ? <div className="tag-cat">{d.supplier}</div> : null}
                      {d.note ? <div className="tag-cat">{d.note}</div> : null}
                    </td>
                    <td className="num" data-label={t('Позиций')}>{d.items.length}</td>
                    <td className="num" data-label={t('По закупке')}>{money(d.total)}</td>
                    <td data-label={t('Кто')} className="tag-cat">{d.who || '—'}</td>
                  </tr>
                ))}
                {!istoriya.length && <tr><td colSpan="5" className="empty">{t('Движений по складу пока нет')}</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination {...pgH} />
        </div>
      )}

      {okno?.kind === 'perenos' && (
        <Modal wide title={<><span className="ic"><LuStore size={18} /></span>{t('Перенос со склада в магазин')}</>} onClose={() => setOkno(null)}>
          <PerenosForm rows={rows} compact onDone={() => setOkno(null)} onCancel={() => setOkno(null)} />
        </Modal>
      )}
      {okno?.kind === 'edit' && (
        <EditOkno products={products} batches={batches} productId={okno.productId} onClose={() => setOkno(null)} />
      )}
      {okno?.kind === 'card' && <CardOkno what={okno.what} rows={rows} itogo={itogo} onClose={() => setOkno(null)} />}
      {okno?.kind === 'doc' && <DocOkno doc={okno.doc} title={KIND[okno.doc.kind]} productById={productById} onClose={() => setOkno(null)} />}
    </Layout>
  )
}

// ── Карточка сверху: из чего сложилась цифра ──
function CardOkno({ what, rows, itogo, onClose }) {
  const t = useT()
  const key = what === 'value' ? 'value' : what === 'cost' ? 'cost' : 'units'
  const sorted = [...rows].sort((a, b) => (key === 'units' ? String(a.product.name).localeCompare(String(b.product.name), 'ru') : b[key] - a[key]))
  const title = what === 'value' ? t('Остаток по цене продажи') : what === 'cost' ? t('По закупке') : t('Товаров на складе')
  return (
    <Modal wide title={title} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 8 }}>
        {t('Товаров')}: {itogo.tovarov} · {t('по закупке')} {money(itogo.cost)} · {t('по цене продажи')} {money(itogo.value)}
      </div>
      <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
        <table data-testid="sklad-card-okno">
          <thead><tr><th>{t('Товар')}</th><th className="num">{t('На складе')}</th><th className="num">{t('По закупке')}</th><th className="num">{t('По цене продажи')}</th></tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.productId}>
                <td><b>{r.product.name}</b>{r.product.dosage ? <span className="tag-cat"> · {r.product.dosage}</span> : null}</td>
                <td className="num">{unitsText(r.units, r.product, t)}</td>
                <td className="num" style={key === 'cost' ? { fontWeight: 700 } : undefined}>{money(r.cost)}</td>
                <td className="num" style={key === 'value' ? { fontWeight: 700 } : undefined}>{money(r.value)}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan="4" className="empty">{t('На складе пока пусто')}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>{t('Закрыть')}</button></div>
    </Modal>
  )
}

// ── Документ из истории — подробно ──
function DocOkno({ doc, title, productById, onClose }) {
  const t = useT()
  return (
    <Modal wide title={`${title} · ${fmtDateTime(doc.date)}`} onClose={onClose}>
      <div className="tag-cat" style={{ marginBottom: 8 }}>
        {doc.supplier ? `${doc.supplier} · ` : ''}{doc.who ? `${t('Кто')}: ${doc.who} · ` : ''}{t('Позиций')}: {doc.items.length} · {t('по закупке')} {money(doc.total)}
        {doc.note ? ` · ${doc.note}` : ''}
      </div>
      <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
        <table data-testid="sklad-doc-okno">
          <thead><tr><th>{t('Товар')}</th><th className="num">{t('Количество')}</th><th className="num">{t('Закупочная')}</th>{doc.kind !== 'arrival' && <th>{t('Срок')}</th>}</tr></thead>
          <tbody>
            {doc.items.map((i, n) => {
              const p = productById.get(i.productId) || (i.upp ? { unitsPerPack: i.upp } : null)
              const kol = p ? unitsText(Math.abs(i.units), p, t) : `${Math.abs(i.units)} ${t('шт')}`
              return (
                <tr key={n}>
                  <td><b>{i.name || p?.name || '—'}</b></td>
                  <td className="num" style={doc.kind === 'edit' ? { color: i.units < 0 ? 'var(--danger)' : 'var(--green)' } : undefined}>
                    {doc.kind === 'edit' ? (i.units < 0 ? '−' : '+') : ''}{kol}
                  </td>
                  <td className="num">{money(i.cost)}</td>
                  {doc.kind !== 'arrival' && <td>{i.expiryDate ? fmtDate(i.expiryDate) : '—'}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>{t('Закрыть')}</button></div>
    </Modal>
  )
}

// ── Поправить остаток склада ──
// Выбрали товар (любой из справочника — так вносят то, что уже лежит на складе), вписали,
// сколько лежит на самом деле. Стало больше — разница ложится партией по закупочной
// (нынешняя закупочная товара или вписанная) и со сроком, если он указан
function EditOkno({ products, batches, productId, onClose }) {
  const t = useT()
  const toast = useToast()
  const [pid, setPid] = useState(productId || '')
  const [q, setQ] = useState('')
  const p = products.find((x) => x.id === pid) || null
  const est = p ? skladUnitsOf(batches, p.id) : 0
  const [v, setV] = useState(() => (p ? partsFrom(p, est) : { packs: '', pieces: '' }))
  const [cost, setCost] = useState(() => (p ? String(num(p.cost) || '') : ''))
  const [exp, setExp] = useState('')
  const [busy, setBusy] = useState(false)
  const z = useMemo(() => poiskZapros(q), [q])
  const found = useMemo(() => (z ? products.filter((x) => tovarPodhodit(z, `${x.name} ${x.dosage || ''}`, x.barcode)).slice(0, 30) : []), [products, z])
  const novoe = p ? unitsFrom(p, v.packs, v.pieces) : 0
  const bolshe = p && novoe > est

  function pick(x) {
    setPid(x.id)
    setV(partsFrom(x, skladUnitsOf(batches, x.id)))
    setCost(String(num(x.cost) || ''))
    setQ('')
  }

  async function save() {
    if (!p) return toast(t('Выберите товар'), 'err')
    if (novoe === est) return toast(t('Остаток не изменился'), 'err')
    setBusy(true)
    try {
      await skladEdit({ productId: p.id, units: novoe, ...(bolshe ? { cost, expiryDate: exp || undefined } : {}) })
      toast(t('Остаток склада поправлен'))
      onClose()
    } catch (e) {
      toast(t(e?.message || 'Не получилось. Повторите.'), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={<><span className="ic"><LuPencil size={18} /></span>{t('Поправить остаток склада')}</>} onClose={onClose}>
      {!p ? (
        <>
          <label className="prh-sheet-search" style={{ marginBottom: 10 }}>
            <LuSearch size={15} aria-hidden="true" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Название или штрихкод…')} aria-label={t('Найти товар')} data-testid="sklad-edit-q" />
          </label>
          <div style={{ maxHeight: '46vh', overflow: 'auto' }}>
            <table>
              <tbody>
                {found.map((x) => (
                  <tr key={x.id} className="clickable" data-testid="sklad-edit-pick" onClick={() => pick(x)}>
                    <td><b>{x.name}</b>{x.dosage ? <span className="tag-cat"> · {x.dosage}</span> : null}<div className="tag-cat">{x.barcode}</div></td>
                    <td className="num tag-cat">{t('на складе')} {unitsText(skladUnitsOf(batches, x.id), x, t)}</td>
                  </tr>
                ))}
                {z && !found.length && <tr><td className="empty">{t('Ничего не найдено')}</td></tr>}
                {!z && <tr><td className="empty">{t('Найдите товар по названию или штрихкоду')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="modal-actions"><button className="btn ghost" onClick={onClose}>{t('Отмена')}</button></div>
        </>
      ) : (
        <>
          <div className="total-row"><span><b>{p.name}</b>{p.dosage ? <span className="tag-cat"> · {p.dosage}</span> : null}</span>{!productId && <button className="btn ghost sm" onClick={() => setPid('')}>{t('Другой товар')}</button>}</div>
          <div className="total-row"><span>{t('Сейчас на складе')}</span><b>{unitsText(est, p, t)}</b></div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>{t('Сколько лежит на самом деле')}</label>
            <QtyFields p={p} packs={v.packs} pieces={v.pieces} testid="sklad-edit-qty" onChange={setV} />
          </div>
          {p && novoe !== est && (
            <div className="tag-cat" style={{ marginBottom: 8, color: bolshe ? 'var(--green)' : 'var(--danger)' }}>
              {bolshe ? '+' : '−'}{unitsText(Math.abs(novoe - est), p, t)}
            </div>
          )}
          {bolshe && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '1 1 160px' }}>
                <label>{t('Закупочная за')} {t(packLabel(p))}</label>
                <NumberInput value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" data-testid="sklad-edit-cost" />
              </div>
              <div className="field" style={{ flex: '1 1 160px' }}>
                <label>{t('Срок годности')}</label>
                <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} data-testid="sklad-edit-exp" />
              </div>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>{t('Отмена')}</button>
            <button className="btn" data-testid="sklad-edit-save" disabled={busy || novoe === est} onClick={save}>{busy ? t('Сохранение…') : t('Сохранить')}</button>
          </div>
        </>
      )}
    </Modal>
  )
}
