import dayjs from 'dayjs'
import ConfigManager from './config-manger'
import { getMinuteData, getRealtimeQuote, getStockData } from './data-service'
import { Stock } from './types'
import { EventEmitter } from 'vscode'

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
  quoteAbortController: AbortController
  marketTimer: NodeJS.Timeout | null
  quoteTimer: NodeJS.Timeout | null
  minuteAbortController: AbortController
  minuteTimer: NodeJS.Timeout | null
}
class IndexManager {
  private static instance: IndexManager
  private configManager = ConfigManager.getInstance()
  private stockList: Stock[] = []
  private stockDataTimer: NodeJS.Timeout | null = null
  private stockDataController = new AbortController()
  private marketController: Record<string, MarketController> = {}
  private minuteDataMap: Record<string, []> = {}
  private _onDidChangeStockList = new EventEmitter<Stock[]>()
  readonly onDidChangeStockList = this._onDidChangeStockList.event
  private _onDidChangeMinuteData = new EventEmitter<Record<string, []>>()
  readonly onDidChangeMinuteData = this._onDidChangeMinuteData.event

  private constructor() { /* empty */ }

  static getInstance(): IndexManager {
    if (!IndexManager.instance) {
      IndexManager.instance = new IndexManager()
    }
    return IndexManager.instance
  }

  getStockData(isRefresh = false) {
    this.stockDataController.abort()
    this.stockDataController = new AbortController()
    if (isRefresh && this.stockDataTimer) {
      clearTimeout(this.stockDataTimer)
    }
    const stockSymbols = this.configManager.getIndexSymbols()
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
      this._onDidChangeStockList.fire(this.stockList)
    }
  }

  getMarketQuote() {
    Object.keys(this.marketController).forEach(region => {
      const { marketTimer, quoteAbortController, quoteTimer, minuteAbortController, minuteTimer } = this.marketController[region]
      if (marketTimer) {
        clearTimeout(marketTimer)
      }
      quoteAbortController.abort()
      if (quoteTimer) {
        clearTimeout(quoteTimer)
      }
      minuteAbortController.abort()
      if (minuteTimer) {
        clearTimeout(minuteTimer)
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
          quoteAbortController: new AbortController(),
          marketTimer: null,
          quoteTimer: null,
          minuteAbortController: new AbortController(),
          minuteTimer: null
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
        this.getMinuteData(region)
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
      } else if (status === 1) { // 未开盘
        const timeList = marketOpenTime[region][0][0]
        const startTime = dayjs().set('hour', timeList[0]).set('minute', timeList[1] ?? 0)
        const countdown = startTime.diff(new Date()) + 1000
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
        this.getMinuteData(region, true)
        const timer = setTimeout(() => {
          this.stockList = []
          this.getStockData()
        }, countdown)
        this.marketController[region].marketTimer = timer
      }
    })
  }

  private getRealtimeQuote(region: string) {
    const { symbols, quoteAbortController, quoteTimer } = this.marketController[region]
    quoteAbortController.abort()
    if (quoteTimer) {
      clearTimeout(quoteTimer)
    }
    const newAbortController = new AbortController()
    this.marketController[region].quoteAbortController = newAbortController
    if (symbols.length) {
      getRealtimeQuote(symbols, { signal: newAbortController.signal }).then(quoteMap => {
        this.stockList.forEach(item => {
          if (quoteMap[item.symbol]) {
            Object.assign(item.quote, quoteMap[item.symbol])
          }
        })
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

  private getMinuteData(region: string, once = false) {
    const { symbols, minuteAbortController, minuteTimer } = this.marketController[region]
    if (!once) {
      minuteAbortController.abort()
      if (minuteTimer) {
        clearTimeout(minuteTimer)
      }
      const newAbortController = new AbortController()
      this.marketController[region].minuteAbortController = newAbortController
    }
    const requests = symbols.map(symbol => {
      return getMinuteData(symbol, { signal: this.marketController[region].minuteAbortController.signal }).then(res => {
        return { [symbol]: res }
      })
    })
    Promise.all(requests).then(resList => {
      this.minuteDataMap = {}
      resList.forEach(item => {
        Object.assign(this.minuteDataMap, item)
      })
      this._onDidChangeMinuteData.fire(this.minuteDataMap)
      if (!once) {
        this.marketController[region].minuteTimer = setTimeout(() => {
          this.getMinuteData(region)
        }, 60000)
      }
    }).catch(err => {
      const errData = err.toJSON()
      if (errData.code !== 'ERR_CANCELED') {
        this.marketController[region].minuteTimer = setTimeout(() => {
          this.getMinuteData(region, once)
        }, 60000)
      }
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
      const { marketTimer, quoteAbortController, quoteTimer, minuteAbortController, minuteTimer } = this.marketController[region]
      if (marketTimer) {
        clearTimeout(marketTimer)
      }
      quoteAbortController.abort()
      if (quoteTimer) {
        clearTimeout(quoteTimer)
      }
      minuteAbortController.abort()
      if (minuteTimer) {
        clearTimeout(minuteTimer)
      }
    })
    this.marketController = {}
  }
}

export default IndexManager
