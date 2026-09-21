import { useEffect, useState } from 'react'
import { minutesToNextReset } from '../utils/credits'

/**
 * Живая строка «~23 мин» до почасового сброса токенов (верх UTC-часа).
 * Тикает раз в 20 секунд — минуты при таком периоде не требуют точности.
 */
export function ResetTimer({ prefix = '' }: { prefix?: string }) {
  const [m, setM] = useState(minutesToNextReset)
  useEffect(() => {
    const id = setInterval(() => setM(minutesToNextReset()), 20000)
    return () => clearInterval(id)
  }, [])
  return <span>{prefix}{m <= 1 ? 'меньше минуты' : `~${m} мин`}</span>
}
