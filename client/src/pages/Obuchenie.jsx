import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  LuSearch, LuCircleHelp, LuListChecks, LuTriangleAlert, LuArrowRight, LuPlay, LuCircleCheck, LuGraduationCap,
} from 'react-icons/lu'
import Layout, { NAV } from '../components/Layout'
import { useAuth } from '../db/auth'
import { useT, useLang } from '../lib/i18n'
import { urokiFor, ekranFor } from '../lib/obuchenie'
import { OBUCHENIE_TG } from '../lib/obuchenie-tg'
import { startTour, useToursDone, OBSHIY } from '../lib/tur'

// ── Обучение ──
//
// Два способа разобраться в программе. Тур — программа сама ведёт по кнопкам
// раздела и подсвечивает каждую. Справочник — тот же текст, но спокойно почитать
// и вернуться к нему, когда забыл то, что делают раз в месяц.
//
// Текст у них один: туры собираются из этих же уроков (lib/tury.js), поэтому
// разойтись им негде. Здесь справочник и кнопки запуска туров с отметкой
// «пройдено».
//
// Подписи и значки берём из самого меню, чтобы урок назывался ровно так же,
// как пункт, который человек ищет глазами.

const menuInfo = (to) => NAV.find((n) => n.to === to) || {}

export default function Obuchenie() {
  const t = useT()
  const lang = useLang()
  const isFounder = useAuth()?.role === 'founder'
  const done = useToursDone()
  const uroki = useMemo(() => urokiFor(isFounder), [isFounder])
  const [openTo, setOpenTo] = useState(uroki[0]?.to || '/pos')
  const [q, setQ] = useState('')

  // Текст урока: сначала словарь уроков, потом общий — в уроках встречаются
  // и названия кнопок, которые уже переведены для самого интерфейса
  const tu = (s) => (lang === 'tg' ? OBUCHENIE_TG[s] ?? t(s) : s)

  // Ищем по всему тексту урока и на обоих языках: человек помнит «половина
  // пачки», а не «Касса», и может искать по-русски при таджикском интерфейсе
  const найдено = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return uroki
    return uroki.filter((u) => {
      const строки = [
        menuInfo(u.to).label || '', u.zachem,
        ...ekranFor(u, isFounder).flatMap(([a, b]) => [a, b]),
        ...u.shagi, ...u.oshibki,
      ]
      const всё = строки.flatMap((x) => [x, OBUCHENIE_TG[x] ?? t(x)]).join(' ').toLowerCase()
      return всё.includes(s)
    })
  }, [q, uroki, t, isFounder])

  const urok = найдено.find((u) => u.to === openTo) || найдено[0] || null
  const info = urok ? menuInfo(urok.to) : {}
  const Icon = info.Icon || LuCircleHelp
  const пройдено = uroki.filter((u) => done.includes(u.to)).length

  return (
    <Layout
      title={t('Обучение')}
      subtitle={t('Как пользоваться программой — по каждому разделу')}
      actions={
        <button className="btn ghost" data-tour="uch.obshiy" onClick={() => startTour(OBSHIY)}>
          <span className="ic"><LuGraduationCap size={16} /></span> {t('Общий тур')}
        </button>
      }
    >
      <div className="uchebnik">
        {/* ── Слева: все разделы ── */}
        <div className="panel uch-list">
          <div className="uch-search">
            <LuSearch size={15} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('Найти: возврат, скидка, смена…')}
              aria-label={t('Поиск по обучению')}
            />
          </div>

          <div className="uch-progress">
            {t('Туров пройдено')}: <b>{пройдено}</b> / {uroki.length}
          </div>

          {найдено.length === 0 && <div className="empty">{t('Ничего не нашлось. Попробуйте другое слово.')}</div>}

          <nav>
            {найдено.map((u) => {
              const m = menuInfo(u.to)
              const I = m.Icon || LuCircleHelp
              return (
                <button
                  key={u.to}
                  className={'uch-item' + (urok && u.to === urok.to ? ' active' : '')}
                  onClick={() => setOpenTo(u.to)}
                >
                  <span className="ic"><I size={16} /></span>
                  <span className="uch-item-name">{t(m.label || u.to)}</span>
                  {done.includes(u.to) && (
                    <span className="uch-done" title={t('пройдено')} aria-label={t('пройдено')}>
                      <LuCircleCheck size={15} />
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

        {/* ── Справа: сам урок ── */}
        {urok && (
          <div className="panel uch-body">
            <h2>
              <span className="h2-title">
                <span className="ic"><Icon size={18} /></span>
                {t(info.label || '')}
              </span>
              {done.includes(urok.to) && <span className="badge ok">{t('пройдено')}</span>}
            </h2>

            <p className="uch-lead">{tu(urok.zachem)}</p>

            {/* Главное действие урока — пройти тур: программа сама покажет каждую кнопку */}
            <button className="btn uch-start" data-tour="uch.start" onClick={() => startTour(urok.to)}>
              <span className="ic"><LuPlay size={16} /></span> {t('Пройти тур по разделу')}
            </button>

            <h3 className="uch-h3">
              <span className="ic"><LuCircleHelp size={15} /></span> {t('Что на экране')}
            </h3>
            <dl className="uch-dl">
              {ekranFor(urok, isFounder).map(([что, зачем]) => (
                <div key={что + зачем}>
                  <dt>{tu(что)}</dt>
                  <dd>{tu(зачем)}</dd>
                </div>
              ))}
            </dl>

            <h3 className="uch-h3">
              <span className="ic"><LuListChecks size={15} /></span> {t('Как это делается')}
            </h3>
            <ol className="uch-steps">
              {urok.shagi.map((ш) => <li key={ш}>{tu(ш)}</li>)}
            </ol>

            <h3 className="uch-h3">
              <span className="ic" style={{ color: 'var(--warn)' }}><LuTriangleAlert size={15} /></span>{' '}
              {t('Частые ошибки')}
            </h3>
            <ul className="uch-warn">
              {urok.oshibki.map((о) => <li key={о}>{tu(о)}</li>)}
            </ul>

            <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="btn" onClick={() => startTour(urok.to)}>
                <span className="ic"><LuPlay size={16} /></span> {t('Пройти тур по разделу')}
              </button>
              <Link to={urok.to} className="btn ghost">
                {t('Открыть раздел')} <span className="ic"><LuArrowRight size={16} /></span>
              </Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
