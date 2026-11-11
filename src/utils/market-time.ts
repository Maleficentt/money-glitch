import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

const markets: Record<string, { zone: string, sessions: string[][] }> = {
  CN: { zone: 'Asia/Shanghai', sessions: [['09:15', '11:30'], ['13:00', '15:00']] },
  HK: { zone: 'Asia/Hong_Kong', sessions: [['09:00', '12:00'], ['13:00', '16:00']] },
  US: { zone: 'America/New_York', sessions: [['09:30', '16:00']] }
}

export function getMarketDate(region = 'CN', now = Date.now()): string {
  return dayjs(now).tz(markets[region]?.zone ?? markets.CN.zone).format('YYYY-MM-DD')
}

export function getMarketOpenTime(region: string, now = Date.now()): number {
  const market = markets[region] ?? markets.CN
  return dayjs.tz(`${getMarketDate(region, now)} ${market.sessions[0][0]}`, market.zone).valueOf()
}

// Market status from the provider remains authoritative for holidays and early closes.
// Inconsistent/delayed status is checked again after 30s, never in a zero-delay loop.
export function getNextMarketDelay(region: string, status: number, now = Date.now()): number {
  const market = markets[region]
  if (!market) return 600000
  const date = getMarketDate(region, now)
  const sessions = market.sessions.map(([start, end]) => [
    dayjs.tz(`${date} ${start}`, market.zone).valueOf(),
    dayjs.tz(`${date} ${end}`, market.zone).valueOf()
  ])
  let next: number | undefined
  if ([3, 5].includes(status)) {
    next = sessions.find(([start, end]) => now >= start && now < end)?.[1]
  } else if (status === 4) {
    next = sessions.find(([start]) => start > now)?.[0]
  } else if (status === 1) {
    next = sessions[0][0] > now ? sessions[0][0] : undefined
  } else if ([7, 8].includes(status)) {
    for (let offset = 0; offset < 8; offset++) {
      const candidateDate = dayjs.utc(date).add(offset, 'day')
      if ([0, 6].includes(candidateDate.day())) continue
      const candidate = dayjs.tz(`${candidateDate.format('YYYY-MM-DD')} ${market.sessions[0][0]}`, market.zone).valueOf()
      if (candidate > now) {
        next = candidate
        break
      }
    }
  }
  return next === undefined ? 30000 : Math.max(1000, next - now + 1000)
}

export function retryDelay(attempt: number, base = 1000): number {
  return Math.min(60000, base * 2 ** Math.min(Math.max(attempt - 1, 0), 8))
}

export function isCanceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    ('code' in error && error.code === 'ERR_CANCELED' || 'name' in error && error.name === 'AbortError')
}
