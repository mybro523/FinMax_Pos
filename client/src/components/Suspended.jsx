import { LuLockKeyhole } from 'react-icons/lu'
import { useT } from '../lib/i18n'

// ── Работу остановили прямо сейчас ──
// Владелец сервиса нажал «Приостановить», и связь с магазином сейчас оборвётся.
// Без этого экрана кассир увидел бы только пропавшее соединение и решил, что
// виноват интернет: продолжил бы работать, упёрся в отказ посреди продажи и
// позвонил бы жаловаться на поломку. Причина должна быть на экране — крупно,
// сразу и без «Обновите страницу».
// title — свой заголовок: программа для Windows закрывает работу и тогда, когда
// слишком долго не было связи с сервером, и «приостановлена» тут было бы неправдой.
export default function Suspended({ message, title, onClose }) {
  const t = useT()
  return (
    <div className="login-screen">
      <div className="login-card suspended-card">
        <div className="login-logo stop"><LuLockKeyhole size={28} strokeWidth={2.5} /></div>
        <h1>{title ? t(title) : t('Работа приостановлена')}</h1>
        <p className="suspended-text">{t(message)}</p>
        <button className="btn primary block" onClick={onClose}>{t('Понятно')}</button>
      </div>
    </div>
  )
}
