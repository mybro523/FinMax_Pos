// ── Сводка по статьям ──
// Для выгрузки и печати расходов и доходов: сколько записей и на какую сумму по каждой
// статье, крупные сверху, и доля каждой в итоге. Отдаёт готовую таблицу в том виде,
// который понимают skachatXlsx (второй лист) и PrintSheet (таблица над журналом).
//
// rows — записи журнала ({ category, amount }); t — перевод названий статей.
export function byCategory(rows, t, { list, zagolovok, podzag } = {}) {
  const map = new Map()
  let total = 0
  for (const r of rows || []) {
    const sum = Number(r?.amount) || 0
    const key = r?.category || '—'
    const cur = map.get(key) || { count: 0, sum: 0 }
    cur.count += 1
    cur.sum += sum
    map.set(key, cur)
    total += sum
  }
  const round = (x) => Math.round(x * 100) / 100
  const share = (x) => (total > 0 ? `${Math.round((x / total) * 1000) / 10}%` : '')
  const out = [...map.entries()]
    .sort((a, b) => b[1].sum - a[1].sum)
    .map(([name, v]) => ({ category: t(name), count: v.count, share: share(v.sum), sum: round(v.sum) }))
  return {
    list,
    zagolovok,
    podzag,
    cols: [
      { header: t('Статья'), key: 'category', width: 30 },
      { header: t('Записей'), key: 'count', width: 10, num: true },
      { header: t('Доля'), key: 'share', width: 10, num: true },
      { header: t('Сумма'), key: 'sum', width: 16, money: true },
    ],
    rows: out,
    itogi: { category: t('Итого'), count: (rows || []).length, share: total > 0 ? '100%' : '', sum: round(total) },
  }
}
