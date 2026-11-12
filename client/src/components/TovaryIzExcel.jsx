import { useRef, useState } from 'react'
import { LuFileSpreadsheet, LuX } from 'react-icons/lu'
import { colLetter, prochitatXlsx, razobrat } from '../lib/importTovarov'

// ── Товары из Excel: выбор файла и что из него выйдет ──
// value — разобранный файл ({ fileName, items, skipped, cols, ownCodes }) или null.
// Сам файл никуда не уходит: разбирается здесь, на сервер идёт готовый список товаров
const POLE = { barcode: 'штрихкод', name: 'название', price: 'цена', cost: 'закупка', stock: 'остаток', category: 'категория', unit: 'ед.' }

export default function TovaryIzExcel({ value, onChange, disabled, t }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showSkipped, setShowSkipped] = useState(false)

  async function pick(file) {
    if (!file) return
    setBusy(true)
    setErr('')
    setShowSkipped(false)
    try {
      const rows = await prochitatXlsx(file)
      const r = razobrat(rows)
      if (r.error) throw new Error(r.error)
      if (!r.items.length) throw new Error('В файле не нашлось ни одного товара')
      onChange({ fileName: file.name, ...r })
    } catch (e) {
      setErr(t(e.message))
      onChange(null)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const cols = value ? Object.entries(value.cols || {}).filter(([k]) => POLE[k]).sort((a, b) => a[1] - b[1]).map(([k, i]) => `${t(POLE[k])} — ${colLetter(i)}`) : []
  return (
    <div className="field" data-testid="excel-import">
      <label>{t('Товары из Excel')}</label>
      <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} data-testid="excel-file" />
      {!value ? (
        <button type="button" className="btn ghost" onClick={() => input.current?.click()} disabled={busy || disabled} data-testid="excel-pick">
          <span className="ic"><LuFileSpreadsheet size={16} /></span> {busy ? t('Читаю файл…') : t('Выбрать файл Excel')}
        </button>
      ) : (
        <div className="note info" data-testid="excel-summary">
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <b>{value.fileName}</b>
              <div>
                {t('Товаров')}: <b data-testid="excel-count">{value.items.length.toLocaleString('ru-RU')}</b>
                {value.ownCodes ? ` · ${t('без штрихкода — код создастся сам')}: ${value.ownCodes}` : ''}
                {' · '}
                {t('пропущено')}: <b data-testid="excel-skipped">{value.skipped.length}</b>
              </div>
              <div className="tag-cat">{t('Колонки')}: {cols.join(', ')}</div>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => onChange(null)} disabled={disabled} data-testid="excel-clear" title={t('Убрать')}>
              <LuX size={15} /> {t('Убрать')}
            </button>
          </div>
          {value.skipped.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <button type="button" className="btn ghost sm" onClick={() => setShowSkipped((v) => !v)} data-testid="excel-show-skipped">
                {showSkipped ? t('Скрыть пропущенные') : t('Показать пропущенные')}
              </button>
              {showSkipped && (
                <div className="tag-cat" style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }} data-testid="excel-skipped-list">
                  {value.skipped.slice(0, 300).map((s) => (
                    <div key={s.n}>
                      {t('Строка')} {s.n}: {s.why === 'dup' ? `${t('повтор штрихкода, как в строке')} ${s.ref}` : s.why === 'max' ? `${t('больше 50 000 товаров за раз')}` : t('нет названия')}
                      {s.text ? ` — ${s.text}` : ''}
                    </div>
                  ))}
                  {value.skipped.length > 300 ? <div>… {t('и ещё')} {value.skipped.length - 300}</div> : null}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {err && <div className="note err" style={{ marginTop: 8 }} data-testid="excel-error">{err}</div>}
    </div>
  )
}
