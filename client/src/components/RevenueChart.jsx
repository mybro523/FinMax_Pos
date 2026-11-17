import { useSyncExternalStore } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import { money } from '../db/store'
import { translate as tr } from '../lib/i18n'
import { useLite } from '../lib/lite'

// Доход сервиса по месяцам. Вынесено отдельным файлом: библиотека диаграмм весит
// около 370 КБ и грузится уже после того, как показаны числа и список магазинов —
// панель открывается мгновенно, а график догоняет.

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const TOOLTIP = {
  borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text)', fontSize: 13,
}

// «2026-08» → «авг 26». Год нужен: двенадцать столбиков пересекают его границу
function label(key) {
  const [y, m] = String(key).split('-')
  return `${MONTHS[Number(m) - 1] || m} ${String(y).slice(2)}`
}

// ── Узкий экран ──
// Размеры осей диаграмма считает на стороне кода, не по CSS: ширину шкалы слева
// и высоту области медиазапросом не задать. Поэтому спрашиваем ширину экрана
// сами. Через matchMedia, а не по событию resize: браузер сам сообщает только
// о пересечении границы, и лишних перерисовок при повороте телефона не будет.
const NARROW = '(max-width: 560px)'
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => {}
      const mq = matchMedia(NARROW)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => (typeof matchMedia === 'function' ? matchMedia(NARROW).matches : false),
    () => false,
  )
}

// ── Шкала сумм на телефоне (18.11.2026) ──
// Подписи там 12 px, а шкала узкая: «60000» обрезалось слева до «0000», и владелец читал
// неверные числа. Поэтому на телефоне суммы на шкале — коротко («15 тыс.», «1,3 млн»), деления —
// свои (известны заранее), а ширина шкалы — по самой длинной подписи. На компьютере шкала прежняя
const TICK_FONT = 12
// Красивый шаг шкалы: четыре деления покрывают максимум, шаг — 1, 1,5, 2, 2,5, 3, 4, 5, 6, 8 × 10ⁿ
function phoneTicks(max) {
  if (!(max > 0)) return null
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((s) => s >= raw)
  return [0, 1, 2, 3, 4].map((i) => Math.round(i * step * 100) / 100)
}
// До двух знаков после запятой, без лишних нулей: 1,05 · 1,5 · 15
const short = (x) => String(Math.round(x * 100) / 100).replace('.', ',')
function shortMoney(v) {
  const a = Math.abs(v)
  if (a < 1000) return short(v)
  if (a < 1e6) return `${short(v / 1000)} ${tr('тыс.')}`
  return `${short(v / 1e6)} ${tr('млн')}`
}
// Подпись шкалы на телефоне. style — не для вида: по нему диаграмма меряет подпись, решая,
// переносить ли её. Без него (и с размером числом, без «px») мерила шрифтом страницы, он
// крупнее, и «800 тыс.» рвалось на две строки
const PHONE_TICK = { fontSize: TICK_FONT, fill: 'var(--muted)', style: { fontSize: `${TICK_FONT}px` } }
// Ширина подписи шрифтом страницы; без холста — с запасом, по 7,5 px на знак
let canvasCtx = null
function textWidth(s) {
  try {
    if (!canvasCtx) canvasCtx = document.createElement('canvas').getContext('2d')
    canvasCtx.font = `${TICK_FONT}px ${getComputedStyle(document.body).fontFamily}`
    return canvasCtx.measureText(s).width
  } catch {
    return s.length * 7.5
  }
}

export default function RevenueChart({ data }) {
  const narrow = useNarrow()
  const animate = !useLite()
  const rows = (data || []).map((r) => ({ ...r, label: label(r.month) }))
  // Последний столбик — текущий месяц, он ещё не закончился. Красим иначе,
  // иначе «спад в этом месяце» пугал бы каждое первое число.
  const last = rows.length - 1
  // Телефон: деления и ширина шкалы. Текст подписи кончается в 8 px от края шкалы (риска 6 px
  // и отступ 2 px — так рисует сама диаграмма), ещё 2 px — запас
  const ticks = narrow ? phoneTicks(Math.max(0, ...rows.map((r) => Number(r.amount) || 0))) : null
  const yWidth = ticks ? Math.ceil(Math.max(...ticks.map((v) => textWidth(shortMoney(v))))) + 10 : narrow ? 46 : 64

  return (
    // Отступ снизу — свой, а не общий: на этой странице блоки разделяются вручную,
    // и у графика его просто забыли. Без него «Требуют внимания» прилипал к оси.
    <div className="panel" style={{ marginBottom: 20 }}>
      <h2><span className="h2-title">{tr('Доход по месяцам')}</span></h2>
      <div style={{ width: '100%', height: narrow ? 170 : 220 }}>
        <ResponsiveContainer>
          {/* Отступ слева на телефоне — 0: при отрицательном шкала уходила за край и подписи обрезались */}
          <BarChart data={rows} margin={{ top: 8, right: 8, left: narrow ? 0 : -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            {/* На телефоне двенадцать подписей слиплись бы в кашу — показываем каждую третью.
                Шрифт на телефоне — 12 px (17.11.2026: подписи читают, мельче 12 не берём) */}
            <XAxis
              dataKey="label"
              tick={{ fontSize: narrow ? TICK_FONT : 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              interval={narrow ? 2 : 'preserveEnd'}
              minTickGap={narrow ? 2 : 5}
            />
            <YAxis
              tick={ticks ? PHONE_TICK : { fontSize: narrow ? TICK_FONT : 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              width={yWidth}
              {...(ticks ? { ticks, domain: [0, ticks[4]], interval: 0, tickFormatter: shortMoney } : {})}
            />
            <Tooltip
              contentStyle={TOOLTIP}
              cursor={{ fill: 'var(--soft)' }}
              formatter={(v) => [money(v), tr('Доход')]}
            />
            <Bar dataKey="amount" radius={[6, 6, 0, 0]} isAnimationActive={animate}>
              {rows.map((r, i) => (
                <Cell key={r.month} fill={i === last ? '#8aa5e3' : '#00359f'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="tag-cat" style={{ marginTop: 6 }}>
        {tr('Последний столбик — текущий месяц, он ещё не закончился')}
      </div>
    </div>
  )
}
