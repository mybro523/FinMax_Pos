import { LuMinus, LuPlus, LuRotateCcw, LuType } from 'react-icons/lu'
import { useT } from '../lib/i18n'
import { MENU, SISTEMA, setShrift, useShrift } from '../lib/shrift'

// ── «Настройки → Шрифт» (1.7.7) ──
// Размер всей системы и отдельно надписей главного меню — кнопками «−» и «+» шагом 10 %.
// Помнится на этом компьютере (lib/shrift.js); видно сразу
function Stroka({ label, hint, value, lim, onChange, testid }) {
  const t = useT()
  return (
    <div className="field" data-testid={testid}>
      <label>{label}</label>
      <div className="nk-step">
        <button type="button" className="btn ghost sm icon" onClick={() => onChange(value - lim.step)} disabled={value <= lim.min} aria-label={t('Меньше')} title={t('Меньше')} data-testid={testid + '-less'}>
          <LuMinus size={15} />
        </button>
        <span className="nk-step-val" data-testid={testid + '-val'}>{value} %</span>
        <button type="button" className="btn ghost sm icon" onClick={() => onChange(value + lim.step)} disabled={value >= lim.max} aria-label={t('Больше')} title={t('Больше')} data-testid={testid + '-more'}>
          <LuPlus size={15} />
        </button>
      </div>
      {hint && <div className="tag-cat">{hint}</div>}
    </div>
  )
}

export default function ShriftPanel() {
  const t = useT()
  const { sistema, menu } = useShrift()
  return (
    <div className="panel" style={{ maxWidth: 640 }} data-testid="shrift-panel">
      <h2>
        <span className="h2-title"><span className="ic"><LuType size={17} /></span>{t('Шрифт')}</span>
      </h2>
      <Stroka
        label={t('Размер шрифта системы')}
        hint={`${t('Текст, кнопки и таблицы во всех разделах')} · ${SISTEMA.min}–${SISTEMA.max} %`}
        value={sistema}
        lim={SISTEMA}
        onChange={(v) => setShrift({ sistema: v })}
        testid="shrift-sistema"
      />
      <Stroka
        label={t('Размер надписей меню')}
        hint={`${t('Надписи на плитках главного меню')} · ${MENU.min}–${MENU.max} %`}
        value={menu}
        lim={MENU}
        onChange={(v) => setShrift({ menu: v })}
        testid="shrift-menu"
      />
      <div className="tag-cat" style={{ marginBottom: 12 }}>{t('Настройка этого компьютера: на других кассах размер свой.')}</div>
      <button type="button" className="btn ghost" onClick={() => setShrift({ sistema: 100, menu: 100 })} disabled={sistema === 100 && menu === 100} data-testid="shrift-reset">
        <span className="ic"><LuRotateCcw size={15} /></span> {t('Как было')}
      </button>
    </div>
  )
}
