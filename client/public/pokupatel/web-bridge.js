// ── Экран покупателя на сайте (1.7.5): мост вместо программы для Windows ──
// В программе корзину присылает её основная часть (customer-preload.cjs). На сайте окно
// покупателя открывает касса из «Настройки → Кассы и устройства», и обе вкладки одного сайта
// разговаривают через BroadcastChannel: касса шлёт «state», окно при открытии просит «ready».
// Здесь же — кнопка «Во весь экран»: браузер разрешает весь экран только по нажатию в самом
// окне (один раз после открытия; F11 тоже работает).
'use strict'
;(function () {
  if (window.customerScreen || typeof BroadcastChannel !== 'function') return
  var ch = new BroadcastChannel('finmax-pokupatel')
  var subs = []
  var got = false
  var lastState = null
  var waiting = []
  ch.onmessage = function (e) {
    var m = e && e.data
    if (!m || m.type !== 'state') return
    got = true
    lastState = m.state
    for (var i = 0; i < subs.length; i++) subs[i](m.state)
    var w = waiting
    waiting = []
    for (var k = 0; k < w.length; k++) w[k](m.state)
  }
  window.customerScreen = {
    // Что показать сейчас: касса отвечает последним, что показывала
    ready: function () {
      ch.postMessage({ type: 'ready' })
      return new Promise(function (resolve) {
        // Уже пришло — отдать последнее (не пустое: пустое вернуло бы окно к приветствию)
        if (got) return resolve(lastState)
        waiting.push(resolve)
      })
    },
    onState: function (cb) {
      if (typeof cb === 'function') subs.push(cb)
    },
  }
  // Касса узнаёт, что окно покупателя открыто (и закрыто)
  setInterval(function () {
    ch.postMessage({ type: 'alive' })
  }, 2000)
  ch.postMessage({ type: 'alive' })
  window.addEventListener('beforeunload', function () {
    ch.postMessage({ type: 'closed' })
  })

  // ── Во весь экран ──
  function fsButton() {
    var b = document.createElement('button')
    b.type = 'button'
    b.id = 'pk-fs'
    b.textContent = 'Во весь экран'
    b.setAttribute(
      'style',
      'position:fixed;right:16px;bottom:16px;z-index:9;padding:12px 18px;border-radius:12px;border:2px solid #efbd24;' +
        'background:rgba(6,18,51,.85);color:#fff;font:600 18px Inter,Segoe UI,sans-serif;cursor:pointer',
    )
    b.onclick = function () {
      var el = document.documentElement
      var go = el.requestFullscreen || el.webkitRequestFullscreen
      if (go) {
        try {
          var p = go.call(el)
          if (p && p.catch) p.catch(function () {})
        } catch (err) {
          /* браузер не дал — остаётся F11 */
        }
      }
    }
    document.body.appendChild(b)
    var sync = function () {
      var full = window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2
      b.hidden = !!(document.fullscreenElement || document.webkitFullscreenElement || full)
    }
    window.addEventListener('resize', sync)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    sync()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fsButton)
  else fsButton()
})()
