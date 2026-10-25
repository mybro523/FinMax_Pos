// ── Экран покупателя: показать то, что прислало окно кассы ──
// Всё приходит готовыми строками (с переводом и деньгами — как на чеке). Здесь ничего не
// считается и ничего не разбирается: только текст в свои места (textContent — никакой
// разметки из присланного). Подписи по умолчанию — русские, окно кассы присылает свои.
'use strict'
;(function () {
  var DEFAULTS = {
    welcome: 'Добро пожаловать',
    total: 'Итого',
    discount: 'Скидка',
    thanks: 'Спасибо за покупку!',
    change: 'Сдача',
    test: 'Проверка экрана покупателя',
  }
  var VIEWS = { idle: 1, cart: 1, thanks: 1, test: 1 }
  var $ = function (id) {
    return document.getElementById(id)
  }
  var prev = []

  function label(s, k) {
    var v = s && s.labels && typeof s.labels[k] === 'string' ? s.labels[k] : ''
    return v || DEFAULTS[k]
  }
  function text(id, value) {
    var el = $(id)
    if (el) el.textContent = typeof value === 'string' ? value : ''
  }
  function show(id, on) {
    var el = $(id)
    if (el) el.hidden = !on
  }

  // Длинное название магазина — мельче, но целиком (без многоточия): шрифт уменьшается, пока
  // название не войдёт в свои строки, но не мельче нижней границы. Мерить можно только
  // видимое — скрытое не меряется и остаётся своего размера
  function fit(id, lines, minPx) {
    var el = $(id)
    if (!el) return
    el.style.fontSize = ''
    if (!el.textContent || !el.offsetHeight) return
    var size = parseFloat(getComputedStyle(el).fontSize) || 0
    for (var i = 0; i < 40 && size > minPx; i++) {
      var lh = parseFloat(getComputedStyle(el).lineHeight) || size * 1.22
      if (el.scrollHeight <= Math.ceil(lh * lines) + 1) return
      size = Math.max(minPx, Math.floor(size * 0.93))
      el.style.fontSize = size + 'px'
    }
  }
  function fitShop() {
    fit('bar-shop', 2, 20)
    fit('idle-shop', 3, 28)
  }

  // Строка корзины: название, «сколько × почём» и сумма строки
  function row(item, fresh) {
    var li = document.createElement('li')
    li.className = 'item' + (fresh ? ' fresh' : '')
    var name = document.createElement('div')
    name.className = 'item-name'
    name.textContent = item.name || ''
    var sub = document.createElement('div')
    sub.className = 'item-sub'
    sub.textContent = item.sub || ''
    var sum = document.createElement('div')
    sum.className = 'item-sum'
    sum.textContent = item.sum || ''
    li.appendChild(name)
    li.appendChild(sum)
    li.appendChild(sub)
    return li
  }

  function render(raw) {
    var s = raw && typeof raw === 'object' ? raw : {}
    var view = VIEWS[s.mode] ? s.mode : 'idle'
    var screen = $('screen')
    screen.setAttribute('data-view', view)
    document.documentElement.lang = s.lang === 'tg' ? 'tg' : 'ru'

    // Название магазина — то, что задано магазину в панели; имени программы здесь нет:
    // покупатель видит магазин. Без названия — просто «Добро пожаловать»
    var shop = typeof s.shop === 'string' ? s.shop.trim() : ''
    text('bar-shop', shop)
    show('bar-shop', !!shop)
    text('idle-shop', shop)
    show('idle-shop', !!shop)
    text('idle-welcome', label(s, 'welcome'))
    text('bar-test', label(s, 'test'))
    show('bar-test', view === 'test')
    // Полоса с названием — пока покупатель у кассы; в ожидании название и так во весь экран
    show('bar', view !== 'idle' && (!!shop || view === 'test'))

    // Корзина
    var items = Array.isArray(s.items) ? s.items : []
    var list = $('items')
    while (list.firstChild) list.removeChild(list.firstChild)
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {}
      var was = prev[i]
      // Подсветить то, что только что добавили или поменяли
      var fresh = view === 'cart' && (!was || was.name !== it.name || was.sub !== it.sub || was.sum !== it.sum)
      list.appendChild(row(it, fresh))
    }
    prev = view === 'cart' ? items.slice() : []
    // Свежая строка — последняя: листаем к ней
    var wrap = $('items-wrap')
    wrap.scrollTop = wrap.scrollHeight

    text('disc-label', label(s, 'discount'))
    text('disc', s.discount)
    show('disc-row', !!s.discount)
    text('total-label', label(s, 'total'))
    text('total', s.total)

    // Спасибо за покупку
    text('thanks', label(s, 'thanks'))
    text('thanks-total-label', label(s, 'total'))
    text('thanks-total', s.total)
    text('change-label', label(s, 'change'))
    text('change', s.change)
    show('change-row', !!s.change)

    // Название магазина — по размеру уже после того, как всё на своих местах
    fitShop()
  }

  render(null)
  // Сменилось разрешение экрана или догрузился шрифт — подогнать название заново
  window.addEventListener('resize', fitShop)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitShop, function () {})
  var bridge = window.customerScreen
  if (bridge) {
    bridge.onState(render)
    bridge.ready().then(render, function () {})
  }
})()
