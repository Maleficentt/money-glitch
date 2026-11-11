import Decimal from 'decimal.js'
import { Broker, Position, Stock, TradeRecord } from './types'

// Southbound fees: SSE trading taxes and ChinaClear settlement fees, effective June 2025.
export const DEFAULT_HK_STOCK_CONNECT_FEES = {
  stampTaxRate: 0.001,
  tradingFeeRate: 0.0000565,
  transactionLevyRate: 0.000027,
  afrcLevyRate: 0.0000015,
  settlementFeeRate: 0.000042
}

function nonNegative(value: number | undefined, fallback = 0): number {
  const result = value === undefined ? fallback : value
  if (!Number.isFinite(result) || result < 0) throw new Error('券商费率及最低佣金必须是大于或等于 0 的有限数字')
  return result
}

export function isHongKongStock(stock: Stock): boolean {
  return stock.region === 'HK' || stock.exchange.toUpperCase() === 'HK'
}

export function requiresHongKongCommissionRate(stock: Stock, broker?: Broker): boolean {
  return isHongKongStock(stock) && broker?.hkStockConnect?.minimumCommissionCurrency === 'CNY'
}

export function getHongKongConnectFees(stock: Stock, trade: TradeRecord, broker: Broker, hkdPerCny?: number) {
  validateTrade(trade)
  if (stock.quote.currency && stock.quote.currency !== 'HKD') {
    throw new Error('港股通费用仅支持港币成交，请核对股票交易币种')
  }
  const hk = broker.hkStockConnect === undefined ? {} : broker.hkStockConnect
  if (!hk || typeof hk !== 'object' || Array.isArray(hk)) throw new Error('港股通费用配置无效')
  const amount = new Decimal(trade.price).mul(trade.shares)
  const isEtf = stock.type === 13
  const commissionRate = nonNegative(hk.commissionRate === undefined ? broker.commissionRate : hk.commissionRate)
  let minimum = new Decimal(nonNegative(hk.minCommission === undefined
    ? (isEtf ? broker.etfMinCommission : broker.stockMinCommission) : hk.minCommission))
  const currency = hk.minimumCommissionCurrency === undefined ? 'HKD' : hk.minimumCommissionCurrency
  if (currency === 'CNY') {
    if (hkdPerCny === undefined || !Number.isFinite(hkdPerCny) || hkdPerCny <= 0) {
      throw new Error('港股通人民币最低佣金需要有效的港币汇率')
    }
    minimum = minimum.mul(hkdPerCny)
  } else if (currency !== 'HKD') {
    throw new Error('港股通最低佣金币种必须为 HKD 或 CNY')
  }
  const cents = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  const commission = cents(Decimal.max(amount.mul(commissionRate), minimum))
  const stampRate = nonNegative(hk.stampTaxRate, DEFAULT_HK_STOCK_CONNECT_FEES.stampTaxRate)
  const stampTax = isEtf ? new Decimal(0) : amount.mul(stampRate).ceil()
  const tradingFee = cents(amount.mul(nonNegative(hk.tradingFeeRate, DEFAULT_HK_STOCK_CONNECT_FEES.tradingFeeRate)))
  const transactionLevy = cents(amount.mul(nonNegative(hk.transactionLevyRate, DEFAULT_HK_STOCK_CONNECT_FEES.transactionLevyRate)))
  const afrcLevy = cents(amount.mul(nonNegative(hk.afrcLevyRate, DEFAULT_HK_STOCK_CONNECT_FEES.afrcLevyRate)))
  const settlementFee = cents(amount.mul(nonNegative(hk.settlementFeeRate, DEFAULT_HK_STOCK_CONNECT_FEES.settlementFeeRate)))
  const total = commission.add(stampTax).add(tradingFee).add(transactionLevy).add(afrcLevy).add(settlementFee)
  return { commission, stampTax, tradingFee, transactionLevy, afrcLevy, settlementFee, total }
}

export function validateTrade(trade: TradeRecord) {
  if (!Number.isFinite(trade.price) || trade.price <= 0) throw new Error('交易价格必须是大于 0 的有限数字')
  if (!Number.isSafeInteger(trade.shares) || trade.shares <= 0) throw new Error('交易数量必须是大于 0 的整数')
  if (trade.type !== 1 && trade.type !== -1) throw new Error('无效的交易方向')
}

export function validatePosition(position: Position) {
  if (!Number.isFinite(position.cost)) throw new Error('持仓成本必须是有限数字')
  if (!Number.isSafeInteger(position.shares) || position.shares < 0) throw new Error('持仓数量必须是大于或等于 0 的整数')
}

export function getTradeFees(stock: Stock, trade: TradeRecord, brokers: Record<string, Broker>, hkdPerCny?: number) {
  // The explicit "no broker" option represents a trade without fees.
  const broker = trade.broker ? brokers[trade.broker] : undefined
  if (trade.broker && !broker) throw new Error(`找不到券商配置：${trade.broker}`)
  if (broker && isHongKongStock(stock)) return getHongKongConnectFees(stock, trade, broker, hkdPerCny).total
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
