import { useCallback, useEffect, useState } from 'react'
import { LuTriangleAlert } from 'react-icons/lu'
import { api } from '../db/api'
import { money, onChanged } from '../db/store'
import { fmtShort } from '../lib/time'
import { useT } from '../lib/i18n'
import { useDialog, useToast } from './ui'
import { discrepancyAdvice, discrepancyDetail, discrepancyTitle, noteOf } from '../lib/discrepancy'

// ── Расхождения с касс ──
// Касса в программе для Windows работает и без интернета. Её чеки сервер принимает
// позже и такими, какие они есть: товар уже отдан покупателю, отказывать поздно.
// Но если что-то не сошлось с базой — продано больше, чем было; цена в чеке не та;
// один чек вернули дважды, — владелец обязан об этом узнать. Иначе работа без
// интернета стала бы лазейкой, которую никто не видит.
//
// Блок появляется, только когда есть что показать. Список держим здесь, а не в общем
// кэше: он нужен одному экрану, и отсутствие связи для него не беда — оставляем то,
// что уже показано, и не пугаем полосой «нет связи».
export default function Discrepancies() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.get('/discrepancies')
      setList(Array.isArray(rows) ? rows : [])
    } catch {
      /* связи нет или сервер ещё прежней версии — показываем то, что есть */
    }
  }, [])

  useEffect(() => {
    load()
    // Вернулись к окну — за это время касса могла выйти на связь
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])
  // Сервер сообщил, что список изменился: касса прислала чеки или запись разобрали
  useEffect(() => onChanged((keys) => keys.includes('discrepancies') && load()), [load])

  async function resolve(d) {
    setBusy(d.id)
    try {
      await api.post(`/discrepancies/${d.id}/resolve`, {})
      setList((cur) => cur.filter((x) => x.id !== d.id))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(null)
    }
  }

  // ── Дубль товара: объединить карточки ──
  // Касса без связи завела товар со штрихкодом, который за это время заняли, — сервер
  // принял его с внутренним кодом. Лишняя карточка (с внутренним кодом) вливается в
  // основную: партии, чеки и приходы переходят к ней, лишняя удаляется
  async function merge(d) {
    const n = noteOf(d)
    const ok = await dialog.confirm({
      title: t('Объединить карточки?'),
      message: `«${d.name}» ${t('вольётся в')} «${n.other?.name || ''}». ${t('Остаток, чеки и приходы перейдут к ней, а карточка с внутренним кодом будет удалена.')}`,
      confirmText: t('Объединить'),
    })
    if (!ok) return
    setBusy(d.id)
    try {
      await api.post(`/products/${d.productId}/merge`, { into: n.other.id })
      await api.post(`/discrepancies/${d.id}/resolve`, {}).catch(() => {})
      setList((cur) => cur.filter((x) => x.id !== d.id))
      toast(t('Карточки объединены'))
    } catch (e) {
      toast(t(e.message), 'err')
    } finally {
      setBusy(null)
    }
  }
  const canMerge = (d) => d.kind === 'barcode' && d.productId && !noteOf(d).edit && noteOf(d).other?.id

  if (!list.length) return null

  return (
    <div className="panel rash-panel" data-testid="discrepancies">
      <h2>
        <span className="h2-title">
          <span className="ic warn"><LuTriangleAlert size={17} /></span>
          {t('Расхождения с касс')}
        </span>
        <span className="badge low">{list.length}</span>
      </h2>
      <div className="note info" style={{ marginBottom: 12 }}>
        {t('Касса работала без интернета, и что-то не сошлось с базой. Чеки приняты как есть — товар уже отдан. Проверьте и отметьте, когда разберётесь.')}
      </div>
      <div className="rash-list">
        {list.map((d) => (
          <div key={d.id} className="rash-row">
            <div className="rash-main">
              <div className="rash-title">{discrepancyTitle(d.kind, t)}</div>
              <div className="rash-what">
                <b>{d.name}</b> — {discrepancyDetail(d, t, money)}
              </div>
              <div className="tag-cat">
                {fmtShort(d.date)}
                {d.deviceName ? ` · ${d.deviceName}` : ''}
                {d.userName ? ` · ${d.userName}` : ''}
              </div>
              <div className="tag-cat">{discrepancyAdvice(d.kind, t)}</div>
            </div>
            <div className="rash-acts" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {canMerge(d) && (
                <button className="btn" disabled={busy === d.id} onClick={() => merge(d)}>
                  {t('Объединить')}
                </button>
              )}
              <button className="btn ghost" disabled={busy === d.id} onClick={() => resolve(d)}>
                {t('Разобрался')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
