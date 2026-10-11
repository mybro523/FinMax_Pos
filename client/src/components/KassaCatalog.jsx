import { memo } from 'react'
import { money } from '../db/store'
import { uppOf, isDivisible, sellableUnits, stockUnits, expiredUnits, hasExpired } from '../lib/units'
import { useT } from '../lib/i18n'

// ── Каталог кассы ──
//
// Список товаров, который виден всегда, а не только пока что-то набираешь.
// Нужен там, где сканер не помогает: штрихкод стёрся, его нет вовсе, или
// покупатель спрашивает «что у вас есть от кашля». Заодно кассир видит цену
// и остаток ДО того, как товар попал в чек.
//
// Строки — кнопки, а не строки таблицы. На них можно нажать и пальцем, и с
// клавиатуры, а слово «таблица» на кассе остаётся за чеком.
//
// Список режется по LIMIT: в настоящей аптеке 3–8 тысяч наименований, и рисовать
// их все на каждое нажатие клавиши значило бы тормозить кассу ради строк,
// до которых никто не долистает. Вместо этого просим уточнить поиск.

export const LIMIT = 100

// Остаток словами: «12 уп» или «12 уп + 3 шт». Собирается здесь, а не берётся
// готовым из общего помощника: тот пишет единицы по-русски, а каталог открыт
// и на таджикском
function ostatok(p, t) {
  const packs = Number(p.stock) || 0
  const loose = Number(p.looseUnits) || 0
  const unit = t(p.unit || 'уп')
  return isDivisible(p) && loose > 0 ? `${packs} ${unit} + ${loose} ${t('шт')}` : `${packs} ${unit}`
}

function KassaCatalog({ rows, total, hi, showHi, outside, loading, noProducts, onPick }) {
  const t = useT()

  if (loading) return <div className="empty">{t('Список товаров загружается…')}</div>
  if (noProducts) return <div className="empty">{t('Товаров пока нет. Заведите их в разделе «Товары».')}</div>
  if (!rows.length) return <div className="empty">{t('Ничего не найдено')}</div>

  return (
    <>
      {outside && (
        <div className="kc-note">{t('В этой категории не найдено — показаны товары из других категорий')}</div>
      )}
      <div className="kc-list" role="listbox" aria-label={t('Каталог')}>
        {rows.map((p, n) => {
          const sell = sellableUnits(p)
          const net = sell <= 0
          return (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={showHi && n === hi}
              className={'kc-row' + (showHi && n === hi ? ' hi' : '') + (net ? ' net' : '')}
              // Не даём кнопке забрать фокус: он должен остаться в поле сканера,
              // иначе следующий скан после нажатия мышью ушёл бы в никуда
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(p)}
            >
              <span className="kc-name">
                <b>{p.name}</b>
                <span className="tag-cat">
                  {p.dosage ? `${p.dosage} · ` : ''}{p.barcode}
                </span>
              </span>
              {/* Цена, цена штуки и остаток — столбиком справа. Колонка каталога
                  узкая, и поставленные в ряд они не оставили бы места названию */}
              <span className="kc-right">
                <b className="kc-price">{money(p.price)}</b>
                {isDivisible(p) && <span className="tag-cat">{money(p.price / uppOf(p))}/{t('шт')}</span>}
                <span className={'badge ' + (net ? 'debt' : p.stock <= p.minStock ? 'low' : 'ok')}>
                  {net && stockUnits(p) <= 0 ? t('нет') : ostatok(p, t)}
                </span>
                {hasExpired(p) && (
                  <span className="tag-cat kc-exp">
                    {t('просрочено')} {expiredUnits(p)} {t('шт')}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {total > rows.length && (
        <div className="kc-note">
          {t('Показаны первые')} {rows.length} {t('из')} {total} — {t('уточните поиск или выберите категорию')}
        </div>
      )}
    </>
  )
}

// Чек меняется на каждое нажатие «+» и каждую цифру скидки — каталог от этого
// не зависит и перерисовываться не должен
export default memo(KassaCatalog)
