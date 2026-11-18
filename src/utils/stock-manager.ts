import dayjs from 'dayjs'
import ConfigManager from './config-manger'
import { getExchangeRates, getExchangeRateStatus, getRealtimeQuote, getStockData } from './data-service'
import { getMarketDate, getMarketOpenTime, getNextMarketDelay, isCanceled, retryDelay } from './market-time'
import { Position, Stock, TradeRecord } from './types'
import { EventEmitter } from 'vscode'
import Decimal from 'decimal.js'
import * as vscode from 'vscode'
import { MonthlyProfitLedger } from './monthly-profit'
import { SharedJsonStorage } from './shared-json-storage'
import { getTradeFees, isHongKongStock, requiresHongKongCommissionRate, validatePosition, validateTrade } from './trade-validation'
import { getPositionCny, getStockCurrency } from './position-currency'


const marketTimerInterval: Record<string, number> = {
  CN: 2000,
  HK: 10000,
  US: 2000
}

interface MarketController {
  failures: number
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
  private disposed = false
  private stockDataFailures = 0
  private refreshErrors = new Map<string, string>()
  private marketController: Record<string, MarketController> = {}
  private profitLedger?: MonthlyProfitLedger
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
    if (this.disposed) return
    this.stockDataController.abort()
    const controller = new AbortController()
    this.stockDataController = controller
    const isCurrent = () => !this.disposed && !controller.signal.aborted && this.stockDataController === controller
    if (this.stockDataTimer) clearTimeout(this.stockDataTimer)
    this.stopMarketRequests()
    const positions = this.configManager.getPosition()
    const today = getMarketDate()
    const positionSymbols = Object.keys(positions).filter(symbol => positions[symbol].shares > 0 ||
      positions[symbol].tradeRecords?.some(record => record.time === today))
    const stockSymbols = [...new Set([...this.configManager.getStockSymbols(), ...positionSymbols])]
    let restSymbols = stockSymbols
    if (!isRefresh) {
      this.stockList = this.stockList.filter(stock => stockSymbols.includes(stock.symbol))
      restSymbols = stockSymbols.filter(symbol => !this.stockList.some(stock => stock.symbol === symbol))
    }
    const dataRequest = restSymbols.length
      ? getStockData(restSymbols, { signal: controller.signal })
      : Promise.resolve([])
    dataRequest.then(async data => {
      if (!isCurrent()) return
      this.stockList = isRefresh ? data : [...this.stockList, ...data]
      await this.formatStockList(isCurrent)
      if (!isCurrent()) return
      this.stockDataFailures = 0
      this.refreshErrors.clear()
      this.sort()
      this._onDidChangeStockList.fire(this.stockList)
      this.getMarketQuote()
      this.stockDataTimer = setTimeout(() => {
        if (isCurrent()) this.getStockData(true)
      }, 600000)
    }).catch((error: unknown) => {
      if (isCurrent() && !isCanceled(error)) {
        console.error('Failed to refresh stocks', error)
        this.refreshErrors.set('all', '行情刷新失败，正在重试（当前显示上次数据）')
        this._onDidChangeStockList.fire(this.stockList)
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
      controller.abortController.abort()
    })
    this.marketController = {}
  }

  private getMarketQuote() {
    this.stopMarketRequests()
    if (this.disposed) return
    this.stockList.forEach(item => {
      if (this.marketController[item.region]) {
        this.marketController[item.region].status = item.quote.marketStatusId
        this.marketController[item.region].symbols.push(item.symbol)
      } else {
        this.marketController[item.region] = {
          failures: 0,
          status: item.quote.marketStatusId,
          symbols: [item.symbol],
          abortController: new AbortController(),
          marketTimer: null,
          quoteTimer: null
        }
      }
    })
    Object.entries(this.marketController).forEach(([region, controller]) => {
      if ([3, 5].includes(controller.status)) this.getRealtimeQuote(region)
      controller.marketTimer = setTimeout(() => {
        if (!this.disposed && this.marketController[region] === controller) this.getStockData(true)
      }, getNextMarketDelay(region, controller.status))
    })
  }

  private getRealtimeQuote(region: string) {
    const controller = this.marketController[region]
    if (this.disposed || !controller) return
    controller.abortController.abort()
    if (controller.quoteTimer) clearTimeout(controller.quoteTimer)
    const request = new AbortController()
    controller.abortController = request
    const isCurrent = () => !this.disposed && !request.signal.aborted &&
      this.marketController[region] === controller && controller.abortController === request
    getRealtimeQuote(controller.symbols, { signal: request.signal }).then(async quoteMap => {
      if (!isCurrent()) return
      this.stockList.forEach(item => {
        if (quoteMap[item.symbol]) Object.assign(item.quote, quoteMap[item.symbol])
      })
      await this.formatStockList(isCurrent)
      if (!isCurrent()) return
      controller.failures = 0
      this.refreshErrors.delete(region)
      this._onDidChangeStockList.fire(this.stockList)
      controller.quoteTimer = setTimeout(() => {
        if (isCurrent()) this.getRealtimeQuote(region)
      }, marketTimerInterval[region] ?? 10000)
    }).catch((error: unknown) => {
      if (isCurrent() && !isCanceled(error)) {
        console.error('Failed to refresh quotes', error)
        this.refreshErrors.set(region, `${region} 行情刷新失败，正在重试`)
        this._onDidChangeStockList.fire(this.stockList)
        controller.quoteTimer = setTimeout(() => {
          if (isCurrent()) this.getRealtimeQuote(region)
        }, retryDelay(++controller.failures, marketTimerInterval[region] ?? 10000))
      }
    })
  }

  private async formatStockList(isCurrent: () => boolean = () => true) {
    const stockPosition = this.configManager.getPosition()
    const stockList: Stock[] = []
    let exchangeRates: Awaited<ReturnType<typeof getExchangeRates>> = []
    const needsExchangeRates = this.stockList.some(stock => stockPosition[stock.symbol] && getStockCurrency(stock) !== 'CNY')
    if (needsExchangeRates) {
      try {
        exchangeRates = await getExchangeRates()
      } catch (error) {
        console.error('Exchange rates unavailable; foreign profit is not calculated', error)
      }
    }
    if (!isCurrent()) return
    this.stockList.forEach(item => {
      const stock = { ...item }
      delete stock.profit
      delete stock.position
      delete stock.positionCny
      delete stock.exchangeRateStale
      const position = stockPosition[stock.symbol]
      try {
        if (position) {
          validatePosition(position)
          stock.position = position
          const { cost, shares, tradeRecords, totalProfit: pTotalProfit } = position
          const { marketStatusId, timestamp } = item.quote
          const diffOpen = Math.floor((getMarketOpenTime(stock.region) - Date.now()) / 60000)
          const todayTradeRecords: TradeRecord[] = (tradeRecords || []).filter((record: TradeRecord) => dayjs(timestamp).isSame(record.time, 'day') || (marketStatusId === 1 && diffOpen > 15 && dayjs(timestamp).diff(record.time, 'day') <= 1))
          if (shares || todayTradeRecords.length) {
            const { lastClose, current, status } = item.quote
            const currency = getStockCurrency(stock)
            if (!Number.isFinite(current) || !Number.isFinite(lastClose)) throw new Error('行情价格无效')
            // 总盈亏
            let exchangeRate = 1
            if (currency !== 'CNY') {
              const rate = exchangeRates.find(item => item.quote === currency)?.rate
              if (!rate || !Number.isFinite(rate) || rate <= 0) {
                stockList.push(stock)
                return
              }
              exchangeRate = rate
              stock.exchangeRateStale = getExchangeRateStatus().stale
            }
            stock.positionCny = getPositionCny(stock, exchangeRate)
            const totalProfit = status !== 0
              ? shares
                ? new Decimal(current).sub(cost).mul(shares)
                : new Decimal(pTotalProfit || 0)
              : new Decimal(0)
            // 总盈亏百分比 = (当前价 - 成本价) / 成本价
            const totalProfitRate = status !== 0 && cost
              ? new Decimal(current).sub(cost).div(cost).mul(100).toFixed(2)
              : '0'
            let todayProfit = new Decimal(0)
            let todayProfitRate = '0'
            if (status !== 0) {
              if (marketStatusId !== 1 || diffOpen > 15) { // 开盘前15分钟重置当日盈亏
                todayProfit = new Decimal(current).sub(lastClose).mul(shares) // 当日盈亏
                let yestShares = shares
                if (todayTradeRecords.length > 0) {
                  let restYestShares = shares
                  let tradeProfit = new Decimal(0)
                  for (const record of todayTradeRecords) {
                    const { price: tradePrice, shares: tradeShares } = record
                    validateTrade(record)
                    if (record.fees !== undefined && (!Number.isFinite(record.fees) || record.fees < 0)) {
                      throw new Error('交易费用快照无效')
                    }
                    const fees = record.fees === undefined
                      ? getTradeFees(stock, record, this.configManager.getBrokerMap(), exchangeRate)
                      : new Decimal(record.fees)
                    if (record.type === 1) {
                      yestShares -= tradeShares
                      restYestShares -= tradeShares
                      const currentTradeProfit = new Decimal(current).sub(tradePrice).mul(tradeShares)
                      tradeProfit = tradeProfit.add(currentTradeProfit).sub(fees)
                    } else if (record.type === -1) {
                      yestShares += tradeShares
                      const currentTradeProfit = new Decimal(tradePrice).sub(lastClose).mul(tradeShares)
                      tradeProfit = tradeProfit.add(currentTradeProfit).sub(fees)
                    }
                  }
                  todayProfit = new Decimal(current).sub(lastClose).mul(restYestShares).add(tradeProfit)
                }
                // 当日盈亏百分比 = 当日盈亏金额 ÷ 当日初始持仓市值 × 100%
                const todayBase = yestShares ? new Decimal(yestShares).mul(lastClose) : new Decimal(cost).mul(shares)
                todayProfitRate = todayBase.isZero() ? '0' : todayProfit.div(todayBase).mul(100).toFixed(2)
              }
            }
            stock.profit = {
              totalProfit: Number((shares ? totalProfit.div(exchangeRate) : totalProfit).toFixed(2)),
              totalProfitRate: Number(totalProfitRate),
              todayProfit: Number(todayProfit.div(exchangeRate).toFixed(2)),
              todayProfitRate: todayProfitRate ? Number(todayProfitRate) : 0
            }
          }

        }
      } catch (error) {
        console.error(`Profit unavailable for ${stock.symbol}`, error)
        delete stock.profit
      }
      stockList.push(stock)
    })
    if (!isCurrent()) return
    this.stockList = stockList
    await this.settleMonthlyProfit()
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

  getRefreshStatus(): string {
    return [...this.refreshErrors.values()].join('\r\n')
  }

  refresh() {
    this.getStockData(true)
  }
  

  initializeSettlement(state: vscode.Memento, storageDirectory: string) {
    this.profitLedger = new MonthlyProfitLedger(state,
      () => this.configManager.getMonthlyProfitConfiguration(),
      async (value, revision) => {
        await this.configManager.updateConfig('monthlyProfit', value)
        // The token follows the amount so delayed configuration snapshots cannot look like manual edits.
        await this.configManager.updateConfig('monthlyProfitRevision', revision)
        this.configManager.refreshConfig()
      }, Date.now, new SharedJsonStorage(storageDirectory))
  }

  getMonthlyProfit(): number {
    return this.profitLedger?.getMonthlyProfit() ?? this.configManager.getConfig<number>('monthlyProfit', 0)
  }

  getSettlementStatus(): string {
    return this.profitLedger?.status ?? ''
  }

  isProfitSettled(stock: Stock): boolean {
    return this.profitLedger?.isSettled(stock) ?? false
  }

  private async settleMonthlyProfit() {
    try {
      await this.profitLedger?.settle(this.stockList, this.configManager.getPosition())
    } catch (error) {
      console.error('Failed to settle monthly profit', error)
    }
  }

  async correctDailyProfit() {
    const date = await vscode.window.showInputBox({ prompt: '补录或修正 A 股每日总盈亏，日期格式 YYYY-MM-DD' })
    if (!date) return
    const input = await vscode.window.showInputBox({ prompt: `${date} 的 A 股总盈亏（元，可为负数；替换该日自动结算）` })
    if (input === undefined) return
    try {
      if (!input.trim()) throw new Error('请输入收益金额')
      if (!this.profitLedger) throw new Error('收益账本尚未初始化')
      await this.profitLedger.correctDay(date, Number(input))
      this._onDidChangeStockList.fire(this.stockList)
      void vscode.window.showInformationMessage(`${date} 收益已保存`)
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  dispose() {
    this.disposed = true
    this._onDidChangeStockList.dispose()
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

  private async requireExchangeRate(currency: string): Promise<number> {
    if (currency === 'CNY') return 1
    if (!currency) throw new Error('无法确定股票币种，请刷新行情后重试')
    const rates = await getExchangeRates()
    const rate = rates.find(item => item.quote === currency)?.rate
    if (getExchangeRateStatus().stale || !rate || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`暂时无法获取 ${currency} 的有效汇率，请稍后重试`)
    }
    return rate
  }

  private async calculateTradeFees(stock: Stock, trade: TradeRecord): Promise<Decimal> {
    const brokers = this.configManager.getBrokerMap()
    const exchangeRate = requiresHongKongCommissionRate(stock, brokers[trade.broker])
      ? await this.requireExchangeRate('HKD') : undefined
    return getTradeFees(stock, trade, brokers, exchangeRate)
  }

  async buyStock(stock: Stock, tradeData: TradeRecord): Promise<void> {
    validateTrade(tradeData)
    if (tradeData.type !== 1) throw new Error('买入交易方向无效')
    const { price, shares } = tradeData
    const fees = await this.calculateTradeFees(stock, tradeData)
    await this.configManager.updatePositionWith(stock.symbol, async current => {
      const position = current ?? { cost: 0, shares: 0 }
      validatePosition(position)
      const newShares = position.shares + shares
      let capital = new Decimal(position.cost).mul(position.shares).add(new Decimal(price).mul(shares)).add(fees)
      // Realized profit is stored in CNY; convert back before incorporating it into the native cost.
      if (position.shares === 0 && position.totalProfit) {
        const rate = await this.requireExchangeRate(getStockCurrency(stock))
        capital = capital.sub(new Decimal(position.totalProfit).mul(rate))
      }
      const tradeRecords = (position.tradeRecords ?? []).filter(item => dayjs().isSame(item.time, 'day'))
      // Subscribe before committing the trade, so a subscription failure cannot cause a duplicate retry.
      await this.configManager.addStockSymbol(stock.symbol)
      const cost = capital.div(newShares)
      return {
        // Keep HK fee cents intact when distributing them over many shares.
        cost: isHongKongStock(stock) ? cost.toNumber() : Number(cost.toFixed(4)),
        shares: newShares,
        tradeRecords: [...tradeRecords, { ...tradeData, fees: fees.toNumber(), time: dayjs().format('YYYY-MM-DD') }]
      }
    })
  }

  async sellStock(stock: Stock, tradeData: TradeRecord): Promise<void> {
    validateTrade(tradeData)
    if (tradeData.type !== -1) throw new Error('卖出交易方向无效')
    const { price, shares } = tradeData
    const fees = await this.calculateTradeFees(stock, tradeData)
    await this.configManager.updatePositionWith(stock.symbol, async current => {
      const position = current ?? { cost: 0, shares: 0 }
      validatePosition(position)
      if (shares > position.shares) throw new Error(`卖出数量不能超过当前持仓（${position.shares} 股）`)
      const newShares = position.shares - shares
      const capital = new Decimal(position.cost).mul(position.shares).sub(new Decimal(price).mul(shares)).add(fees)
      const tradeRecords = (position.tradeRecords ?? []).filter(item => dayjs().isSame(item.time, 'day'))
      const cost = newShares ? capital.div(newShares) : new Decimal(0)
      const next: Position = {
        cost: isHongKongStock(stock) ? cost.toNumber() : Number(cost.toFixed(4)),
        shares: newShares,
        tradeRecords: [...tradeRecords, { ...tradeData, fees: fees.toNumber(), time: dayjs().format('YYYY-MM-DD') }]
      }
      if (newShares === 0) {
        const rate = await this.requireExchangeRate(getStockCurrency(stock))
        next.totalProfit = Number(capital.negated().div(rate).toFixed(2))
      }
      return next
    })
  }

  async tradeStock(stock: Stock, type: number): Promise<void> {
    try {
      const typeDisplay = type > 0 ? '买入' : '卖出'
      const price = stock.quote.current || 0
      const inputPrice = await vscode.window.showInputBox({
        prompt: `请输入${typeDisplay}价格（原币：${getStockCurrency(stock) || '未知'}）`,
        value: price ? String(price) : '',
        validateInput: value => Number.isFinite(Number(value)) && Number(value) > 0
          ? undefined : '请输入大于 0 的有限数字'
      })
      if (inputPrice === undefined) return
      const inputShares = await vscode.window.showInputBox({
        prompt: `请输入${typeDisplay}数量`,
        validateInput: value => Number.isSafeInteger(Number(value)) && Number(value) > 0
          ? undefined : '请输入大于 0 的整数数量'
      })
      if (inputShares === undefined) return
      const brokers = this.configManager.getBrokerMap()
      const options = Object.keys(brokers).map(code => ({ label: brokers[code].name, description: code }))
      options.push({ label: '无', description: '' })
      const selected = await vscode.window.showQuickPick(options, { placeHolder: '请选择券商' })
      if (!selected) return
      const trade = { type, price: Number(inputPrice), shares: Number(inputShares), broker: selected.description }
      if (type === 1) await this.buyStock(stock, trade)
      else await this.sellStock(stock, trade)
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : '交易保存失败')
    }
  }

  async setStockPosition(stock: Stock): Promise<void> {
    try {
      const cost = stock.quote.current || 0
      const inputCost = await vscode.window.showInputBox({
        prompt: `请输入成本（原币：${getStockCurrency(stock) || '未知'}）`,
        value: cost ? String(cost) : '',
        validateInput: value => value.trim() && Number.isFinite(Number(value))
          ? undefined : '请输入有限数字成本'
      })
      if (inputCost === undefined) return
      const inputShares = await vscode.window.showInputBox({
        prompt: '请输入持仓数量',
        validateInput: value => value.trim() && Number.isSafeInteger(Number(value)) && Number(value) >= 0
          ? undefined : '请输入大于或等于 0 的整数数量'
      })
      if (inputShares === undefined) return
      await this.configManager.updatePosition({
        symbol: stock.symbol,
        cost: Number(inputCost),
        shares: Number(inputShares)
      })
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : '持仓保存失败')
    }
  }
}

export default StockManager
