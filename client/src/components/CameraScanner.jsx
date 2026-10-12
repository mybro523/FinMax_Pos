import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { DecodeHintType, BarcodeFormat } from '@zxing/library'
import { LuCamera, LuImage, LuTriangleAlert, LuScanLine, LuZoomIn, LuFlashlight } from 'react-icons/lu'
import { overlayHost, useBackdropClose } from './ui'

// Надёжные форматы (без ITF/Codabar — они дают ложные/обрезанные чтения).
// DATA_MATRIX и QR_CODE — двумерные коды на упаковках лекарств: их печатают вместо
// обычного штрихкода или рядом с ним. QR раньше отсутствовал в списке, поэтому камера
// его физически не искала и не распознавала.
const ZXING_FORMATS = [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE, BarcodeFormat.AZTEC,
]

// Сколько раз подряд код должен совпасть, чтобы его принять (защита от misread)
const CONFIRM = 2

function makeZxing() {
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS)
  hints.set(DecodeHintType.TRY_HARDER, true)
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 60 })
}

export default function CameraScanner({ onDetect, onClose }) {
  const backdrop = useBackdropClose(onClose)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const readerRef = useRef(null) // ZXing-ридер, используется и для ручного кадра capture()
  const zxingControlsRef = useRef(null)
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
    try { zxingControlsRef.current?.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
              const start = Math.min(max, min + (max - min) * 0.3)
              setZoom({ min, max, step: caps.zoom.step || 0.1, value: start })
              await track.applyConstraints({ advanced: [{ zoom: start }] }).catch(() => {})
            }
          }
          if (caps.torch) setTorch(false)
        } catch { /* камера без расширенных возможностей */ }
        if (cancelled) return

        setReady(true)

        // ЕДИНЫЙ движок ZXing на ВСЕХ устройствах — распознавание строго одинаковое.
        const reader = makeZxing()
        setHint('Наведите код в рамку: штрихкод, QR или DataMatrix. Мелкий код — приблизьте зумом, при бликах включите подсветку')
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result && confirmRead(result.getText())) fire(result.getText())
        })
        if (cancelled) { try { controls.stop() } catch {}; return }
        zxingControlsRef.current = controls
        readerRef.current = reader // используем для ручного кадра capture()
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

  // Ручной захват чёткого кадра (один движок — ZXing, одинаково везде)
  function capture() {
    const video = videoRef.current
    const reader = readerRef.current
    if (!video || !reader || !video.videoWidth || doneRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    try {
      const result = reader.decodeFromCanvas(canvas)
      fire(result.getText())
    } catch {
      setHint('Не распознал. Держите штрихкод ровно, ближе и без бликов, снимите ещё раз')
    }
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
