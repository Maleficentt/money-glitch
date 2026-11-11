import Decimal from 'decimal.js'
import { Broker, Position, Stock, TradeRecord } from './types'

export function validateTrade(trade: TradeRecord) {
  if (!Number.isFinite(trade.price) || trade.price <= 0) throw new Error('交易价格必须是大于 0 的有限数字')
  if (!Number.isSafeInteger(trade.shares) || trade.shares <= 0) throw new Error('交易数量必须是大于 0 的整数')
  if (trade.type !== 1 && trade.type !== -1) throw new Error('无效的交易方向')
}

export function validatePosition(position: Position) {
  if (!Number.isFinite(position.cost)) throw new Error('持仓成本必须是有限数字')
  if (!Number.isSafeInteger(position.shares) || position.shares < 0) throw new Error('持仓数量必须是大于或等于 0 的整数')
}

export function getTradeFees(stock: Stock, trade: TradeRecord, brokers: Record<string, Broker>) {
  // The explicit "no broker" option represents a trade without fees.
  const broker = trade.broker ? brokers[trade.broker] : undefined
  if (trade.broker && !broker) throw new Error(`找不到券商配置：${trade.broker}`)
  const rate = (value: number | undefined) => {
    if (value === undefined) return 0
    if (!Number.isFinite(value) || value < 0) throw new Error('券商费率必须是大于或等于 0 的有限数字')
    return value
  }
  const amount = new Decimal(trade.price).mul(trade.shares)
  const isEtf = stock.type === 13
  const commission = Decimal.max(amount.mul(rate(broker?.commissionRate)).toDecimalPlaces(2),
    rate(isEtf ? broker?.etfMinCommission : broker?.stockMinCommission))
  const transferRate = broker?.transferRate
  const transfer = trade.type === -1 && isEtf ? new Decimal(0)
    : amount.mul(rate(transferRate?.[stock.exchange.toUpperCase()] ?? transferRate?.value)).toDecimalPlaces(2)
  const stampTax = trade.type === -1 && !isEtf
    ? amount.mul(rate(broker?.stampTaxRate)).toDecimalPlaces(2) : new Decimal(0)
  return commission.add(transfer).add(stampTax)
}
