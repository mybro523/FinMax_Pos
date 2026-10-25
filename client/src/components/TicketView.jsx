// ── Чек на экране и на листе ──
// Рисует то, что собрал lib/ticket.js, и ровно в том же порядке, что уйдёт на
// ленту и в PDF: шапка, позиции, итоги, подвал. Никаких собственных строк здесь
// нет — иначе экран и бумага снова разойдутся.
//
// Оформление фирменное, как у «Отчёта о прибылях и убытках»: название магазина на
// тёмно-синей полосе, строка документа («Чек № …») жирной, итог — синей плашкой.
// Внизу — снова название магазина, жирным. Эмблемы программы на чеке нет: чек —
// бумага магазина. Чек белый и при тёмной теме программы.
export default function TicketView({ ticket }) {
  const { head = [], rows = [], totals = [], tail = [], docAt = -1, signAt = -1 } = ticket || {}
  const [shop, ...rest] = head
  return (
    <div className="ticket">
      {shop !== undefined && <div className="tk-band">{shop}</div>}
      {rest.length > 0 && (
        <div className="ticket-head">
          {rest.map((line, i) => (
            <div key={i} className={i + 1 === docAt ? 'tk-doc' : undefined}>{line}</div>
          ))}
        </div>
      )}
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
      {totals.map((r, i) =>
        r.big ? (
          <div className="tk-total" key={i}>
            <span>{r.label}</span>
            <span>{r.value}</span>
          </div>
        ) : (
          <div className="tk-row" key={i}>
            <span>{r.label}</span>
            <span>{r.value}</span>
          </div>
        ),
      )}
      {tail.length > 0 && (
        <>
          <div className="ticket-rule" aria-hidden="true" />
          <div className="ticket-tail">
            {tail.map((line, i) => (
              <div key={i} className={i === signAt ? 'tk-sign' : undefined}>{line}</div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
