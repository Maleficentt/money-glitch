import dayjs from 'dayjs'
import ConfigManager from './config-manger'
import { getExchangeRates, getRealtimeQuote, getStockData } from './data-service'
import { Position, Stock, TradeRecord } from './types'
import { EventEmitter } from 'vscode'
import Decimal from 'decimal.js'
import * as vscode from 'vscode'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
// import isSameOrAfter from 'dayjs/plugin/isSameOrAfter' // ES 2015

dayjs.extend(isSameOrAfter)

// const marketOpenTime: Record<string, string[][]> = {
//   CN: [['09:15', '11:30'], ['13:00', '15:00']],
//   HK: [['09:00', '12:00'], ['13:00', '16:00']]
// }

const marketOpenTime: Record<string, number[][][]> = {
  CN: [[[9, 15], [11, 30]], [[13], [15]]],
  HK: [[[9], [12]], [[13], [16]]],
  US: [[[21, 30], [5]]]
}

const marketTimerInterval: Record<string, number> = {
  CN: 2000,
  HK: 10000,
  US: 2000
}

interface MarketController {
  status: number
  symbols: string[]
  abortController: AbortController
  marketTimer: NodeJS.Timeout | null
  quoteTimer: NodeJS.Timeout | null
}
class StockManager {
  private static instance: StockManager
  private configManager = ConfigManager.getInstance()
  private stockList: Stock[] = []
  private stockDataTimer: NodeJS.Timeout | null = null
  private stockDataController = new AbortController()
  private marketController: Record<string, MarketController> = {}
  private _onDidChangeStockList = new EventEmitter<Stock[]>()
  readonly onDidChangeStockList = this._onDidChangeStockList.event

  private constructor() { /* empty */ }

  static getInstance(): StockManager {
    if (!StockManager.instance) {
      StockManager.instance = new StockManager()
    }
    return StockManager.instance
  }

  getStockData(isRefresh = false) {
    this.stockDataController.abort()
    this.stockDataController = new AbortController()
    if (isRefresh && this.stockDataTimer) {
      clearTimeout(this.stockDataTimer)
    }
    const stockSymbols = this.configManager.getStockSymbols()
    let restSymbols = Array.from(new Set([...stockSymbols]))
    if (!isRefresh) {
      const selectedStockList: Stock[] = []
      this.stockList.forEach(stock => {
        if (stockSymbols.includes(stock.symbol)) {
          selectedStockList.push(stock)
        }
      })
      this.stockList = selectedStockList
      restSymbols = stockSymbols.filter(symbol => !selectedStockList.some(stock => stock.symbol === symbol))
    }
    if (restSymbols.length) {
      getStockData(restSymbols, { signal: this.stockDataController.signal }).then(async data => {
        if (isRefresh) {
          this.stockList = [...data]
        } else {
          this.stockList.push(...data)
        }
        await this.formatStockList()
        this.sort()
        this._onDidChangeStockList.fire(this.stockList)
        this.getMarketQuote()
        if (isRefresh) {
          this.stockDataTimer = setTimeout(() => {
            this.getStockData(true)
          }, 600000)
        }
      }).catch(err => {
        console.log(err)
        const errData = err.toJSON()
        if (errData.code !== 'ERR_CANCELED') {
          this.stockDataTimer = setTimeout(() => {
            this.getStockData()
          }, 1000)
        }
      })
    } {
      this.sort()
      this._onDidChangeStockList.fire(this.stockList)
    }
  }

  private getMarketQuote() {
    Object.keys(this.marketController).forEach(region => {
      const { marketTimer, abortController, quoteTimer } = this.marketController[region]
      if (marketTimer) {
        clearTimeout(marketTimer)
      }
      abortController.abort()
      if (quoteTimer) {
        clearTimeout(quoteTimer)
      }
    })
    this.marketController = {}
    this.stockList.forEach(item => {
      if (this.marketController[item.region]) {
        this.marketController[item.region].status = item.quote.marketStatusId
        this.marketController[item.region].symbols.push(item.symbol)
      } else {
        this.marketController[item.region] = {
          status: item.quote.marketStatusId,
          symbols: [item.symbol],
          abortController: new AbortController(),
          marketTimer: null,
          quoteTimer: null
        }
      }
    })
    // 交易中立刻获取实时行情，计算什么时候收盘
    // 未开盘算到当天开盘时间
    // 休盘中算到下一次开盘时间
    // 已收盘/休市算到第二天开市
    // status: 1:未开盘 3:集合竞价 4：休盘中 5：交易中 7：已收盘 8：休盘
    Object.keys(this.marketController).forEach(region => {
      const { status } = this.marketController[region]
      if ([3, 5].includes(status)) { // 集合竞价、交易中
        this.getRealtimeQuote(region)
        let endTime: number[] = []
        const timeList = marketOpenTime[region]
        for (let i = timeList.length - 1; i >= 0; i--) {
          const starTime = dayjs().set('hour', timeList[i][0][0]).set('minute', timeList[i][0][1] ?? 0)
          if (dayjs().isSameOrAfter(starTime)) {
            endTime = timeList[i][1]
            break
          }
        }
        const countdown = dayjs().set('hour', endTime[0]).set('minute', endTime[1] ?? 0).diff(new Date()) + 1000
        const timer = setTimeout(() => {
          this.stockList = []
          this.getStockData()
        }, countdown)
        this.marketController[region].marketTimer = timer
      } else if (status === 1) { // 未开盘
        const timeList = marketOpenTime[region][0][0]
        const startTime = dayjs().set('hour', timeList[0]).set('minute', timeList[1] ?? 0)
        const countdown = startTime.diff(new Date()) + 1000
        const timer = setTimeout(() => {
          this.stockList = []
          this.getStockData()
        }, countdown)
        this.marketController[region].marketTimer = timer
      } else if ([4, 7, 8].includes(status)) { // 休盘 / 收盘 TODO: 休市
        let timeList = marketOpenTime[region][0][0]
        if (status === 4) { // 休盘
          timeList = marketOpenTime[region][1][0]
        }
        const startTime = dayjs().set('hour', timeList[0]).set('minute', timeList[1] ?? 0)
        let countdown = 0
        if (status === 4) { // 休盘
          countdown = startTime.diff(new Date()) + 1000
        } else if ([7, 8].includes(status)) { // 收盘
          countdown = startTime.add(1, 'd').diff(new Date()) + 1000
        }
        const timer = setTimeout(() => {
          this.stockList = []
          this.getStockData()
        }, countdown)
        this.marketController[region].marketTimer = timer
      }
    })
  }

  private getRealtimeQuote(region: string) {
    const { symbols, abortController, quoteTimer } = this.marketController[region]
    abortController.abort()
    if (quoteTimer) {
      clearTimeout(quoteTimer)
    }
    const newAbortController = new AbortController()
    this.marketController[region].abortController = newAbortController
    if (symbols.length) {
      getRealtimeQuote(symbols, { signal: newAbortController.signal }).then(async quoteMap => {
        this.stockList.forEach(item => {
          if (quoteMap[item.symbol]) {
            Object.assign(item.quote, quoteMap[item.symbol])
          }
        })
        await this.formatStockList()
        this._onDidChangeStockList.fire(this.stockList)
        this.marketController[region].quoteTimer = setTimeout(() => {
          this.getRealtimeQuote(region)
        }, marketTimerInterval[region])
      }).catch(err => {
        const errData = err.toJSON()
        if (errData.code !== 'ERR_CANCELED') {
          this.marketController[region].quoteTimer = setTimeout(() => {
            this.getRealtimeQuote(region)
          }, marketTimerInterval[region])
        }
      })
    }
  }

  private async formatStockList() {
    const stockPosition = this.configManager.getPosition()
    const stockList: Stock[] = []
    const exchangeRates = await getExchangeRates()
    this.stockList.forEach(item => {
      const stock = { ...item }
      const position = stockPosition[stock.symbol]
      if (position) {
        stock.position = position
        const { cost, shares, tradeRecords, totalProfit: pTotalProfit } = position
        const todayTradeRecords: TradeRecord[] = (tradeRecords || []).filter((record: TradeRecord) => dayjs().isSame(record.time, 'day') || (stock.quote.statusId === 1 && dayjs().diff(record.time, 'day') <= 1))
        if ((cost && shares) || todayTradeRecords.length) {
          const { lastClose, current, currency } = item.quote
          // 总盈亏
          let exchangeRate = 1
          if (currency !== 'CNY') {
            exchangeRate = exchangeRates.find(item => item.quote === currency)!.rate
          }
          const totalProfit = shares ? new Decimal(current).sub(cost).mul(shares) : new Decimal(pTotalProfit || 0)
          // 总盈亏百分比 = (当前价 - 成本价) / 成本价
          const totalProfitRate = cost ? new Decimal(current).sub(cost).div(cost).mul(100).toFixed(2) : 0
          let todayProfit = new Decimal(0)
          let todayProfitRate
          const timeList = marketOpenTime[stock.region][0][0]
          const startTime = dayjs().set('hour', timeList[0]).set('minute', timeList[1] ?? 0)
          if (stock.quote.statusId !== 1 || dayjs(startTime).diff(new Date(), 'm') > 15) { // 开盘前15分钟重置当日盈亏
            todayProfit = new Decimal(current).sub(lastClose).mul(shares) // 当日盈亏
            const isEtfStock = item.type === 13
            let yestShares = shares
            if (todayTradeRecords.length > 0) {
              let restYestShares = shares
              let tradeProfit = new Decimal(0)
              for (const record of todayTradeRecords) {
                const { price: tradePrice, shares: tradeShares, broker } = record
                if (!tradePrice || !tradeShares) return
                const brokerMap = this.configManager.getBrokerMap()
                const brokerData = brokerMap[broker] ?? {}
                const { commissionRate = 0, transferRate, stockMinCommission = 0, etfMinCommission = 0, stampTaxRate = 0 } = brokerData
                const { value, isBilateral } = transferRate
                const buyTransferRate = isBilateral ? (transferRate[stock.exchange.toUpperCase()] ?? value) : 0
                const sellTransferRate = transferRate[stock.exchange.toUpperCase()] ?? transferRate.value
                const commissionTemp = new Decimal(tradePrice).mul(tradeShares).mul(commissionRate).toFixed(2)
                const commission = Math.max(Number(commissionTemp), isEtfStock ? etfMinCommission : stockMinCommission)
                if (record.type === 1) {
                  yestShares -= tradeShares
                  restYestShares -= tradeShares
                  const currentTradeProfit = new Decimal(current).sub(tradePrice).mul(tradeShares)
                  const transfer = new Decimal(tradePrice).mul(tradeShares).mul(buyTransferRate).toFixed(2)
                  tradeProfit = tradeProfit.add(currentTradeProfit).sub(commission).sub(transfer)
                } else if (record.type === -1) {
                  yestShares += tradeShares
                  const currentTradeProfit = new Decimal(tradePrice).sub(lastClose).mul(tradeShares)
                  tradeProfit = tradeProfit.add(currentTradeProfit).sub(commission)
                  let stampTax = '0'
                  let transfer = '0'
                  if (!isEtfStock) {
                    stampTax = new Decimal(tradePrice).mul(tradeShares).mul(stampTaxRate).toFixed(2)
                    transfer = new Decimal(tradePrice).mul(tradeShares).mul(sellTransferRate).toFixed(2)
                  }
                  tradeProfit = tradeProfit.sub(stampTax).sub(transfer)
                }
              }
              todayProfit = new Decimal(current).sub(lastClose).mul(restYestShares).add(tradeProfit)
            }
            // 当日盈亏百分比 = 当日盈亏金额 ÷ 当日初始持仓市值 × 100%
            todayProfitRate = yestShares ? todayProfit.div(new Decimal(yestShares).mul(lastClose)).mul(100).toFixed(2) : totalProfitRate
          }
          stock.profit = {
            totalProfit: Number(totalProfit.div(exchangeRate).toFixed(2)),
            totalProfitRate: Number(totalProfitRate),
            todayProfit: Number(todayProfit.div(exchangeRate).toFixed(2)),
            todayProfitRate: todayProfitRate ? Number(todayProfitRate) : 0
          }
        }

      }
      stockList.push(stock)
    })
    this.stockList = stockList
  }

  private sort() {
    const stockSymbols = this.configManager.getStockSymbols()
    const orderMap = new Map<string, number>()
    stockSymbols.forEach((symbol, index) => orderMap.set(symbol, index))
    this.stockList.sort((a, b) => {
      const indexA = orderMap.has(a.symbol) ? orderMap.get(a.symbol)! : Infinity
      const indexB = orderMap.has(b.symbol) ? orderMap.get(b.symbol)! : Infinity
      return indexA - indexB
    })
  }

  getStockList(): Stock[] {
    return this.stockList
  }

  refresh() {
    this.getStockData(true)
  }

  dispose() {
    this.stockDataController.abort()
    if (this.stockDataTimer) {
      clearTimeout(this.stockDataTimer)
    }
    Object.keys(this.marketController).forEach(region => {
      const { marketTimer, abortController, quoteTimer } = this.marketController[region]
      if (marketTimer) {
        clearTimeout(marketTimer)
      }
      abortController.abort()
      if (quoteTimer) {
        clearTimeout(quoteTimer)
      }
    })
    this.marketController = {}
  }

  buyStock(stock: Stock, tradeData: TradeRecord) {
    const { symbol, type: stockType, exchange } = stock
    const { price, shares, broker } = tradeData
    const allPosition = this.configManager.getPosition()
    const stockPosition = allPosition[symbol as string] ?? {}
    const tradeRecords = stockPosition.tradeRecords ?? []
    const oldShares = stockPosition.shares || 0
    const newShares = oldShares + shares
    const isEtfStock = stockType === 13
    const brokerMap = this.configManager.getBrokerMap()
    const brokerData = brokerMap[broker] ?? {}
    const { commissionRate = 0, transferRate, stockMinCommission = 0, etfMinCommission = 0 } = brokerData
    const { value, isBilateral } = transferRate
    const buyTransferRate = isBilateral ? (transferRate[exchange.toUpperCase()] ?? value) : 0
    const commissionTemp = new Decimal(price).mul(shares).mul(commissionRate).toFixed(2)
    const commission = Math.max(Number(commissionTemp), isEtfStock ? etfMinCommission : stockMinCommission)
    const transfer = new Decimal(price).mul(shares).mul(buyTransferRate).toFixed(2)
    const oldCost = stockPosition.cost ?? 0
    let newCost = new Decimal(oldCost).mul(oldShares).add(new Decimal(price).mul(shares)).add(commission).add(transfer).div(newShares).toFixed(4)
    if (oldCost === 0) {
      const totalProfit = stockPosition.totalProfit ?? 0
      // （新买入总金额 + 买入手续费 - 卖出总收入）÷ 新买入股数
      newCost = new Decimal(price).mul(shares).add(commission).add(transfer).sub(totalProfit).div(shares).toFixed(4)
    }
    const stockData: Position = {
      cost: Number(newCost),
      shares: newShares,
      tradeRecords: tradeRecords
    }
    const tradeRecord = {
      ...tradeData,
      time: dayjs().format('YYYY-MM-DD')
    }
    if (!tradeRecords.some((item) => dayjs().isSame(item.time, 'day'))) {
      stockData.tradeRecords = [tradeRecord]
    } else {
      stockData.tradeRecords = tradeRecords.concat(tradeRecord)
    }
    allPosition[symbol as string] = stockData
    this.configManager.updateConfig('position', allPosition)
    this.configManager.addStockSymbol(symbol as string)
  }

  async sellStock(stock: Stock, tradeData: TradeRecord) {
    const { symbol, type: stockType, exchange, quote } = stock
    const { price, shares, broker } = tradeData
    const allPosition = this.configManager.getPosition()
    const stockPosition = allPosition[symbol as string] ?? {}
    const tradeRecords = stockPosition.tradeRecords ?? []
    const oldShares = stockPosition.shares || 0
    const newShares = oldShares - shares
    const oldCost = stockPosition.cost || 0
    const isEtfStock = stockType === 13
    const brokerMap = this.configManager.getBrokerMap()
    const brokerData = brokerMap[broker] ?? {}
    const { commissionRate = 0, stampTaxRate = 0, transferRate, stockMinCommission = 0, etfMinCommission = 0 } = brokerData
    const sellTransferRate = transferRate[exchange.toUpperCase()] ?? transferRate.value
    const commissionTemp = new Decimal(price).mul(shares).mul(commissionRate).toFixed(2)
    const commission = Math.max(Number(commissionTemp), isEtfStock ? etfMinCommission : stockMinCommission)
    let stampTax = '0'
    let transfer = '0'
    if (!isEtfStock) {
      stampTax = new Decimal(price).mul(shares).mul(stampTaxRate).toFixed(2)
      transfer = new Decimal(price).mul(shares).mul(sellTransferRate).toFixed(2)
    }
    let newCost = new Decimal(0)
    if (newShares) {
      let marketCapital = new Decimal(oldCost).mul(oldShares).sub(new Decimal(price).mul(shares)).add(commission)
      marketCapital = marketCapital.add(stampTax).add(transfer)
      newCost = marketCapital.div(newShares)
    }
    const stockData: Position = {
      cost: Number(newCost.toFixed(4)),
      shares: newShares,
      tradeRecords: tradeRecords
    }
    if (newShares === 0) {
      const { currency } = quote
      let exchangeRate = 1
      if (currency !== 'CNY') {
        const exchangeRates = await getExchangeRates()
        exchangeRate = exchangeRates.find(item => item.quote === currency)!.rate
      }
      stockData.totalProfit = Number(new Decimal(price).sub(oldCost).mul(oldShares).sub(commission).sub(stampTax).sub(transfer).div(exchangeRate).toFixed(2)) ?? 0
    }
    const tradeRecord = {
      ...tradeData,
      time: dayjs().format('YYYY-MM-DD')
    }
    if (!tradeRecords.some((item) => dayjs().isSame(item.time, 'day'))) {
      stockData.tradeRecords = [tradeRecord]
    } else {
      stockData.tradeRecords = tradeRecords.concat(tradeRecord)
    }
    allPosition[symbol as string] = stockData
    this.configManager.updateConfig('position', allPosition)
  }

  async tradeStock(stock: Stock, type: number) {
    const typeDisplay = type > 0 ? '买入' : '卖出'
    const price = stock.quote.current || 0
    const inputPrice = await vscode.window.showInputBox({
      prompt: `请输入${typeDisplay}价格`,
      value: price ? String(price) : '',
      validateInput: (value) => (Number(value) > 0 ? undefined : '请输入大于 0 的价格')
    })
    if (!inputPrice) {
      return
    }
    const inputShares = await vscode.window.showInputBox({
      prompt: `请输入${typeDisplay}数量`,
      validateInput: (value) => (Number(value) > 0 ? undefined : '请输入大于 0 的数量')
    })
    if (!inputShares) return
    const brokerMap = this.configManager.getBrokerMap()
    const quickPick = vscode.window.createQuickPick()
    quickPick.placeholder = '请选择券商'
    const quickPickItems = Object.keys(brokerMap).map(key => {
      const broker = brokerMap[key]
      return {
        label: broker.name,
        description: broker.code
      }
    })
    quickPickItems.push({
      label: '无',
      description: ''
    })
    quickPick.items = quickPickItems
    let broker = ''
    quickPick.onDidChangeSelection(selection => {
      broker = selection[0]!.description ?? ''
    })
    quickPick.show()
    quickPick.onDidAccept(async () => {
      const tradeRecord = {
        type,
        price: Number(inputPrice),
        shares: Number(inputShares),
        broker
      }
      if (type > 0) {
        this.buyStock(stock, tradeRecord)
      } else {
        this.sellStock(stock, tradeRecord)
      }
      quickPick.hide()
      quickPick.dispose()
    })
  }

  async setStockPosition(stock: Stock) {
    const cost = stock.quote.current || 0
    const inputCost = await vscode.window.showInputBox({
      prompt: `请输入成本`,
      value: cost ? String(cost) : ''
    })
    if (!inputCost) {
      return
    }
    const inputShares = await vscode.window.showInputBox({
      prompt: `请输入持仓数量`,
      validateInput: (value) => (Number(value) >= 0 ? undefined : '请输入大于或等于 0 的数量')
    })
    if (!inputShares) return
    const position = {
      symbol: stock.symbol,
      cost: Number(inputCost),
      shares: Number(inputShares)
    }
    this.configManager.updatePosition(position)
  }
}

export default StockManager
