import { useSyncExternalStore } from 'react'
import PrintDoc from './PrintDoc'
import TicketView from './TicketView'
import { onPechat, pechatState, pechatTicket } from '../lib/pechat'

// ── Чек печатается, а окно уже закрыто ──
// Кассир нажал «Печать» в окне чека — окно закрывается сразу, очередь не ждёт. Но печатный
// слой окна (PrintDoc) ушёл бы вместе с ним, а экрану печати программы и окну печати
// браузера он ещё нужен. Поэтому на время печати чек живёт здесь — вне окна, в печатном
// слое (prio 2, как у окон: открыт последним — он и печатается). Ушёл на чековый принтер,
// закрылось окно печати браузера или экран печати программы — держатель отпускает его.
let kept = null
const subs = new Set()
const emit = () => subs.forEach((f) => f())
const keep = (v) => {
  kept = v
  emit()
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

// Напечатать чек, когда его окно закрывается: ticket — строки чека, title — название
// документа (заголовок экрана печати и имя PDF). Возвращает то же, что pechatTicket
export async function pechatBezOkna(ticket, title, { print = pechatTicket } = {}) {
  const at = Date.now()
  keep({ ticket, title, at })
  let how = null
  // Окно печати браузера на компьютере держит программу, пока его не закроют (afterprint
  // приходит до возврата из window.print). На телефоне оно не ждёт, и страница уходит на
  // печать позже — тогда чек отпускаем по afterprint (самое позднее через минуту)
  let printed = false
  const onAfter = () => {
    printed = true
  }
  window.addEventListener('afterprint', onAfter)
  try {
    // Слой дорисован и окно чека закрылось — только тогда печатать: экран печати и окно
    // браузера берут то, что лежит в слое в эту минуту
    await frame()
    how = await print(ticket)
    return how
  } finally {
    window.removeEventListener('afterprint', onAfter)
    const release = () => {
      if (kept?.at === at) keep(null)
    }
    if (how === 'preview' && pechatState()) {
      // Экран печати программы ещё открыт — ждём, пока его закроют (печать или отмена)
      const off = onPechat(() => {
        if (!pechatState()) {
          off()
          release()
        }
      })
    } else if (how === 'system' && !printed) {
      const done = () => {
        window.removeEventListener('afterprint', done)
        clearTimeout(timer)
        release()
      }
      window.addEventListener('afterprint', done)
      const timer = setTimeout(done, 60000)
    } else release()
  }
}

export default function PrintKeeper() {
  const v = useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => kept,
    () => null,
  )
  if (!v) return null
  return (
    <PrintDoc key={v.at} prio={2} kind="ticket" title={v.title}>
      <TicketView ticket={v.ticket} />
    </PrintDoc>
  )
}
