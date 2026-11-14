// Включён ли модуль у магазина вошедшего (lib/moduli.js) — для разделов, где прячется
// связанное с модулем: поле срока годности, «Куда: Склад», карточки панели…
import { useAuth } from '../db/auth'
import { moduleOn, routeOn } from './moduli'

export function useModul(key) {
  return moduleOn(useAuth(), key)
}

// Открыт ли адрес раздела у этого магазина — для ссылок из одного раздела в другой
export function useRouteOn() {
  const user = useAuth()
  return (to) => routeOn(user, to)
}
