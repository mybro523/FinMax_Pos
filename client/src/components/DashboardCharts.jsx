import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell,
} from 'recharts'
import { LuTrendingUp, LuBoxes } from 'react-icons/lu'
import { money } from '../db/store'
import { translate as tr } from '../lib/i18n'

// Графики вынесены в отдельный файл: библиотека диаграмм весит ~370 КБ и грузится
// уже после того, как показаны карточки и таблицы — панель открывается мгновенно.

const COLORS = ['#00359f', '#2a58bf', '#5a7fd3', '#8aa5e3', '#b5c5ee', '#d8e1f6']
const TOOLTIP = {
  borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--card)', color: 'var(--text)', fontSize: 13,
}

export default function DashboardCharts({ chart, topProducts, onDay, onProduct }) {
  return (
    <>
      <div className="panel" data-tour="dash.chart">
        <h2>
          <span className="h2-title"><span className="ic"><LuTrendingUp size={17} /></span>{tr('Продажи за 10 дней')}</span>
          <span className="tag-cat">{tr('клик по дню — детали')}</span>
        </h2>
        <ResponsiveContainer width="100%" height={258}>
          <AreaChart
            data={chart} margin={{ left: -12, right: 8 }} style={{ cursor: 'pointer' }}
            onClick={(e) => { const pt = e?.activePayload?.[0]?.payload; if (pt) onDay(pt) }}
          >
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00359f" stopOpacity={0.18} />
                <stop offset="100%" stopColor="#00359f" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--track)" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 12, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 12, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={50} />
            <Tooltip formatter={(v) => money(v)} contentStyle={TOOLTIP} />
            <Area
              type="monotone" dataKey="sum" stroke="#00359f" strokeWidth={2.5} fill="url(#g)"
              activeDot={{ r: 5, fill: '#efbd24', stroke: '#fff', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="panel" data-tour="dash.top">
        <h2>
          <span className="h2-title"><span className="ic"><LuBoxes size={17} /></span>{tr('Топ товаров')}</span>
          <span className="tag-cat">{tr('клик — детали')}</span>
        </h2>
        <ResponsiveContainer width="100%" height={258}>
          <BarChart data={topProducts} layout="vertical" margin={{ left: 8, right: 12 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category" dataKey="name" width={140} axisLine={false} tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--text)' }}
              tickFormatter={(n) => (n.length > 18 ? n.slice(0, 18) + '…' : n)}
            />
            <Tooltip formatter={(v) => money(v)} contentStyle={TOOLTIP} cursor={{ fill: 'var(--hover)' }} />
            <Bar dataKey="sum" radius={[0, 5, 5, 0]} barSize={17} cursor="pointer" onClick={(d) => d && onProduct(d.name)}>
              {topProducts.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}
