import dayjs from 'dayjs'
import ConfigManager from './config-manger'
import { getRealtimeQuote, getStockData } from './data-service'
import { Position, Profit, Stock, TradeRecord } from './types'
import { EventEmitter } from 'vscode'
import isETF from './is-etf'
import Decimal from 'decimal.js'
import * as vscode from 'vscode'

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
      getStockData(restSymbols, { signal: this.stockDataController.signal }).then(data => {
        if (isRefresh) {
          this.stockList = [...data]
        } else {
          this.stockList.push(...data)
        }
        this.formatStockList()
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
        this.marketController[item.region].status = item.quote.statusId
        this.marketController[item.region].symbols.push(item.symbol)
      } else {
        this.marketController[item.region] = {
          status: item.quote.statusId,
          symbols: [item.symbol],
          abortController: new AbortController(),
          marketTimer: null,
          quoteTimer: null
        }
      }
    })
    // 交易中立刻获取实时行情，计算什么时候收盘
    // 休盘中算到下一次开盘时间
    // 已收盘/休市算到第二天开市
    Object.keys(this.marketController).forEach(region => {
      const { status } = this.marketController[region]
      if ([3, 5].includes(status)) { // 交易中
        this.getRealtimeQuote(region)
        let endTime: number[] = []
        const timeList = marketOpenTime[region]
        for (let i = timeList.length - 1; i >= 0; i--) {
          const starTime = dayjs().set('hour', timeList[i][0][0]).set('minute', timeList[i][0][1] ?? 0)
          if (dayjs().isAfter(starTime)) {
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
      } else if ([4, 7].includes(status)) { // 休盘 / 收盘 TODO: 休市
        let timeList = marketOpenTime[region][0][0]
        if (status === 4) { // 休盘
          timeList = marketOpenTime[region][1][0]
        }
        const startTime = dayjs().set('hour', timeList[0]).set('minute', timeList[1] ?? 0)
        let countdown = 0
        if (status === 4) { // 休盘
          countdown = startTime.diff(new Date()) + 1000
        } else if (status === 7) { // 收盘
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
      getRealtimeQuote(symbols, { signal: newAbortController.signal }).then(quoteMap => {
        this.stockList.forEach(item => {
          if (quoteMap[item.symbol]) {
            Object.assign(item.quote, quoteMap[item.symbol])
          }
        })
        this.formatStockList()
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

  private formatStockList() {
    const stockPosition = this.configManager.getPosition()
    const stockList: Stock[] = []
    this.stockList.map(item => {
      const stock = { ...item }
      const position = stockPosition[stock.symbol]
      if (position) {
        stock.position = position
        const { cost, shares, tradeRecords } = position
        const todayTradeRecords: TradeRecord[] = (tradeRecords || []).filter((record: TradeRecord) => dayjs().isSame(record.time, 'day'))
        if ((cost && shares) || todayTradeRecords.length) {
          const { lastClose, current } = item.quote
          // let yestAmount = lastClose * shares // 昨日持仓市值
          const totalProfit = new Decimal(current).sub(cost).mul(shares) // 总盈亏
          let todayProfit = new Decimal(current).sub(lastClose).mul(shares) // 当日盈亏
          const isEtfStock = item.type === 13
          const commonCommissionRate = this.configManager.getConfig('commonCommissionRate', 0)
          const etfCommissionRate = this.configManager.getConfig('etfCommissionRate', 0)
          const stampTaxRate = this.configManager.getConfig('stampTaxRate', 0)
          const transferRate = this.configManager.getConfig('transferRate', 0)
          const commissionRate = isEtfStock ? etfCommissionRate : commonCommissionRate
          let yestShares = shares
          if (todayTradeRecords.length > 0) {
            let restYestShares = shares
            let tradeProfit = new Decimal(0)
            for (const record of todayTradeRecords) {
              const { price: tradePrice, shares: tradeShares } = record
              if (!tradePrice || !tradeShares) return
              const commissionTemp = new Decimal(tradePrice).mul(tradeShares).mul(commissionRate).toFixed(2)
              const commission = Math.max(Number(commissionTemp), 5)
              if (record.type === 1) {
                yestShares -= tradeShares
                restYestShares -= tradeShares
                const currentTradeProfit = new Decimal(current).sub(tradePrice).mul(tradeShares)
                tradeProfit = tradeProfit.add(currentTradeProfit).sub(commission)
              } else if (record.type === -1) {
                yestShares += tradeShares
                const currentTradeProfit = new Decimal(tradePrice).sub(lastClose).mul(tradeShares)
                tradeProfit = tradeProfit.add(currentTradeProfit).sub(commission)
                if (!isEtfStock) {
                  const stampTax = new Decimal(tradePrice).mul(tradeShares).mul(stampTaxRate).toFixed(2)
                  const transfer = new Decimal(tradePrice).mul(tradeShares).mul(transferRate).toFixed(2)
                  tradeProfit = tradeProfit.sub(stampTax).sub(transfer)
                }
              }
            }
            // yestAmount = lastClose * yestShares
            todayProfit = new Decimal(current).sub(lastClose).mul(restYestShares).add(tradeProfit)
          }
          // 总盈亏 = (当前价 - 成本价) / 成本价
          const totalProfitRate = cost ? new Decimal(current).sub(cost).div(cost).mul(100).toFixed(2) : 0
          // 当日盈亏百分比 = 当日盈亏金额 ÷ 当日初始持仓市值 × 100%
          const todayProfitRate = todayProfit.div(new Decimal(yestShares).mul(lastClose)).mul(100).toFixed(2)
          stock.profit = {
            totalProfit: totalProfit.toNumber(),
            totalProfitRate: Number(totalProfitRate),
            todayProfit: todayProfit.toNumber(),
            todayProfitRate: Number(todayProfitRate)
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

  resetProfit() {
    const stockList: Stock[] = []
    this.stockList.map(item => {
      const stock = { ...item }
      if (stock.profit) {
        stock.profit = {
          totalProfit: 0,
          totalProfitRate: 0,
          todayProfit: 0,
          todayProfitRate: 0
        }
      }
      stockList.push(stock)
    })
    this.stockList = stockList
    this._onDidChangeStockList.fire(this.stockList)
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

  buyStock(tradeData: TradeRecord) {
    const { symbol, type, price, shares } = tradeData
    const allPosition = this.configManager.getPosition()

    const stockPosition = allPosition[symbol as string] ?? {}

    const tradeRecords = stockPosition.tradeRecords ?? []
    const oldShares = stockPosition.shares || 0
    const newShares = oldShares + shares
    const commonCommissionRate = this.configManager.getConfig('commonCommissionRate', 0)
    const etfCommissionRate = this.configManager.getConfig('etfCommissionRate', 0)
    const isEtfStock = isETF(symbol as string)
    const commissionRate = isEtfStock ? etfCommissionRate : commonCommissionRate
    const commissionTemp = new Decimal(price).mul(shares).mul(commissionRate).toFixed(2)
    const commission = Math.max(Number(commissionTemp) ? 0 : 5)
    const oldCost = stockPosition.cost ?? 0
    let newCost = new Decimal(oldCost).mul(oldShares).add(new Decimal(price).mul(shares)).add(commission).div(newShares).toFixed(4)
    if (oldCost === 0) {
      const profit: Profit = this.stockList.find(item => item.symbol === symbol)?.profit ?? {} as Profit
      const todayProfit = profit.todayProfit ?? 0
      // （新买入总金额 + 买入手续费 - 卖出总收入）÷ 新买入股数
      newCost = new Decimal(price).mul(shares).add(commission).sub(todayProfit).div(shares).toFixed(4)
    }
    const stockData: Position = {
      cost: Number(newCost),
      shares: newShares,
      tradeRecords: tradeRecords
    }
    if (!tradeRecords.some((item) => dayjs().isSame(item.time, 'day'))) {
      stockData.lastCost = oldCost
      stockData.lastShares = oldShares
      stockData.tradeRecords = [{
        type,
        price,
        shares,
        time: dayjs().format('YYYY-MM-DD')
      }]
    } else {
      stockData.tradeRecords = tradeRecords.concat({
        type,
        price,
        shares,
        time: dayjs().format('YYYY-MM-DD')
      })
    }
    allPosition[symbol as string] = stockData
    this.configManager.updateConfig('position', allPosition)
    this.configManager.addStockSymbol(symbol as string)
  }

  sellStock(tradeData: TradeRecord) {
    const { symbol, type, price, shares } = tradeData
    const allPosition = this.configManager.getPosition()

    const stockPosition = allPosition[symbol as string] ?? {}

    const tradeRecords = stockPosition.tradeRecords ?? []
    const oldShares = stockPosition.shares || 0
    const newShares = oldShares - shares
    const oldCost = stockPosition.cost || 0
    const isEtfStock = isETF(symbol as string)
    const commonCommissionRate = this.configManager.getConfig('commonCommissionRate', 0)
    const etfCommissionRate = this.configManager.getConfig('etfCommissionRate', 0)
    const stampTaxRate = this.configManager.getConfig('stampTaxRate', 0)
    const transferRate = this.configManager.getConfig('transferRate', 0)
    const commissionRate = isEtfStock ? etfCommissionRate : commonCommissionRate
    const commissionTemp = new Decimal(price).mul(shares).mul(commissionRate).toFixed(2)
    const commission = Math.max(Number(commissionTemp), 5)
    let marketCapital = new Decimal(oldCost).mul(oldShares).sub(new Decimal(price).mul(shares)).add(commission)
    if (!isEtfStock) {
      const stampTax = new Decimal(price).mul(shares).mul(stampTaxRate).toFixed(2)
      const transfer = new Decimal(price).mul(shares).mul(transferRate).toFixed(2)
      marketCapital = marketCapital.add(stampTax).add(transfer)
    }
    const newCost = marketCapital.div(newShares).toFixed(4)
    const stockData: Position = {
      cost: newShares > 0 ? Number(newCost) : 0,
      shares: newShares,
      tradeRecords: tradeRecords
    }
    if (!tradeRecords.some((item) => dayjs().isSame(item.time, 'day'))) {
      stockData.lastCost = oldCost
      stockData.lastShares = oldShares
      stockData.tradeRecords = [{
        type,
        price,
        shares,
        time: dayjs().format('YYYY-MM-DD')
      }]
    } else {
      stockData.tradeRecords = tradeRecords.concat({
        type,
        price,
        shares,
        time: dayjs().format('YYYY-MM-DD')
      })
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
    const tradeRecord = {
      symbol: stock.symbol,
      type,
      price: Number(inputPrice),
      shares: Number(inputShares)
    }
    if (type > 0) {
      this.buyStock(tradeRecord)
    } else {
      this.sellStock(tradeRecord)
    }
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
      validateInput: (value) => (Number(value) > 0 ? undefined : '请输入大于 0 的数量')
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
