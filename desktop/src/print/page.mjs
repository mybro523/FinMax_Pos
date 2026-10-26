// ── Печать листа: что окно может попросить ──
//
// Экран печати программы (client/src/components/PrintPreview.jsx) показывает страницы
// и просит основную часть напечатать их или положить в PDF. Здесь — только проверка
// просьбы и параметры для движка печати, без Electron: так их можно проверить.
//
// Предпросмотр и печать обязаны совпадать, поэтому PDF для предпросмотра и задание
// на принтер собираются из одних и тех же значений: лист A4 (или наклейка своего
// размера), ориентация, фон печатается. Поля и номера страниц задают стили печатного слоя.
import { labelSize, pageMicrons } from './labels.mjs'

// Наклейка на принтере этикеток — по умолчанию 58 × 40 мм; размер присылает окно
export const STICKER_MM = { width: 58, height: 40 }
const MM_PER_INCH = 25.4

// Просьба окна → проверенные значения: принтер — строкой не длиннее 220 знаков
// (пусто — принтер по умолчанию), копий — от 1 до 99; у наклейки — её размер, мм
export function pageRequest(req) {
  const roll = req?.roll === true
  return {
    printer: typeof req?.printer === 'string' ? req.printer.slice(0, 220) : '',
    // Наклейка всегда по размеру этикетки — её не поворачивают
    landscape: !roll && req?.landscape === true,
    roll,
    copies: Math.max(1, Math.min(99, Math.trunc(Number(req?.copies) || 1))),
    ...(roll ? { size: labelSize(req?.size, { w: STICKER_MM.width, h: STICKER_MM.height }) } : {}),
  }
}

// Для PDF (предпросмотр и «Сохранить в PDF»): размер — в дюймах
export function pdfOptions({ landscape, roll, size }) {
  const s = size || { w: STICKER_MM.width, h: STICKER_MM.height }
  return {
    printBackground: true,
    landscape: !!landscape && !roll,
    pageSize: roll ? { width: s.w / MM_PER_INCH, height: s.h / MM_PER_INCH } : 'A4',
  }
}

// Для задания на принтер: без окна печати Windows, на выбранный принтер. Наклейка —
// страницей ровно своего размера (в микронах) и без полей: без размера новый движок
// печати отдал бы принтеру этикеток лист A4
export function printOptions({ printer, landscape, roll, copies, size }) {
  const s = size || { w: STICKER_MM.width, h: STICKER_MM.height }
  return {
    silent: true,
    deviceName: printer,
    printBackground: true,
    landscape: !!landscape && !roll,
    copies,
    ...(roll ? { margins: { marginType: 'none' }, pageSize: pageMicrons(s) } : { pageSize: 'A4' }),
  }
}

// ── Принтеры, которые сохраняют файл, а не печатают ──
// «Microsoft Print to PDF», «XPS Document Writer», «OneNote», «Факс» — вместо бумаги они
// спрашивают имя файла. На старом движке (программа для Windows 7 и 8, Electron 22)
// печать на них без окна печати зависает или роняет окно программы — а в Windows 7
// такой принтер часто стоит по умолчанию. Поэтому там программа на них не печатает и
// предлагает «Сохранить в PDF».
// list — ответ getPrintersAsync(), name — выбранный принтер (пусто — принтер по умолчанию).
// 'file' — принтер сохраняет файл; 'none' — в Windows нет ни одного принтера; null — печатать.
// Узнаём по драйверу и имени: любые «PDF-принтеры» (Microsoft Print to PDF, Adobe PDF, PDF24,
// doPDF…), XPS, OneNote, Office Document Image Writer, драйвер общего факса Microsoft и сам
// «Факс». Настоящий аппарат с FAX в названии модели (Brother FAX-2840) — принтер, его не трогаем
const FILE_PRINTER = /pdf|xps document writer|onenote|document image writer|shared fax driver/i
const FAX_NAME = /^(fax|факс)$/i

export function printerKind(list, name) {
  // Список принтеров не прочитался — решать не по чему: печатает движок, как обычно
  if (!Array.isArray(list)) return null
  const all = list.filter((p) => p && typeof p.name === 'string')
  if (!all.length) return name ? null : 'none'
  // Принтер по умолчанию не назначен, а принтеров несколько — пусть решает движок
  const p = name ? all.find((x) => x.name === name) : all.find((x) => x.isDefault) || (all.length === 1 ? all[0] : null)
  if (!p) return null
  if (FAX_NAME.test(p.name.trim())) return 'file'
  const text = [p.name, p.displayName, p.options?.['printer-make-and-model'], p.options?.system_driverinfo].filter((x) => typeof x === 'string').join(' ')
  return FILE_PRINTER.test(text) ? 'file' : null
}
