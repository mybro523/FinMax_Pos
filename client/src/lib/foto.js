// ── Фото товара: сжатие перед сохранением ──
//
// Снимок с телефона весит мегабайты, а в карточке товара нужен маленький кадр.
// Поэтому фото сжимается прямо в браузере до 512 точек по длинной стороне и
// сохраняется строкой (data:image/jpeg). Такая строка спокойно живёт в базе,
// уезжает в снимок кассы и работает без интернета.

export const FOTO_MAX_SIDE = 512
export const FOTO_MAX_CHARS = 200_000 // предел и на сервере — не меняется молча

export function szhatFoto(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Выберите файл с картинкой'))
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const k = Math.min(1, FOTO_MAX_SIDE / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * k))
      const h = Math.max(1, Math.round(img.height * k))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      // Прозрачный PNG на белом: JPEG не умеет прозрачность, без заливки она стала бы чёрной
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      // Качество подбираем под предел длины: почти всегда хватает первого прохода
      for (const q of [0.82, 0.7, 0.55, 0.4]) {
        const data = canvas.toDataURL('image/jpeg', q)
        if (data.length <= FOTO_MAX_CHARS) return resolve(data)
      }
      reject(new Error('Фото слишком детальное — попробуйте другой снимок'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Файл не открылся как картинка'))
    }
    img.src = url
  })
}
