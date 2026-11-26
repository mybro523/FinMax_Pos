import { useRef } from 'react'
import { LuCamera, LuX } from 'react-icons/lu'
import { useT } from '../lib/i18n'
import { useToast } from './ui'
import NumberInput from './NumberInput'
import { AddTypeBtn } from './TypeSelect'
import { useProductTypes, typeNames, typeOptions, typeHasAnalogs } from '../lib/productTypes'
import { szhatFoto } from '../lib/foto'

// ── Дополнительные поля карточки товара (1.8.17) ──
// Вид (тип), дозировка, мин. остаток, фото и аналоги — те же, что в полной форме «Товаров»
// (ProductForm). Вынесены сюда, чтобы форма нового товара в приходе завела карточку так же
// полно. value — { type, dosage, minStock, image, analogIds }; set(поле, значение) кладёт
// правку туда, где эти поля хранит вызвавший (в приходе — в nov*-поля формы).
export default function ProductExtras({ value, set, products = [], unit = 'шт', selfId = null }) {
  const t = useT()
  const toast = useToast()
  const fotoRef = useRef(null)
  const types = useProductTypes()
  const analogIds = Array.isArray(value.analogIds) ? value.analogIds : []
  // Аналоги показываем только у типов «с аналогами» (как в карточке) или если они уже заданы
  const showAnalogs = typeHasAnalogs(value.type, types) || analogIds.length > 0
  const nameById = (id) => products.find((p) => p.id === id)?.name || t('удалённый товар')

  async function pickFoto(file) {
    if (!file) return
    try {
      set('image', await szhatFoto(file))
    } catch {
      toast(t('Не удалось загрузить фото'), 'err')
    }
  }

  return (
    <>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="pe-type">{t('Тип товара (необязательно)')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select id="pe-type" style={{ flex: 1, minWidth: 0 }} value={value.type || ''} onChange={(e) => set('type', e.target.value)}>
              <option value="">{t('— без типа —')}</option>
              {typeOptions(value.type, types).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.legacy ? `${o.value} — ${t('старый тип')}` : t(o.value)}
                </option>
              ))}
            </select>
            <AddTypeBtn toast={toast} options={typeNames(types)} onPicked={(name) => set('type', name)} />
          </div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="pe-dosage">{t('Фасовка / объём')}</label>
          <input id="pe-dosage" value={value.dosage || ''} onChange={(e) => set('dosage', e.target.value)} placeholder={t('напр. 500 мг, 1 л')} />
        </div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="pe-min">{t('Мин. остаток')} ({t(unit)})</label>
          <NumberInput id="pe-min" integer value={value.minStock ?? ''} onChange={(e) => set('minStock', e.target.value)} placeholder="5" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>{t('Фото товара (необязательно)')}</label>
          <div className="pf-foto">
            {value.image ? <img className="foto-mini lg" src={value.image} alt="" /> : <span className="pf-foto-none">{t('нет фото')}</span>}
            <input ref={fotoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { pickFoto(e.target.files?.[0]); e.target.value = '' }} />
            <button type="button" className="btn ghost" onClick={() => fotoRef.current?.click()}>
              <span className="ic"><LuCamera size={15} /></span> {value.image ? t('Заменить') : t('Загрузить фото')}
            </button>
            {value.image && <button type="button" className="btn ghost" onClick={() => set('image', '')}>{t('Убрать')}</button>}
          </div>
        </div>
      </div>

      {/* Аналоги: чем заменить, если этого не осталось. Только у типов «с аналогами» */}
      {showAnalogs && (
        <div className="field">
          <label>{t('Аналоги (взаимозаменяемые товары)')}</label>
          <select value="" onChange={(e) => { const id = e.target.value; if (id && !analogIds.includes(id)) set('analogIds', [...analogIds, id]) }}>
            <option value="">{t('— добавить аналог —')}</option>
            {products.filter((p) => p.id !== selfId && !analogIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {analogIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {analogIds.map((id) => (
                <span key={id} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {nameById(id)}
                  <button
                    type="button"
                    className="pf-analog-x"
                    onClick={() => set('analogIds', analogIds.filter((x) => x !== id))}
                    aria-label={`${t('Убрать')}: ${nameById(id)}`}
                    style={{ background: 'none', border: 'none', color: 'var(--danger)', display: 'inline-flex', padding: 0 }}
                  >
                    <LuX size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
