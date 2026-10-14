// ── Экспорт в Excel: настоящий .xlsx, а не сжатый CSV ──
//
// CSV Excel открывает «сжато»: узкие колонки, всё текстом, без заголовка.
// Здесь строится нормальный лист: заголовок с названием магазина, подзаголовок
// с периодом, жирная шапка на фирменном синем, подобранные ширины колонок,
// деньги — числами с форматом (их можно сразу суммировать), итоговая строка.
//
// Сама библиотека тяжёлая, поэтому грузится только в момент нажатия кнопки.

const THIN = { style: 'thin', color: { argb: 'FFB9C2D4' } }
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }

// cols: [{ header, key, width, money?, num? }]
// rows: [{ key: значение }]
// itogi: { key: значение } — итоговая строка жирным (не обязательна)
export async function skachatXlsx({ fayl, zagolovok, podzag, cols, rows, itogi }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Лист1', { views: [{ state: 'frozen', ySplit: 4 }] })
  ws.columns = cols.map((c) => ({ width: c.width || 16 }))
  const n = cols.length

  ws.mergeCells(1, 1, 1, Math.max(2, n))
  const title = ws.getCell(1, 1)
  title.value = zagolovok
  title.font = { bold: true, size: 15 }
  ws.getRow(1).height = 24

  ws.mergeCells(2, 1, 2, Math.max(2, n))
  const sub = ws.getCell(2, 1)
  sub.value = podzag || ''
  sub.font = { size: 11, color: { argb: 'FF5B6577' } }

  const head = ws.getRow(4)
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00359F' } }
    cell.alignment = { horizontal: c.money || c.num ? 'right' : 'left', vertical: 'middle' }
    cell.border = BORDER
  })
  head.height = 22

  for (const r of rows) {
    const row = ws.addRow(cols.map((c) => r[c.key] ?? ''))
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1)
      cell.border = BORDER
      if (c.money) {
        cell.numFmt = '#,##0.00'
        cell.alignment = { horizontal: 'right' }
      } else if (c.num) {
        cell.alignment = { horizontal: 'right' }
      }
    })
  }

  if (itogi) {
    const row = ws.addRow(cols.map((c) => itogi[c.key] ?? ''))
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1)
      cell.font = { bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F9' } }
      cell.border = BORDER
      if (c.money) {
        cell.numFmt = '#,##0.00'
        cell.alignment = { horizontal: 'right' }
      } else if (c.num) {
        cell.alignment = { horizontal: 'right' }
      }
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fayl + '.xlsx'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
