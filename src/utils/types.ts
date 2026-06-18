
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
  status: string                 // 交易状态(中文)
  statusId: number               // 交易状态(数字 1：为开盘 3: 集合竞价 4: 休盘中 5：交易中 7：已收盘)
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
}
// 持仓
export interface Position {
  symbol?: string              // 股票代码
  cost: number                 // 成本（元）
  shares: number               // 股数
  tradeRecords?: TradeRecord[] // 交易记录
  totalProfit?: number         // 清仓后总盈亏
}

// 盈利
export interface Profit {
  todayProfit: number             // 当日盈亏
  todayProfitRate: number         // 当日盈亏比（%）
  totalProfit: number             // 总盈亏
  totalProfitRate: number         // 总盈亏比（%）
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
}

// 券商
export interface Broker {
  code: string                   // 代码
  name: string                   // 名称
  commissionRate: number         // 佣金
  stampTaxRate: number           // 印花税费率
  buyTransferRate: number        // 买入过户费率
  sellTransferRate: number       // 卖出过户费率
  stockMinCommission: number     // 普通股票最小佣金
  etfMinCommission: number       // etf最小佣金
}
