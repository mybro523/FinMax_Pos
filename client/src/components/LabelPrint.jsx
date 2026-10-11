import { useState } from 'react'
import { LuPrinter, LuTag } from 'react-icons/lu'
import { Modal } from './ui'
import { ean13Svg, isValidEan13 } from '../lib/barcode'
import { money } from '../db/store'
import { translate as tr } from '../lib/i18n'
import NumberInput from './NumberInput'

// ── Печать этикеток со штрихкодом ──
// Два режима: лист A4 с сеткой (режется ножницами) и одиночная наклейка 58 мм
// для термопринтера. Штрихкод рисуется в SVG в миллиметрах, поэтому размеры
// на бумаге точные и код читается сканером.

export default function LabelPrint({ product, onClose }) {
  const [mode, setMode] = useState('a4') // a4 | roll
  const [copies, setCopies] = useState(12)

  const printable = isValidEan13(product.barcode)
  const svg = printable ? ean13Svg(product.barcode, { widthMm: 37, heightMm: 22 }) : ''
  const count = mode === 'roll' ? 1 : Math.max(1, Math.min(80, Number(copies) || 1))

  // Штрихкод-полоска рисуется только для EAN-13. У товара может стоять код другого
  // вида (например, длинный код маркировки) — тогда честно объясняем, что делать.
  if (!printable) {
    return (
      <Modal title={<><span className="ic"><LuTag size={18} /></span>{tr('Печать этикеток')}</>} onClose={onClose}>
        <div className="note err" style={{ marginBottom: 12 }}>
          {product.barcode
            ? tr('Штрихкод товара не в формате EAN-13, полоску напечатать нельзя.')
            : tr('У товара нет штрихкода.')}
        </div>
        <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
          {tr('Откройте карточку товара и нажмите кнопку генерации рядом с полем штрихкода — система создаст свой код, и его можно будет распечатать.')}
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{tr('Понятно')}</button>
        </div>
      </Modal>
    )
  }

  const label = (key) => (
    <div className="label-item" key={key}>
      <div className="label-name">{product.name}</div>
      {product.dosage ? <div className="label-dose">{product.dosage}</div> : null}
      <div className="label-bc" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="label-price">{money(product.price)}</div>
    </div>
  )

  return (
    <Modal
      className="printable label-print"
      title={<><span className="ic"><LuTag size={18} /></span>{tr('Печать этикеток')}</>}
      onClose={onClose}
      wide
    >
      <div className="no-print">
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={'chip ' + (mode === 'a4' ? 'active' : '')} onClick={() => setMode('a4')}>
            {tr('Лист A4')}
          </button>
          <button className={'chip ' + (mode === 'roll' ? 'active' : '')} onClick={() => setMode('roll')}>
            {tr('Наклейка 58 мм')}
          </button>
        </div>
        {mode === 'a4' && (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{tr('Сколько этикеток')}</label>
            <NumberInput integer value={copies} onChange={(e) => setCopies(e.target.value)} />
          </div>
        )}
        <div className="note info" style={{ marginBottom: 12 }}>
          {mode === 'a4'
            ? tr('Печать на обычном принтере: лист с этикетками, разрежьте по рамкам.')
            : tr('Печать на термопринтере этикеток шириной 58 мм — по одной наклейке.')}
        </div>
      </div>

      <div className={'label-sheet ' + mode}>{Array.from({ length: count }, (_, i) => label(i))}</div>

      <div className="modal-actions no-print">
        <button className="btn ghost" onClick={onClose}>{tr('Закрыть')}</button>
        <button className="btn" onClick={() => window.print()}>
          <span className="ic"><LuPrinter size={16} /></span> {tr('Печать')}
        </button>
      </div>
    </Modal>
  )
}
