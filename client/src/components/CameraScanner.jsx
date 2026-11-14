import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { decodeGray, grayOf } from '../lib/scanWorker'
import { LuCamera, LuImage, LuTriangleAlert, LuScanLine, LuZoomIn, LuFlashlight } from 'react-icons/lu'
import { overlayHost, useBackdropClose } from './ui'

// Сколько раз подряд код должен совпасть, чтобы его принять (защита от misread)
const CONFIRM = 2

// Пауза между распознаваниями. Распознавание идёт в фоновом потоке (lib/scanWorker.js):
// страница только снимает маленький кадр, видео не ждёт. 110 мс — ~9 попыток в секунду.
// Нет фонового потока (очень старый браузер) — разбор в странице, но реже: 260 мс
const SCAN_MS = 110
const SCAN_MS_MAIN = 260
// Кадр для цикла — не шире 640 точек: штрихкоду хватает, а работы вчетверо меньше
const LOOP_W = 640

// Те же форматы для встроенного распознавателя браузера (Chrome/Android —
// аппаратный, почти не грузит процессор). Если он знает меньше пяти наших
// форматов — реализация куцая, работаем ZXing-ом
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'data_matrix', 'qr_code', 'aztec']

async function makeNativeDetector() {
  try {
    if (!('BarcodeDetector' in window)) return null
    const sup = await window.BarcodeDetector.getSupportedFormats()
    const formats = NATIVE_FORMATS.filter((f) => sup.includes(f))
    if (formats.length < 5) return null
    return new window.BarcodeDetector({ formats })
  } catch {
    return null
  }
}

export default function CameraScanner({ onDetect, onClose }) {
  const backdrop = useBackdropClose(onClose)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const detectorRef = useRef(null) // встроенный распознаватель браузера (если есть)
  const workerRef = useRef(null) // фоновый поток распознавания (lib/scanWorker.js)
  const waitRef = useRef(new Map()) // id кадра → ответ фонового потока
  const seqRef = useRef(0)
  const scanTimerRef = useRef(null)
  const scanCanvasRef = useRef(null) // переиспользуемый холст кадра — без мусора в памяти
  const frameRef = useRef(0) // номер кадра цикла: каждый третий — и двумерные коды
  const doneRef = useRef(false)
  const voteRef = useRef({ code: '', count: 0 })
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [hint, setHint] = useState('Запуск камеры…')
  const [manual, setManual] = useState('')
  // Возможности камеры: зум и фонарик сильно помогают на мелких QR/DataMatrix
  const [zoom, setZoom] = useState(null) // { min, max, step, value } или null, если не поддерживается
  const [torch, setTorch] = useState(null) // true/false — включён ли, null — нет поддержки

  function applyTrack(constraint) {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track) return Promise.resolve()
    return track.applyConstraints({ advanced: [constraint] }).catch(() => {})
  }
  const changeZoom = (v) => {
    setZoom((z) => (z ? { ...z, value: v } : z))
    applyTrack({ zoom: v })
  }
  const toggleTorch = () => {
    const next = !torch
    setTorch(next)
    applyTrack({ torch: next })
  }

  function fire(code) {
    if (doneRef.current) return
    doneRef.current = true
    try { navigator.vibrate?.(90) } catch {}
    onDetect(String(code).trim())
  }

  // Принимаем код только после CONFIRM одинаковых чтений подряд (защита от misread,
  // одинаковый результат на всех телефонах). Возвращает true, когда код подтверждён.
  function confirmRead(code) {
    const v = voteRef.current
    if (code === v.code) v.count += 1
    else { v.code = code; v.count = 1 }
    return v.count >= CONFIRM
  }

  function cleanup() {
    doneRef.current = true
    clearTimeout(scanTimerRef.current)
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    try { workerRef.current?.terminate() } catch {}
    workerRef.current = null
    for (const done of waitRef.current.values()) done(null)
    waitRef.current.clear()
  }

  // Кадр для распознавания: НЕ весь экран, а жёлтая рамка прицела, и не крупнее
  // 800 точек по ширине. Пикселей в разы меньше — распознаётся быстро даже без
  // встроенного распознавателя. full=true — весь кадр (ручной снимок)
  function snapFrame(full) {
    const video = videoRef.current
    if (!video || !video.videoWidth) return null
    const vw = video.videoWidth
    const vh = video.videoHeight
    const sx = full ? 0 : Math.round(vw * 0.08)
    const sy = full ? 0 : Math.round(vh * 0.2)
    const sw = full ? vw : Math.round(vw * 0.84)
    const sh = full ? vh : Math.round(vh * 0.6)
    const k = Math.min(1, (full ? 1280 : LOOP_W) / sw)
    const canvas = (scanCanvasRef.current ||= document.createElement('canvas'))
    canvas.width = Math.round(sw * k)
    canvas.height = Math.round(sh * k)
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    return canvas
  }

  // Фоновый поток распознавания. Не завёлся (старый браузер) — разбор в странице
  function startWorker() {
    if (workerRef.current !== null || typeof Worker === 'undefined') return workerRef.current
    try {
      const w = new Worker(new URL('../lib/scanWorker.js', import.meta.url), { type: 'module' })
      w.onmessage = (e) => {
        const { id, code } = e.data || {}
        const done = waitRef.current.get(id)
        if (done) {
          waitRef.current.delete(id)
          done(code || null)
        }
      }
      w.onerror = () => {
        // Поток упал — дальше разбираем в странице
        try { w.terminate() } catch {}
        workerRef.current = false
        for (const done of waitRef.current.values()) done(null)
        waitRef.current.clear()
      }
      workerRef.current = w
    } catch {
      workerRef.current = false
    }
    return workerRef.current
  }

  // Разобрать кадр холста: в фоновом потоке (буфер передаётся, не копируется),
  // а без него — здесь же
  function zxingFrame(canvas, mode) {
    const w = canvas.width
    const h = canvas.height
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h)
    const worker = workerRef.current
    if (!worker) return Promise.resolve(decodeGray(grayOf(img.data, w, h), w, h, mode))
    const id = ++seqRef.current
    return new Promise((resolve) => {
      waitRef.current.set(id, resolve)
      worker.postMessage({ id, rgba: img.data.buffer, w, h, mode }, [img.data.buffer])
      // Поток не ответил за 3 с — кадр пропускаем
      setTimeout(() => {
        if (waitRef.current.has(id)) {
          waitRef.current.delete(id)
          resolve(null)
        }
      }, 3000)
    })
  }

  // Одна попытка распознавания: встроенным распознавателем браузера (Chrome/Android —
  // аппаратный), а где его нет — ZXing в фоновом потоке. Обычные штрихкоды — каждый
  // кадр, двумерные (QR, DataMatrix) — каждый третий: так кадр разбирается быстрее
  async function decodeOnce(full) {
    const canvas = snapFrame(full)
    if (!canvas) return null
    if (detectorRef.current) {
      const found = await detectorRef.current.detect(canvas)
      return found && found[0] ? String(found[0].rawValue) : null
    }
    const n = ++frameRef.current
    return zxingFrame(canvas, n % 3 === 0 ? 'all' : 'fast')
  }

  useEffect(() => {
    const secure = window.isSecureContext || location.hostname === 'localhost'
    if (!secure) {
      setError('Камера работает только по HTTPS или на localhost. Либо введите цифры под штрихкодом вручную ниже.')
      return
    }

    let cancelled = false // защита от двойного монтирования (StrictMode) и быстрого закрытия
    doneRef.current = false

    async function start() {
      const video = videoRef.current
      try {
        // 720p достаточно для любого штрихкода, а пикселей вчетверо меньше,
        // чем в FullHD, — видео и распознавание перестают тормозить телефон
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        video.srcObject = stream
        // play() может «прерваться» при перемонтировании — это не ошибка, игнорируем
        try { await video.play() } catch { /* AbortError / interrupted — не критично */ }
        if (cancelled) return

        // Непрерывный автофокус (если поддерживается)
        const track = stream.getVideoTracks()[0]
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }) } catch {}
        if (cancelled) return

        // Зум и фонарик — если камера умеет. Мелкие QR/DataMatrix без зума часто не читаются,
        // поэтому сразу поднимаем зум до умеренного значения.
        try {
          const caps = track.getCapabilities?.() || {}
          if (caps.zoom) {
            const min = caps.zoom.min ?? 1
            const max = caps.zoom.max ?? 1
            if (max > min) {
              // Не больше 1,5×: цифровое приближение умножает дрожание руки — при 3× (как было)
              // картинка «прыгала» при каждом движении. Мелкий код — ползунком
              const start = Math.min(max, Math.max(min, 1.5))
              setZoom({ min, max, step: caps.zoom.step || 0.1, value: start })
              await track.applyConstraints({ advanced: [{ zoom: start }] }).catch(() => {})
            }
          }
          if (caps.torch) setTorch(false)
        } catch { /* камера без расширенных возможностей */ }
        if (cancelled) return

        setReady(true)

        // Распознавание: встроенный распознаватель браузера (аппаратный, лёгкий),
        // где его нет — ZXing по той же схеме. В обоих случаях — свой неторопливый
        // цикл по области рамки, а не перемалывание каждого кадра целиком
        detectorRef.current = await makeNativeDetector()
        if (cancelled) return
        if (!detectorRef.current) startWorker()
        const pause = detectorRef.current || workerRef.current ? SCAN_MS : SCAN_MS_MAIN
        setHint('Наведите код в рамку: штрихкод, QR или DataMatrix. Мелкий код — приблизьте зумом, при бликах включите подсветку')

        const tick = async () => {
          if (cancelled || doneRef.current) return
          const t0 = performance.now()
          try {
            const code = await decodeOnce(false)
            if (code && confirmRead(code)) return fire(code)
          } catch { /* неудачный кадр — просто пробуем следующий */ }
          if (cancelled || doneRef.current) return
          // держим ровный темп: вычитаем из паузы время, потраченное на распознавание
          scanTimerRef.current = setTimeout(tick, Math.max(40, pause - (performance.now() - t0)))
        }
        tick()
      } catch (e) {
        if (cancelled) return
        if (e?.name === 'NotAllowedError') setError('Доступ к камере запрещён. Разрешите камеру в настройках браузера и обновите.')
        else if (e?.name === 'NotFoundError') setError('Камера не найдена. Введите цифры штрихкода вручную ниже.')
        else setError('Не удалось запустить камеру: ' + (e?.message || e))
      }
    }

    start()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  // Ручной захват чёткого кадра: весь кадр и самый дотошный разбор —
  // это одна попытка по нажатию, здесь можно не экономить
  async function capture() {
    if (doneRef.current) return
    try {
      let code = null
      if (detectorRef.current) {
        const canvas = snapFrame(true)
        const found = canvas && (await detectorRef.current.detect(canvas))
        code = found && found[0] ? String(found[0].rawValue) : null
      }
      if (!code) {
        const canvas = snapFrame(true)
        code = canvas ? await zxingFrame(canvas, 'hard') : null
      }
      if (code) return fire(code)
    } catch { /* не распознался — подскажем ниже */ }
    setHint('Не распознал. Держите штрихкод ровно, ближе и без бликов, снимите ещё раз')
  }

  function submitManual() {
    // Допускаем и буквенно-цифровые коды (CODE_128/CODE_39), не только цифры
    const v = manual.trim().replace(/\s+/g, '')
    if (v.length < 4) return setHint('Введите код под штрихкодом (обычно 8 или 13 цифр)')
    fire(v)
  }

  // Рендерим в хост оверлеев — по центру экрана, а не области контента
  return createPortal(
    <div className="overlay" {...backdrop}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3><span className="ic"><LuCamera size={18} /></span>Сканирование камерой</h3>

        {error ? (
          <div className="note err" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <LuTriangleAlert size={18} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{error}</span>
          </div>
        ) : (
          <>
            <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
              <video ref={videoRef} style={{ width: '100%', display: 'block', maxHeight: 360 }} muted playsInline />
              <div style={{ position: 'absolute', left: '6%', right: '6%', top: '50%', height: 2, background: 'rgba(255,60,60,0.95)', boxShadow: '0 0 8px red' }} />
              <div style={{ position: 'absolute', inset: '20% 8%', border: '3px solid #efbd24', borderRadius: 12 }} />
            </div>
            {(zoom || torch !== null) && (
              <div className="cam-tools">
                {zoom && (
                  <label className="cam-zoom">
                    <LuZoomIn size={16} />
                    <input
                      type="range" min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value}
                      onChange={(e) => changeZoom(Number(e.target.value))}
                      aria-label="Приближение"
                    />
                  </label>
                )}
                {torch !== null && (
                  <button className={'btn ghost sm' + (torch ? ' active' : '')} onClick={toggleTorch}>
                    <LuFlashlight size={15} /> {torch ? 'Выключить свет' : 'Подсветка'}
                  </button>
                )}
              </div>
            )}
            <div className="scan-hint" style={{ justifyContent: 'center', textAlign: 'center', marginTop: 10 }}>
              <span className="ic"><LuScanLine size={15} /></span>{hint}
            </div>
            <button className="btn block" style={{ marginTop: 12, padding: 13, fontSize: 15 }} disabled={!ready} onClick={capture}>
              <span className="ic"><LuImage size={17} /></span> Сфотографировать и распознать
            </button>
          </>
        )}

        <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
          <label htmlFor="manualCode">Или введите код под штрихкодом</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="manualCode" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitManual()} placeholder="напр. 4820005742752" inputMode="text" autoCapitalize="characters" />
            <button className="btn ghost" onClick={submitManual}>Ввести</button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>,
    overlayHost() || document.body,
  )
}
