
export type StockCategory = 'CN' | 'HK' | 'US' | 'INDEX'
export type Exchange = 'SH' | 'SZ' | 'BJ' | 'HK' | 'NYSE' | 'NASDAQ' | 'AMEX'


// 行情
export interface Quote {
  current: number                // 现价
  percent: number                // 涨幅（%）
  chg: number                    // 涨跌额
  open: number                   // 开盘价
  lastClose: number              // 昨日收盘价
  high: number                   // 当日最高价
  low: number                    // 当日最低价
  limitUp: number                // 当日涨停价
  limitDown: number              // 当日跌停价
  volume: number                 // 成交量（股）
  amount: number                 // 成交额（元）
  turnoverRate: number           // 换手率，表示股票的转手买卖频率（单位：%）
  amplitude: number              // 振幅，表示股价在当日波动幅度（单位：%）
  marketCapital: number          // 市值
  floatMarketCapital: number     // 流通市值
  lotSize: number                // 一手多少股
  currency: string               // 币种
  status: number                 // 股票状态 0：未上市  1：正常交易  2：停牌
  marketStatus: string           // 交易状态(中文)
  marketStatusId: number         // 交易状态(数字 1：未开盘 3: 集合竞价 4: 休盘中 5：交易中 7：已收盘 8：休市)
  timestamp: number              // 行情数据的生成时间戳（毫秒）
  [key: string]: unknown         // 允许任何字符串作为键名
}

// 交易记录
export interface TradeRecord {
  type: number            // 交易方向（1：买入，-1：卖出）
  price: number           // 成交价格
  shares: number          // 成交数量
  broker: string          // 劵商
  time?: string           // 成交时间
  fees?: number           // 成交时计算的总费用快照（股票交易币种）
}
// 持仓
export interface Position {
  symbol?: string              // 股票代码
  cost: number                 // 每股成本（股票交易币种）
  shares: number               // 股数
  tradeRecords?: TradeRecord[] // 交易记录
  totalProfit?: number         // 清仓后总盈亏（人民币元）
}

// 盈利
export interface Profit {
  todayProfit: number             // 当日盈亏（人民币元）
  todayProfitBase?: number        // 日初持仓市值 + 当日买入金额及买入费用（人民币元）
  todayProfitRate?: number        // 当日盈亏比（%）；无有效分母时不可用
  totalProfit: number             // 总盈亏（人民币元）
  totalProfitRate: number         // 总盈亏比（%）
}

// Display-only amounts. Position/Quote retain the trading currency for order entry.
export interface PositionCny {
  currency: 'CNY'
  current: number
  cost: number
  marketValue: number
  chg?: number
  amount?: number
  high?: number
  low?: number
  open?: number
  lastClose?: number
  marketCapital?: number
  floatMarketCapital?: number
}

export interface Stock {
  region: string          // 所属地区
  exchange: Exchange      // 股票上市的交易所，如深圳证券交易所（SZ）或上海证券交易所（SH）
  symbol: string          // 完整的股票代码，包含交易所前缀（SZ：深交所，SH：上交所）
  code: string            // 纯数字股票代码
  name: string            // 股票的中文简称
  type: number            // 0：美股 11：沪深主板、创业板 12：指数 13：etf 30:港股  81: 板块  82：科创 
  quote: Quote            // 行情
  position?: Position     // 持仓
  profit?: Profit         // 盈亏
  positionCny?: PositionCny // 持仓金额的人民币展示值，不用于交易回写
  exchangeRateStale?: boolean // 收益采用过期缓存汇率
}

// 过户费率
export type TransferRate = {
  value: number
}  & Record<Exclude<string, 'value'>, number>

// 券商
export interface HongKongConnectFees {
  commissionRate?: number        // 佣金比例；未配置时沿用券商佣金率
  minCommission?: number         // 最低佣金；未配置时沿用股票/ETF最低佣金
  minimumCommissionCurrency?: 'HKD' | 'CNY' // 最低佣金币种，默认HKD
  stampTaxRate?: number          // 股票印花税，双向，向上取整到港元
  tradingFeeRate?: number        // 联交所交易费
  transactionLevyRate?: number   // 证监会交易征费
  afrcLevyRate?: number          // 会财局交易征费
  settlementFeeRate?: number     // 港股通股份交收费
}

export interface Broker {
  code: string                   // 代码
  name: string                   // 名称
  commissionRate: number         // 佣金
  stampTaxRate: number           // 印花税费率
  transferRate: TransferRate     // 买入过户费率
  stockMinCommission: number     // 普通股票最小佣金
  etfMinCommission: number       // etf最小佣金
  hkStockConnect?: HongKongConnectFees // 港股通专用费用；金额计算结果为港元
}
