import { Link } from 'react-router-dom'
import { LuTriangleAlert, LuChevronRight } from 'react-icons/lu'

// Единая карточка-метрика (раньше дублировалась на 5 страницах)
const TINTS = {
  accent: { bg: 'var(--accent-soft)', color: 'var(--accent-dark)' },
  green: { bg: 'var(--green-soft)', color: 'var(--green)' },
  blue: { bg: 'var(--blue-soft)', color: 'var(--blue)' },
  danger: { bg: 'var(--danger-soft)', color: 'var(--danger)' },
}

// tour — метка для тура по разделу: карточка подсвечивается и объясняется
export default function Metric({ label, value, Icon, tint, sub, warn, subTo, onClick, tour }) {
  const t = TINTS[tint] || TINTS.accent
  const subInner = (
    <>
      {warn && <LuTriangleAlert size={12} style={{ verticalAlign: '-2px' }} />} {sub}
      {subTo && <LuChevronRight size={13} style={{ verticalAlign: '-2px' }} />}
    </>
  )
  const hasSub = sub !== undefined && sub !== null && sub !== ''
  return (
    <div className={'metric' + (onClick ? ' clickable' : '')} onClick={onClick} data-tour={tour}>
      <div className="metric-head">
        <div className="label">{label}</div>
        <div className="ic-box" style={{ background: t.bg, color: t.color }}>{Icon && <Icon size={19} />}</div>
      </div>
      <div className="value">{value}</div>
      {hasSub &&
        (subTo ? (
          <Link to={subTo} className={'sub' + (warn ? ' warn' : '')} style={{ textDecoration: 'none', cursor: 'pointer' }}>
            {subInner}
          </Link>
        ) : (
          <div className={'sub' + (warn ? ' warn' : '')}>{subInner}</div>
        ))}
    </div>
  )
}
