import { useEffect, useState } from 'react'
import { LuCopy, LuKeyRound } from 'react-icons/lu'
import { api } from '../db/api'
import { useT } from '../lib/i18n'
import { fmtShort } from '../lib/time'
import { formatCode, normalizeCode, pastedCode } from '../lib/aktivaciya'
import { Modal, useToast } from './ui'

// ── Панель владельца сервиса: коды активации программы без интернета (версия 1.6.0) ──
// Магазин без интернета присылает «код компьютера» (10 знаков). Здесь под него выпускается
// код активации — до какого дня и сколько касс можно подключить, — или код сброса пароля
// владельца магазина (действует три дня, один раз). Код подписывает сервер своим ключом
// (server/src/admin/licences.service.ts); список — запись о выпущенном.

const PC_LEN = 10
// Дни — по Душанбе (UTC+5), как их считает код: с полуночи до 5 утра по UTC там уже завтра
const dushanbeDay = (plusDays = 0) => new Date(Date.now() + 5 * 3600000 + plusDays * 86400000).toISOString().slice(0, 10)
const inYear = () => dushanbeDay(365)
// «2027-11-01» → «01.11.2027»
const human = (iso) => (iso ? iso.split('-').reverse().join('.') : '')

async function copyText(text, toast, t) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('Скопировано'))
  } catch {
    toast(t('Скопировать не получилось — выделите код и скопируйте вручную'), 'err')
  }
}

export default function KodyAktivacii({ onClose }) {
  const t = useT()
  const toast = useToast()
  const [f, setF] = useState({ computer: '', kind: 'activate', until: inYear(), forever: false, registers: 1, note: '' })
  const [list, setList] = useState([])
  const [listErr, setListErr] = useState('')
  const [made, setMade] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))
  const load = () =>
    api.get('/admin/licences').then(
      (l) => {
        setList(Array.isArray(l) ? l : [])
        setListErr('')
      },
      (e) => setListErr(e?.message || '—'),
    )
  useEffect(() => {
    load()
  }, [])

  const pc = normalizeCode(f.computer, PC_LEN)
  // Вставили сообщение («Код компьютера: XJ980-C0A4R») — берём сам код: русские слова по месту
  // клавиш превратились бы в латинские буквы
  const onPastePc = (e) => {
    const text = e.clipboardData?.getData('text')
    if (text == null) return
    e.preventDefault()
    set('computer', normalizeCode(pastedCode(text, 2), PC_LEN))
  }
  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setErr('')
    // Прежний выпущенный код (может быть, для другого компьютера) не должен стоять рядом с ошибкой
    setMade(null)
    const registers = Number(f.registers)
    if (f.kind === 'activate' && !(Number.isInteger(registers) && registers >= 1 && registers <= 50)) {
      return setErr(t('Сколько касс можно подключить — от 1 до 50'))
    }
    setBusy(true)
    try {
      const body =
        f.kind === 'reset'
          ? { computer: formatCode(pc), kind: 'reset', note: f.note }
          : { computer: formatCode(pc), kind: 'activate', forever: f.forever, until: f.forever ? undefined : f.until, registers: Number(f.registers), note: f.note }
      const r = await api.post('/admin/licences', body)
      setMade(r)
      load()
    } catch (e2) {
      setErr(e2.message || t('Не получилось. Повторите.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal wide title={t('Коды активации')} onClose={onClose}>
      <div data-testid="licences">
        <p className="tag-cat" style={{ marginBottom: 12, lineHeight: 1.6 }}>
          {t('Для магазина без интернета. Магазин сообщает код компьютера — программа показывает его при активации. Выпустите код и продиктуйте или отправьте его магазину.')}
        </p>
        <form onSubmit={submit}>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="lic-pc">{t('Код компьютера')}</label>
              <input id="lic-pc" className="solo-code" value={formatCode(pc)} onChange={(e) => set('computer', e.target.value)} onPaste={onPastePc} placeholder="XXXXX-XXXXX" autoComplete="off" spellCheck={false} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('Что выпустить')}</label>
              <div className="chips">
                <button type="button" className={'chip ' + (f.kind === 'activate' ? 'active' : '')} onClick={() => set('kind', 'activate')}>{t('Код активации')}</button>
                <button type="button" className={'chip ' + (f.kind === 'reset' ? 'active' : '')} onClick={() => set('kind', 'reset')}>{t('Сброс пароля')}</button>
              </div>
            </div>
          </div>
          {f.kind === 'activate' && (
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="lic-until">{t('Действует до')}</label>
                <input id="lic-until" type="date" value={f.until} min={dushanbeDay()} disabled={f.forever} required={!f.forever} onChange={(e) => set('until', e.target.value)} />
                <label className="restore-check" style={{ fontWeight: 500 }}>
                  <input type="checkbox" checked={f.forever} onChange={(e) => set('forever', e.target.checked)} /> {t('Навсегда')}
                </label>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="lic-reg">{t('Сколько касс можно подключить')}</label>
                <input id="lic-reg" type="number" min={1} max={50} step={1} required value={f.registers} onChange={(e) => set('registers', e.target.value)} />
              </div>
            </div>
          )}
          {f.kind === 'reset' && <div className="note info" style={{ marginBottom: 10 }}>{t('Код сброса пароля владельца действует три дня и только один раз.')}</div>}
          <div className="field">
            <label htmlFor="lic-note">{t('Заметка')}</label>
            <input id="lic-note" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={t('Магазин, владелец, телефон — для себя')} maxLength={200} />
          </div>
          {err && <div className="note err" style={{ marginBottom: 10 }}>{err}</div>}
          <button className="btn gold" disabled={busy || pc.length !== PC_LEN} data-testid="licence-issue">
            <span className="ic"><LuKeyRound size={16} /></span> {busy ? t('Выпускаем…') : t('Выпустить код')}
          </button>
        </form>

        {made && (
          <div className="note ok" style={{ marginTop: 14 }} data-testid="licence-made">
            <div className="tag-cat">
              {made.kind === 'reset' ? t('Код сброса пароля') : t('Код активации')} · {made.computer}
              {made.kind === 'activate' ? ` · ${made.until ? `${t('до')} ${human(made.until)}` : t('навсегда')} · ${t('касс')}: ${made.registers}` : ''}
            </div>
            <div className="licence-code" data-testid="licence-code">{made.code}</div>
            <button type="button" className="btn ghost" onClick={() => copyText(made.code, toast, t)}>
              <span className="ic"><LuCopy size={15} /></span> {t('Скопировать')}
            </button>
          </div>
        )}

        <h4 style={{ margin: '18px 0 8px' }}>{t('Выпущенные коды')}</h4>
        {listErr && <div className="note err">{t('Список кодов не загрузился')}: {listErr}</div>}
        {!list.length && !listErr && <div className="tag-cat">{t('Пока ни одного.')}</div>}
        {!!list.length && (
          <table className="table-cards">
            <thead>
              <tr>
                <th>{t('Когда')}</th>
                <th>{t('Компьютер')}</th>
                <th>{t('Что')}</th>
                <th>{t('Заметка')}</th>
                <th>{t('Код')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id}>
                  <td data-label={t('Когда')}>{fmtShort(l.createdAt)}</td>
                  <td data-label={t('Компьютер')}><b>{l.computer}</b></td>
                  <td data-label={t('Что')}>
                    {l.kind === 'reset' ? t('Сброс пароля') : `${l.until ? `${t('до')} ${human(l.until)}` : t('навсегда')} · ${t('касс')}: ${l.registers}`}
                  </td>
                  <td data-label={t('Заметка')} className="tag-cat">{l.note || '—'}</td>
                  <td data-label={t('Код')}>
                    <button type="button" className="btn ghost" onClick={() => copyText(l.code, toast, t)} title={l.code}>
                      <span className="ic"><LuCopy size={14} /></span> {t('Скопировать')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
