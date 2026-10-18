import { useEffect, useState } from 'react'
import {
  LuTrendingUp, LuBriefcase, LuChartColumn, LuCalculator, LuCalendar, LuWallet, LuCog, LuWorkflow, LuTarget,
  LuChartPie, LuChartLine, LuShield, LuCpu, LuCircleCheck, LuPhone, LuMessageCircle, LuMail, LuGlobe,
  LuInstagram, LuFacebook, LuYoutube, LuQuote, LuExternalLink, LuLayers,
} from 'react-icons/lu'
import Layout from '../components/Layout'
import { BrandWord, useToast } from '../components/ui'
import { useT } from '../lib/i18n'
import { bridge, isDesktop } from '../lib/desktop'
import { COMPANY, COMPANY_CONTACTS, ICONS8 } from '../lib/company'
import emblem from '../assets/brand/emblem-64.png'
import founderPhoto from '../assets/brand/founder.jpg'

// ── О компании ──
// Кнопка в шапке главного меню. Кто сделал программу, чем ещё занимается компания
// и как с ней связаться. Данные — с сайта finmax.tj (lib/company.js).
//
// На сайте ссылки — обычные. Программа для Windows не открывает в своём окне чужие
// адреса вовсе, поэтому там ссылку открывает внешний браузер по имени ссылки
// (bridge.app.open): окно не может попросить открыть произвольный адрес.

// Значки — как у тех же услуг на сайте компании
const SERVICE_ICONS = {
  consult: LuTrendingUp, business: LuBriefcase, analysis: LuChartColumn, accounting: LuCalculator,
  budget: LuCalendar, cashflow: LuWallet, automation: LuCog, optimization: LuWorkflow,
  kpi: LuTarget, profitability: LuChartPie, strategy: LuChartLine, audit: LuShield,
}
const AUTOMATION_ICONS = { trade: LuWorkflow, production: LuCpu, medical: LuShield, lab: LuChartColumn }
const CONTACT_ICONS = { phone: LuPhone, whatsapp: LuMessageCircle, email: LuMail, site: LuGlobe, instagram: LuInstagram, facebook: LuFacebook, youtube: LuYoutube }

// Заголовок блока — как на сайте компании: над ним золотая подпись, конец — золотом.
// Где начинается золотая часть, отмечает «|» в тексте: в таджикском порядок слов
// другой, и в переводе черта стоит там, где нужно по смыслу
function BlockHead({ kicker, title }) {
  const [a, b = ''] = title.split('|')
  return (
    <div className="about-head">
      <span className="about-kicker">{kicker}</span>
      <h2 className="about-title">{a} <span className="about-gold">{b}</span></h2>
    </div>
  )
}

// Карточка услуги: значок, название, описание и — у услуг по финансам — два пункта с
// галочкой. Пункты прижаты к низу карточки, чтобы в ряду стояли на одной линии
function ServiceCard({ icon: Icon = LuBriefcase, title, text, points }) {
  return (
    <div className="about-card">
      <span className="about-card-ic" aria-hidden="true"><Icon size={20} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      {points && (
        <ul className="about-points">
          {points.map((p) => (
            <li key={p}><LuCircleCheck size={14} aria-hidden="true" /> {p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function About() {
  const t = useT()
  const toast = useToast()
  const [version, setVersion] = useState('')

  // Версия программы — чтобы назвать её в поддержке
  useEffect(() => {
    if (!bridge?.info) return
    bridge.info().then((i) => setVersion(i?.version || '')).catch(() => {})
  }, [])

  // В программе — внешний браузер (или почта, или звонилка) по имени ссылки
  const openInApp = (e, key) => {
    if (!isDesktop) return
    e.preventDefault()
    if (!bridge?.app?.open) return toast(t('Ссылка открывается на сайте программы'), 'err')
    bridge.app.open(key).then((ok) => { if (!ok) toast(t('Не получилось открыть ссылку'), 'err') }).catch(() => toast(t('Не получилось открыть ссылку'), 'err'))
  }

  return (
    <Layout title={t('О компании')} subtitle="FinMax">
      <div className="about">
        <section className="panel about-hero">
          <div className="about-hero-head">
            <img src={emblem} alt="" width="64" height="64" className="about-emblem" />
            <div>
              <div className="about-name"><BrandWord bare /></div>
              <div className="about-tagline">{t(COMPANY.tagline)}</div>
            </div>
          </div>
          <p className="about-text">{t(COMPANY.about)}</p>
          <div className="about-motto"><LuQuote size={16} aria-hidden="true" /> {t(COMPANY.motto)}</div>
          <div className="about-stats">
            {COMPANY.stats.map((s) => (
              <div key={s.value} className="about-stat">
                <b>{s.value}</b>
                <span>{t(s.label)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" data-about="services">
          <BlockHead kicker={t('Наши услуги по')} title={t('Финансовому|управлению')} />
          <div className="about-cards">
            {COMPANY.services.map((s) => (
              <ServiceCard key={s.key} icon={SERVICE_ICONS[s.key]} title={t(s.title)} text={t(s.text)} points={s.points.map((p) => t(p))} />
            ))}
          </div>
        </section>

        <section className="panel" data-about="automation">
          <BlockHead kicker={t('Наши услуги')} title={t('Автоматизация|под ваш бизнес')} />
          <div className="about-cards two">
            {COMPANY.automation.map((s) => (
              <ServiceCard key={s.key} icon={AUTOMATION_ICONS[s.key]} title={t(s.title)} text={t(s.text)} />
            ))}
          </div>
          <div className="about-systems">
            <h3><LuLayers size={15} aria-hidden="true" /> {t('Системы FinMax')}</h3>
            <div className="about-chips">{COMPANY.systems.map((x) => <span key={x} className="about-chip">{t(x)}</span>)}</div>
          </div>
        </section>

        <div className="about-row">
          <section className="panel about-founder">
            <img src={founderPhoto} alt={t(COMPANY.founder.name)} width="120" height="120" className="about-avatar" />
            <div>
              <b className="about-founder-name">{t(COMPANY.founder.name)}</b>
              <div className="about-founder-role">{t(COMPANY.founder.role)}</div>
              <p className="about-founder-quote">{t(COMPANY.founder.quote)}</p>
            </div>
          </section>

          <section className="panel about-contacts">
            <h2><span className="h2-title"><span className="ic"><LuPhone size={17} /></span>{t('Контакты')}</span></h2>
            <div className="about-contact-list">
              {COMPANY_CONTACTS.map((c) => {
                const Icon = CONTACT_ICONS[c.key] || LuGlobe
                const web = c.href.startsWith('http')
                return (
                  <a
                    key={c.key}
                    className="about-contact"
                    href={c.href}
                    onClick={(e) => openInApp(e, c.key)}
                    {...(web ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  >
                    <span className={'about-contact-ic ' + c.key}><Icon size={18} /></span>
                    <span className="about-contact-txt">
                      <span>{t(c.label)}</span>
                      <b>{c.value}</b>
                    </span>
                    {web && <LuExternalLink size={14} className="about-contact-go" aria-hidden="true" />}
                  </a>
                )
              })}
            </div>
          </section>
        </div>

        <div className="about-foot">
          <BrandWord /> — {t('программа для торговли от компании FinMax')}{version ? ` · ${t('версия')} ${version}` : ''}
          <div className="about-credits">
            {t('Иконки')}:{' '}
            <a href={ICONS8.href} target="_blank" rel="noopener noreferrer" onClick={(e) => openInApp(e, ICONS8.key)}>Icons8</a>
          </div>
        </div>
      </div>
    </Layout>
  )
}
