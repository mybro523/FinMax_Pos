import { useEffect, useState } from 'react'
import { LuDatabaseBackup, LuFolderOpen, LuHardDrive, LuUpload, LuUsb } from 'react-icons/lu'
import { bridge } from '../lib/desktop'
import { refreshDesktopStatus, useDesktopStatus } from '../db/desktopStatus'
import { useT } from '../lib/i18n'
import { fmtShort } from '../lib/time'
import { Modal, useToast } from './ui'
import { copyErrorText, RestoreView } from './SyncBadge'

// Отдельный файл: раздел нужен только в «Настройках» программы без интернета, а экраны до входа
// (BezInterneta.jsx) грузятся вместе со страницей входа сайта — им окно копий ни к чему
// ── «Настройки» → «Резервная копия» магазина без интернета ──
// Сервера, где лежала бы вторая копия, нет: база — только на этом компьютере. Копии программа
// снимает сама (каждый день — в свою папку и на диск D), но от поломки всего компьютера спасает
// только флешка. Здесь — копия на флешку, загрузка копии (в том числе на новом компьютере, когда
// магазин переезжает) и копия на диск сейчас же
export function SoloKopiya() {
  const t = useT()
  const toast = useToast()
  const st = useDesktopStatus()
  const [busy, setBusy] = useState('')
  const [restoring, setRestoring] = useState(false)
  useEffect(() => {
    refreshDesktopStatus()
  }, [])
  const backup = st?.backup || {}
  const disk = backup.disk || {}
  const usb = backup.usb || {}
  // Касса магазина (1.7.0): база магазина — на главном; копии кассы — запасные, загружают копию на главном
  const register = st?.net?.role === 'register'

  const saveTo = async () => {
    setBusy('saveTo')
    const r = await bridge?.backup.saveTo().catch(() => null)
    setBusy('')
    refreshDesktopStatus()
    if (r?.ok) toast(`${t('Копия сохранена')}: ${r.path}`)
    else if (!r?.canceled) toast(copyErrorText(r, t), 'err')
  }
  const diskNow = async () => {
    setBusy('disk')
    const next = await bridge?.backup.diskNow().catch(() => null)
    setBusy('')
    refreshDesktopStatus()
    const d = next?.backup?.disk
    if (d && !d.error && d.at) toast(`${t('Копия сохранена на диск')}: ${d.dir}`)
    else toast(`${t('Копию на диск записать не удалось')}${d?.error ? ': ' + d.error : ''}`, 'err')
  }
  const diskOpen = async () => {
    const ok = await bridge?.backup.diskOpen().catch(() => false)
    if (!ok) toast(t('Папку копий открыть не удалось'), 'err')
  }

  return (
    <div className="panel mt" data-tour="set.backup" style={{ maxWidth: 640 }} data-testid="solo-kopiya">
      <h2><span className="h2-title"><span className="ic"><LuDatabaseBackup size={17} /></span>{t('Резервная копия')}</span></h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
        {register
          ? t('Это касса магазина: база магазина хранится на главном компьютере, а здесь — её копия. Программа и здесь снимает копии сама; копию этой кассы можно загрузить на новый главный компьютер, если старый сломается.')
          : t('База магазина хранится только на этом компьютере. Раз в неделю сохраняйте копию на флешку и держите флешку не у компьютера: если компьютер сломается, на новом магазин поднимется из этой копии — с товарами, чеками и долгами.')}
      </p>
      {usb.due && (
        <div className="note warn" style={{ marginBottom: 12 }} data-testid="solo-usb-due">
          {usb.at ? `${t('Последняя копия на флешку')}: ${fmtShort(usb.at)} — ${t('пора сохранить новую')}.` : t('Копию на флешку ещё не сохраняли — сохраните сейчас.')}
        </div>
      )}
      <div className="solo-rows">
        <div><span>{t('Копия на флешку')}</span><b className={usb.due ? 'sync-bad' : ''}>{usb.at ? fmtShort(usb.at) : t('ещё не сохранялась')}</b></div>
        <div><span>{t('Копия на диск')}</span><b className={disk.error ? 'sync-bad' : ''}>{disk.running ? t('сохраняется…') : disk.at ? fmtShort(disk.at) : t('ещё не снималась')}</b></div>
        <div><span>{t('Копия в папке программы')}</span><b>{backup.at ? fmtShort(backup.at) : t('ещё не снималась')}</b></div>
      </div>
      {disk.dir && <div className="tag-cat" style={{ marginBottom: 6 }}>{t('Папка копий на диске')}: {disk.dir}</div>}
      {disk.error && <div className="note err" style={{ marginBottom: 8 }}>{t('Копию на диск записать не удалось')}: {disk.error}</div>}
      {backup.restoreError && (
        <div className="note err" style={{ marginBottom: 8 }} data-testid="solo-restore-error">
          {t('Копию загрузить не удалось')}: {backup.restoreError}. {t('Базы остались прежними.')}
        </div>
      )}
      {st?.restored?.manual && st.restored.foreign && (
        <div className="note info" style={{ marginBottom: 8 }} data-testid="solo-moved">
          {t('Магазин переехал сюда с другого компьютера. Пароли сотрудников остались там — задайте их заново в «Сотрудниках».')}
        </div>
      )}
      <div className="solo-copy-actions">
        <button className="btn" disabled={!!busy} onClick={saveTo} data-testid="solo-save-to">
          <span className="ic"><LuUsb size={16} /></span> {busy === 'saveTo' ? t('Сохраняем…') : t('Сохранить копию в…')}
        </button>
        {!register && (
          <button className="btn ghost" disabled={!!busy} onClick={() => setRestoring(true)} data-testid="solo-restore-open">
            <span className="ic"><LuUpload size={16} /></span> {t('Загрузить копию')}
          </button>
        )}
        <button className="btn ghost" disabled={!!busy || disk.running} onClick={diskNow} data-testid="solo-disk-now">
          <span className="ic"><LuHardDrive size={16} /></span> {busy === 'disk' || disk.running ? t('Сохраняем…') : t('Сделать копию на диск сейчас')}
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={diskOpen} data-testid="solo-disk-open">
          <span className="ic"><LuFolderOpen size={16} /></span> {t('Открыть папку копий')}
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted-2)', marginTop: 10, lineHeight: 1.6 }}>
        {t('«Сохранить копию в…» — выберите флешку: программа положит туда папку с копией. Сама программа каждый день снимает копию в свою папку (7 последних) и на диск D (15 последних).')}
      </p>
      {restoring && (
        <Modal wide title={t('Загрузить копию базы')} onClose={() => setRestoring(false)}>
          <RestoreView st={st} onBack={() => setRestoring(false)} />
        </Modal>
      )}
    </div>
  )
}
