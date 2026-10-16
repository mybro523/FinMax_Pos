import emblem from '../assets/brand/emblem-64.png'
import { BrandWord } from './ui'

// ── Чек на экране ──
// Рисует то, что собрал lib/ticket.js, и ровно в том же порядке, что уйдёт на
// ленту и в PDF: эмблема, шапка, позиции, итоги, подвал. Никаких собственных
// строк здесь нет — иначе экран и бумага снова разойдутся.
export default function TicketView({ ticket, logo = true }) {
  const { head = [], rows = [], totals = [], tail = [] } = ticket || {}
  return (
    <div className="ticket">
      {logo && <img className="ticket-emblem" src={emblem} alt="" width="44" height="44" />}
      <div className="ticket-head">
        {head.map((line, i) => (
          <div key={i} className={i === 0 ? 'ticket-title' : ''}>{line}</div>
        ))}
      </div>
      {rows.length > 0 && (
        <>
          <div className="ticket-rule" aria-hidden="true" />
          {rows.map((r, i) => (
            <div className="ticket-item" key={i}>
              <div className="ticket-name">{r.name}</div>
              <div className="ticket-sub">
                <span>{r.sub}</span>
                <b>{r.value}</b>
              </div>
            </div>
          ))}
        </>
      )}
      <div className="ticket-rule" aria-hidden="true" />
      {totals.map((r, i) => (
        <div className={'total-row' + (r.big ? ' big' : '')} key={i}>
          <span>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
      {tail.length > 0 && (
        <>
          <div className="ticket-rule" aria-hidden="true" />
          <div className="ticket-tail">
            {tail.map((line, i) => (
              <div key={i} className={line === 'FinMax POS' ? 'ticket-brand' : ''}>{line === 'FinMax POS' ? <BrandWord /> : line}</div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
