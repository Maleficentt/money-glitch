import Decimal from 'decimal.js'
import { PositionCny, Stock } from './types'

export function getStockCurrency(stock: Stock): string {
  return stock.quote.currency || ({ CN: 'CNY', HK: 'HKD', US: 'USD' } as Record<string, string>)[stock.region] || ''
}

/** Rates use CNY as base: one CNY buys `rate` units of the trading currency. */
export function getPositionCny(stock: Stock, rate: number): PositionCny | undefined {
  const position = stock.position
  const price = stock.quote.current || stock.quote.lastClose
  if (!position || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(price) ||
    !Number.isFinite(position.cost) || !Number.isFinite(position.shares)) return undefined
  const amounts: Partial<PositionCny> = {}
  for (const field of ['chg', 'amount', 'high', 'low', 'open', 'lastClose', 'marketCapital', 'floatMarketCapital'] as const) {
    if (Number.isFinite(stock.quote[field])) amounts[field] = new Decimal(stock.quote[field]).div(rate).toNumber()
  }
  return {
    ...amounts,
    currency: 'CNY',
    current: new Decimal(price).div(rate).toNumber(),
    cost: new Decimal(position.cost).div(rate).toNumber(),
    // Multiply before rounding so per-share display rounding cannot affect totals.
    marketValue: Number(new Decimal(price).mul(position.shares).div(rate).toFixed(2))
  }
}
