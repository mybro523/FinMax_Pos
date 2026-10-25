// ── Заплатки для старого движка ──
//
// Программа для Windows 7 и 8 работает на Electron 22 — окно там Chrome 108. Чего в нём
// нет, а библиотеки могут попросить, ставим здесь — и только если этого действительно нет:
// на новом движке файл ничего не меняет. Подключается первым (main.jsx).
//
// Что проверяет сборка для Windows 7 и 8 — desktop/scripts/compat-scan.mjs.

// AbortSignal.any (Chrome 116): сигнал, который обрывается, когда оборвался любой из данных.
// Нужен pdf.js (экран печати программы) — в его частях, которые программа почти не трогает
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function any(signals) {
    const ctrl = new AbortController()
    for (const s of signals) {
      if (s.aborted) {
        ctrl.abort(s.reason)
        return ctrl.signal
      }
    }
    for (const s of signals) s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true })
    return ctrl.signal
  }
}
