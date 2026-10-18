// ── Печать листа: что окно может попросить ──
//
// Экран печати программы (client/src/components/PrintPreview.jsx) показывает страницы
// и просит основную часть напечатать их или положить в PDF. Здесь — только проверка
// просьбы и параметры для движка печати, без Electron: так их можно проверить.
//
// Предпросмотр и печать обязаны совпадать, поэтому PDF для предпросмотра и задание
// на принтер собираются из одних и тех же значений: лист A4 (или наклейка 58×40 мм),
// ориентация, фон печатается. Поля и номера страниц задают стили печатного слоя.

// Наклейка на термопринтере этикеток: 58 × 40 мм
export const STICKER_MM = { width: 58, height: 40 }
const MM_PER_INCH = 25.4

// Просьба окна → проверенные значения: принтер — строкой не длиннее 220 знаков
// (пусто — принтер по умолчанию), копий — от 1 до 99
export function pageRequest(req) {
  const roll = req?.roll === true
  return {
    printer: typeof req?.printer === 'string' ? req.printer.slice(0, 220) : '',
    // Наклейка всегда по размеру этикетки — её не поворачивают
    landscape: !roll && req?.landscape === true,
    roll,
    copies: Math.max(1, Math.min(99, Math.trunc(Number(req?.copies) || 1))),
  }
}

// Для PDF (предпросмотр и «Сохранить в PDF»): размер — в дюймах
export function pdfOptions({ landscape, roll }) {
  return {
    printBackground: true,
    landscape: !!landscape && !roll,
    pageSize: roll ? { width: STICKER_MM.width / MM_PER_INCH, height: STICKER_MM.height / MM_PER_INCH } : 'A4',
  }
}

// Для задания на принтер: без окна печати Windows, на выбранный принтер. Наклейка —
// на бумаге, которая заправлена в принтер этикеток (её размер знает его драйвер)
export function printOptions({ printer, landscape, roll, copies }) {
  return {
    silent: true,
    deviceName: printer,
    printBackground: true,
    landscape: !!landscape && !roll,
    copies,
    ...(roll ? {} : { pageSize: 'A4' }),
  }
}
