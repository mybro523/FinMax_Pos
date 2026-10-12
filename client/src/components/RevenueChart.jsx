import { useSyncExternalStore } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import { money } from '../db/store'
import { translate as tr } from '../lib/i18n'

// Доход сервиса по месяцам. Вынесено отдельным файлом: библиотека диаграмм весит
// около 370 КБ и грузится уже после того, как показаны числа и список аптек —
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

export default function RevenueChart({ data }) {
  const narrow = useNarrow()
  const rows = (data || []).map((r) => ({ ...r, label: label(r.month) }))
  // Последний столбик — текущий месяц, он ещё не закончился. Красим иначе,
  // иначе «спад в этом месяце» пугал бы каждое первое число.
  const last = rows.length - 1

  return (
    // Отступ снизу — свой, а не общий: на этой странице блоки разделяются вручную,
    // и у графика его просто забыли. Без него «Требуют внимания» прилипал к оси.
    <div className="panel" style={{ marginBottom: 20 }}>
      <h2><span className="h2-title">{tr('Доход по месяцам')}</span></h2>
      <div style={{ width: '100%', height: narrow ? 170 : 220 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: narrow ? -8 : -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            {/* На телефоне двенадцать подписей слиплись бы в кашу — показываем каждую третью */}
            <XAxis
              dataKey="label"
              tick={{ fontSize: narrow ? 10 : 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              interval={narrow ? 2 : 'preserveEnd'}
              minTickGap={narrow ? 2 : 5}
            />
            <YAxis
              tick={{ fontSize: narrow ? 10 : 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              width={narrow ? 40 : 64}
            />
            <Tooltip
              contentStyle={TOOLTIP}
              cursor={{ fill: 'var(--soft)' }}
              formatter={(v) => [money(v), tr('Доход')]}
            />
            <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
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
