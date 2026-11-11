import ConfigManager from './config-manger'
import { getMinuteData, getRealtimeQuote, getStockData } from './data-service'
import { Stock } from './types'
import { EventEmitter } from 'vscode'
import { getNextMarketDelay, isCanceled, retryDelay } from './market-time'

const marketTimerInterval: Record<string, number> = { CN: 2000, HK: 10000, US: 2000 }

interface MarketController {
  status: number
  symbols: string[]
  quoteAbortController: AbortController
  marketTimer: NodeJS.Timeout | null
  quoteTimer: NodeJS.Timeout | null
  minuteAbortController: AbortController
  minuteTimer: NodeJS.Timeout | null
  quoteFailures: number
  minuteFailures: number
}
class IndexManager {
  private static instance: IndexManager
  private configManager = ConfigManager.getInstance()
  private stockList: Stock[] = []
  private stockDataTimer: NodeJS.Timeout | null = null
  private stockDataController = new AbortController()
  private marketController: Record<string, MarketController> = {}
  private minuteDataMap: Record<string, []> = {}
  private disposed = false
  private stockDataFailures = 0
  private _onDidChangeStockList = new EventEmitter<Stock[]>()
  readonly onDidChangeStockList = this._onDidChangeStockList.event
  private _onDidChangeMinuteData = new EventEmitter<Record<string, []>>()
  readonly onDidChangeMinuteData = this._onDidChangeMinuteData.event

  private constructor() { /* empty */ }

  static getInstance(): IndexManager {
    if (!IndexManager.instance) IndexManager.instance = new IndexManager()
    return IndexManager.instance
  }

  getStockData(isRefresh = false) {
    if (this.disposed) return
    this.stockDataController.abort()
    const request = new AbortController()
    this.stockDataController = request
    const isCurrent = () => !this.disposed && !request.signal.aborted && this.stockDataController === request
    if (this.stockDataTimer) clearTimeout(this.stockDataTimer)
    this.stopMarketRequests()
    const symbols = [...new Set(this.configManager.getIndexSymbols())]
    let restSymbols = symbols
    if (!isRefresh) {
      this.stockList = this.stockList.filter(stock => symbols.includes(stock.symbol))
      restSymbols = symbols.filter(symbol => !this.stockList.some(stock => stock.symbol === symbol))
    }
    if (!restSymbols.length) {
      if (isRefresh) this.stockList = []
      this._onDidChangeStockList.fire(this.stockList)
      this.getMarketQuote()
      return
    }
    getStockData(restSymbols, { signal: request.signal }).then(data => {
      if (!isCurrent()) return
      this.stockDataFailures = 0
      this.stockList = isRefresh ? data : [...this.stockList, ...data]
      this._onDidChangeStockList.fire(this.stockList)
      this.getMarketQuote()
      this.stockDataTimer = setTimeout(() => {
        if (isCurrent()) this.getStockData(true)
      }, 600000)
    }).catch((error: unknown) => {
      if (isCurrent() && !isCanceled(error)) {
        console.error('Failed to refresh indexes', error)
        this.stockDataTimer = setTimeout(() => {
          if (isCurrent()) this.getStockData(isRefresh)
        }, retryDelay(++this.stockDataFailures))
      }
    })
  }

  private stopMarketRequests() {
    Object.values(this.marketController).forEach(controller => {
      if (controller.marketTimer) clearTimeout(controller.marketTimer)
      if (controller.quoteTimer) clearTimeout(controller.quoteTimer)
      if (controller.minuteTimer) clearTimeout(controller.minuteTimer)
      controller.quoteAbortController.abort()
      controller.minuteAbortController.abort()
    })
    this.marketController = {}
  }

  getMarketQuote() {
    this.stopMarketRequests()
    if (this.disposed) return
    const symbols = new Set(this.stockList.map(stock => stock.symbol))
    this.minuteDataMap = Object.fromEntries(Object.entries(this.minuteDataMap).filter(([symbol]) => symbols.has(symbol)))
    this.stockList.forEach(item => {
      if (this.marketController[item.region]) {
        this.marketController[item.region].status = item.quote.marketStatusId
        this.marketController[item.region].symbols.push(item.symbol)
      } else {
        this.marketController[item.region] = {
          status: item.quote.marketStatusId,
          symbols: [item.symbol],
          quoteAbortController: new AbortController(),
          marketTimer: null,
          quoteTimer: null,
          minuteAbortController: new AbortController(),
          minuteTimer: null,
          quoteFailures: 0,
          minuteFailures: 0
        }
      }
    })
    Object.entries(this.marketController).forEach(([region, controller]) => {
      const trading = [3, 5].includes(controller.status)
      if (trading) this.getRealtimeQuote(region)
      this.getMinuteData(region, !trading)
      controller.marketTimer = setTimeout(() => {
        if (!this.disposed && this.marketController[region] === controller) this.getStockData(true)
      }, getNextMarketDelay(region, controller.status))
    })
  }

  private getRealtimeQuote(region: string) {
    const controller = this.marketController[region]
    if (this.disposed || !controller) return
    controller.quoteAbortController.abort()
    if (controller.quoteTimer) clearTimeout(controller.quoteTimer)
    const request = new AbortController()
    controller.quoteAbortController = request
    const isCurrent = () => !this.disposed && !request.signal.aborted &&
      this.marketController[region] === controller && controller.quoteAbortController === request
    getRealtimeQuote(controller.symbols, { signal: request.signal }).then(quoteMap => {
      if (!isCurrent()) return
      controller.quoteFailures = 0
      this.stockList.forEach(item => {
        if (quoteMap[item.symbol]) Object.assign(item.quote, quoteMap[item.symbol])
      })
      this._onDidChangeStockList.fire(this.stockList)
      controller.quoteTimer = setTimeout(() => {
        if (isCurrent()) this.getRealtimeQuote(region)
      }, marketTimerInterval[region] ?? 10000)
    }).catch((error: unknown) => {
      if (isCurrent() && !isCanceled(error)) {
        console.error('Failed to refresh index quotes', error)
        controller.quoteTimer = setTimeout(() => {
          if (isCurrent()) this.getRealtimeQuote(region)
        }, retryDelay(++controller.quoteFailures, marketTimerInterval[region] ?? 10000))
      }
    })
  }

  private getMinuteData(region: string, once = false) {
    const controller = this.marketController[region]
    if (this.disposed || !controller) return
    controller.minuteAbortController.abort()
    if (controller.minuteTimer) clearTimeout(controller.minuteTimer)
    const request = new AbortController()
    controller.minuteAbortController = request
    const isCurrent = () => !this.disposed && !request.signal.aborted &&
      this.marketController[region] === controller && controller.minuteAbortController === request
    Promise.all(controller.symbols.map(async symbol => ({
      symbol, data: await getMinuteData(symbol, { signal: request.signal })
    }))).then(results => {
      if (!isCurrent()) return
      controller.minuteFailures = 0
      results.forEach(({ symbol, data }) => { this.minuteDataMap[symbol] = data })
      this._onDidChangeMinuteData.fire(this.minuteDataMap)
      if (!once) {
        controller.minuteTimer = setTimeout(() => {
          if (isCurrent()) this.getMinuteData(region)
        }, 60000)
      }
    }).catch((error: unknown) => {
      if (isCurrent() && !isCanceled(error)) {
        console.error('Failed to refresh minute data', error)
        controller.minuteTimer = setTimeout(() => {
          if (isCurrent()) this.getMinuteData(region, once)
        }, retryDelay(++controller.minuteFailures, 10000))
      }
    })
  }

  getStockList(): Stock[] {
    return this.stockList
  }

  getMinuteDataMap() {
    return this.minuteDataMap
  }

  refresh() {
    this.disposed = false
    this.getStockData(true)
  }

  dispose() {
    this.disposed = true
    this.stockDataController.abort()
    if (this.stockDataTimer) clearTimeout(this.stockDataTimer)
    this.stopMarketRequests()
  }
}

export default IndexManager
