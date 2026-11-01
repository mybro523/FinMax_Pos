// ── Логотип магазина (1.6.4) ──
//
// Картинку ставит владелец сервиса в панели («Новый магазин», «Изменить магазин»). Касса
// печатает её на чеках (над полосой с названием), в шапке листов и показывает на экране
// покупателя. Логотипа нет — всё как прежде.
//
// Что показывать и когда забирать заново — lib/logoSync.js (без React, с проверками). Здесь —
// подключение к окну: запрос к серверу, сигналы «магазин изменился» и «связь вернулась», хук.
//
// Хранится только в памяти окна: сайт забирает картинку при входе, а программа для Windows
// держит её у себя (desktop/src/gateway.mjs) и отдаёт и без интернета.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../db/api'
import { useAuth } from '../db/auth'
import { onChanged, onRealtimeUp } from '../db/store'
import { createLogoSync } from './logoSync.js'

const logo = createLogoSync((path) => api.get(path))

// Сервер: «магазин изменился» — логотип поставили, заменили или убрали
onChanged((keys) => {
  if (Array.isArray(keys) && keys.includes('shop')) logo.changed()
})
// Связь вернулась: пока её не было, сигнал мог пройти мимо
onRealtimeUp(() => logo.reconnected())

// Логотип магазина того, кто сейчас работает: data URL или '' (нет логотипа)
export function useShopLogo() {
  const user = useAuth()
  const code = user?.pharmacy?.code || ''
  const at = user?.pharmacy?.logoAt
  useEffect(() => {
    logo.sync(user)
    // Пересчёт — только когда сменился магазин или отметка логотипа
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, at])
  return useSyncExternalStore(
    logo.subscribe,
    () => logo.logoFor(code),
    () => '',
  )
}
