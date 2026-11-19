// utils/StatusBarManager.ts
import * as vscode from 'vscode'
import ConfigManager from './utils/config-manger'
import { Stock } from './utils/types'
import StockManager from './utils/stock-manager'
import Decimal from 'decimal.js'
import dayjs from 'dayjs'
import { isDefined } from './utils/common'
import { getMarketDate } from './utils/market-time'

export class StatusBarManager {
  private static instance: StatusBarManager
  private stockBarItems: vscode.StatusBarItem[] = []
  private configManager = ConfigManager.getInstance()
  private stockManager = StockManager.getInstance()
  private stockList: Stock[] = []
  private readonly MAX_STOCKS = 4
  private profitBarItem: vscode.StatusBarItem | null = null
  private stockSubscription: vscode.Disposable

  private constructor() {
    this.stockSubscription = this.stockManager.onDidChangeStockList((stocks) => {
      this.stockList = stocks
      this.refresh()
    })
  }

  static getInstance(): StatusBarManager {
    if (!StatusBarManager.instance) {
      StatusBarManager.instance = new StatusBarManager()
    }
    return StatusBarManager.instance
  }

  refresh() {
    this.initStockBarItems()
    this.initProfitBarItem()
  }

  private getStockSymbols(): string[] {
    return this.configManager.getConfig('statusBarStockSymbols', [])
  }

  initStockBarItems(): void {
    const stockSymbols = this.getStockSymbols()
    const selectedStockList: Stock[] = []
    stockSymbols.forEach(symbol => {
      const selectedStock = this.stockList.find(s => s.symbol === symbol)
      if (selectedStock) {
        selectedStockList.push(selectedStock)
      }
    })

    const itemsToKeep = selectedStockList.length
    if (this.stockBarItems.length > itemsToKeep) {
      const itemsToDispose = this.stockBarItems.splice(itemsToKeep)
      itemsToDispose.forEach(item => item.dispose())
    }


    this.stockBarItems.forEach((barItem, index) => {
      const stock = selectedStockList[index]
      if (stock) {
        barItem.text = this.formatStatusBarText(stock)
        barItem.color = this.formatColor(stock)
        barItem.tooltip = this.formatTooltip(stock)
        barItem.command = {
          command: 'moneyGlitch.changeStatusBarItem',
          title: 'change stock',
          arguments: [stock.symbol]
        }
        barItem.show()
      }
    })

    for (let i = this.stockBarItems.length; i < selectedStockList.length; i++) {
      this.createStatusBarItem(selectedStockList[i])
    }
  }

  private createStatusBarItem(stock: Stock): void {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      2
    )

    item.text = this.formatStatusBarText(stock)
    item.color = this.formatColor(stock)
    item.tooltip = this.formatTooltip(stock)
    item.command = {
      command: 'moneyGlitch.changeStatusBarItem',
      title: 'change stock',
      arguments: [stock.symbol]
    }

    item.show()
    this.stockBarItems.push(item)
  }

  private formatStatusBarText(stock: Stock): string {
    const { name, quote, type } = stock
    const { current, lastClose, percent } = quote
    const price = current || lastClose
    const currentFormat = isDefined(price) ? (type === 13 ? price.toFixed(3) : price.toFixed(2)) : '--'
    const percentFormat = isDefined(percent) ? `${percent.toFixed(2)}%` : '--'
    return `${this.shortenName(name)} ${currentFormat} ${percentFormat}`
  }

  private shortenName(name: string): string {
    // 缩短名称，最多4个字符
    if (name.length <= 4) return name
    if (name.includes(' ')) {
      return name.split(' ').map(w => w[0]).join('')
    }
    return name.slice(0, 4)
  }

  private formatColor(stock: Stock) {
    const { percent } = stock.quote
    let color = undefined
    if (percent) {
      if (percent < 0) {
        color = new vscode.ThemeColor('charts.green')
      } else if (percent > 0) {
        // color = new vscode.ThemeColor('charts.red')
      }
    }
    return color
  }

  private formatTooltip(stock: Stock): string {
    const { name, symbol, quote } = stock
    if (quote.status === 0) {
      return `${name} ${symbol}\n未上市，暂无行情数据`
    } else {
      const { current, chg, percent, high, low, open, lastClose, volume, amount, lotSize, marketStatus, timestamp } = quote
      let formatVolume = '-'
      if (isDefined(volume)) {
        const quantity = Math.floor(volume / lotSize)
        formatVolume = quantity > 100000 ? `${(quantity / 10000).toFixed(2)}万手` : `${quantity}手`
      }
      const formatAmount = isDefined(amount) ? amount > 10000000000000 ? `${(amount / 1000000000000).toFixed(2)}万亿` : amount > 1000000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万` : '--'
      return `${name} ${symbol}\n最新：${current}\n涨跌：${chg}   涨幅：${percent}%\n最高：${high}   最低：${low}\n今开：${open}   昨收：${lastClose}\n成交量：${formatVolume}  成交额：${formatAmount}\n${marketStatus} ${dayjs(timestamp).format('MM-DD HH:mm:ss')}`
    }
  }

  async addStockToStatusBar(stock: Stock): Promise<boolean> {
    const currentSymbols = this.getStockSymbols()

    // 检查是否已存在
    if (currentSymbols.some(symbol => symbol === stock.symbol)) {
      vscode.window.showWarningMessage(`Stock ${stock.name} is already in status bar`)
      return false
    }

    // 检查数量限制
    if (currentSymbols.length >= this.MAX_STOCKS) {
      vscode.window.showWarningMessage(`Status bar can only show up to ${this.MAX_STOCKS} stocks`)
      return false
    }

    await this.configManager.addStockSymbolToStatusBar(stock.symbol)

    // 刷新状态栏
    this.initStockBarItems()
    return true
  }

  private initProfitBarItem() {
    if (!this.profitBarItem) {
      this.profitBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        6
      )
    }
    let totalMarketValue = new Decimal(0) // 总市值
    let totalProfit = new Decimal(0) // 总盈亏
    let todayProfit = new Decimal(0) // 当日盈亏
    let todayProfitBase = new Decimal(0)
    let todayProfitComplete = true
    this.stockList.forEach((item: Stock) => {
      const { profit, positionCny } = item
      if (positionCny) totalMarketValue = totalMarketValue.add(positionCny.marketValue)
      if (profit) {
        totalProfit = totalProfit.add(profit.totalProfit)
        todayProfit = todayProfit.add(profit.todayProfit)
        if (Number.isFinite(profit.todayProfitBase) && profit.todayProfitBase! >= 0 &&
          Number.isFinite(profit.todayProfit) && positionCny) {
          todayProfitBase = todayProfitBase.add(profit.todayProfitBase!)
        } else {
          todayProfitComplete = false
        }
      } else if (item.position && (item.position.shares > 0 || item.position.tradeRecords?.some(record =>
        record.time === getMarketDate(item.region, Number.isFinite(item.quote.timestamp) ? item.quote.timestamp : Date.now())))) {
        todayProfitComplete = false
      }
    })
    let totalProfitRate = '0'
    const todayProfitRate = todayProfitComplete && todayProfitBase.gt(0)
      ? `${todayProfit.div(todayProfitBase).mul(100).toFixed(2)}%` : '--'
    if (totalMarketValue.toNumber() > 0) {
      totalProfitRate = totalProfit.div(totalMarketValue).mul(100).toFixed(2)
    }
    const monthlyProfitTemp = this.stockManager.getMonthlyProfit()
    const today = getMarketDate('CN')
    const unsettledProfit = this.stockList.reduce((sum, stock) =>
      stock.region === 'CN' && stock.profit && Number.isFinite(stock.quote.timestamp) &&
      getMarketDate('CN', stock.quote.timestamp) === today && !this.stockManager.isProfitSettled(stock)
        ? sum.add(stock.profit.todayProfit) : sum, new Decimal(0))
    const monthlyProfit = new Decimal(monthlyProfitTemp).add(unsettledProfit)
    let monthlyProfitRate = '0'
    if (totalMarketValue.toNumber() > 0) {
      monthlyProfitRate = monthlyProfit.div(totalMarketValue).mul(100).toFixed(2)
    }
    const showMonthlyProfit = this.configManager.getConfig('showMonthlyProfit', true)
    this.profitBarItem.text = showMonthlyProfit
      ? `💰 ${totalProfit} | ${monthlyProfit} | ${todayProfit}`
      : `💰 ${totalProfit} | ${todayProfit}`
    // const unavailable = this.stockList.filter(stock => stock.position && stock.position.shares > 0 && (!stock.profit || !stock.positionCny))
    // const staleRates = this.stockList.filter(stock => stock.exchangeRateStale)
    // const dataStatus = [
    //   this.stockManager.getRefreshStatus(),
    //   unavailable.length ? `收益暂不可用：${unavailable.map(stock => stock.name).join('、')}` : '',
    //   staleRates.length ? `使用过期汇率：${staleRates.map(stock => stock.name).join('、')}` : ''
    // ].filter(Boolean).join('\r\n')
    this.profitBarItem.tooltip = `总市值: ${totalMarketValue}  持仓盈亏: ${totalProfit} (${totalProfitRate}%)` +
      (showMonthlyProfit ? `\r\n当月盈亏: ${monthlyProfit} (${monthlyProfitRate}%)` : '') +
      `  当日盈亏: ${todayProfit} (${todayProfitRate})\r\n` +
      // `${this.stockManager.getSettlementStatus()}\r\n` +
      // (dataStatus ? `${dataStatus}\r\n` : '') +
      '-----------------------------\r\n' +
      this.stockList.filter(item => !!item.profit)
        .sort((a, b) => b.profit!.todayProfit - a.profit!.todayProfit)
        .map((v) => {
          const dailyRate = Number.isFinite(v.profit!.todayProfitRate) ? `${v.profit!.todayProfitRate}%` : '--'
          return `${v.name} 持仓盈亏: ${v.profit!.totalProfit} (${v.profit!.totalProfitRate}%) 当日盈亏: ${v.profit!.todayProfit} (${dailyRate}) `
        })
        .join('\r\n-----------------------------\r\n')
    this.profitBarItem.command = {
      command: 'moneyGlitch.positionManagement',
      title: '持仓管理'
    }
    this.profitBarItem.show()
  }

  dispose(): void {
    this.stockSubscription.dispose()
    this.stockBarItems.forEach(item => item.dispose())
    this.profitBarItem?.dispose()
  }

  changeStatusBarItem(stockSymbol: string) {
    const stockList = this.stockList
    const stockSymbols = this.getStockSymbols()
    const stockNameList = stockList
      .filter((stock) => !stockSymbols.includes(stock.symbol))
      .map((item: Stock) => {
        return {
          label: `${item.name}`,
          description: `${item.symbol}`
        }
      })
    stockNameList.unshift({
      label: `股票买入`,
      description: 'buy'
    })
    stockNameList.unshift({
      label: `股票卖出`,
      description: 'sell'
    })
    stockNameList.unshift({
      label: `持仓设置`,
      description: 'setStockPosition'
    })
    stockNameList.unshift({
      label: `删除`,
      description: `-1`
    })
    vscode.window.showQuickPick(stockNameList, {
      placeHolder: '更换状态栏个股'
    }).then((res) => {
      if (!res) return
      const description = res.description
      if (description === '-1') {
        this.configManager.removeStockSymbolFromStatusBar(stockSymbol)
      } else if (['buy', 'sell'].includes(description)) {
        const target = stockList.find(item => item.symbol === stockSymbol)
        this.stockManager.tradeStock(target as Stock, description === 'buy' ? 1 : -1)
      } else if (description === 'setStockPosition') {
        const target = stockList.find(item => item.symbol === stockSymbol)
        this.stockManager.setStockPosition(target as Stock)
      } else {
        this.configManager.replaceStockSymbolInStatusBar(stockSymbol, description)
      }
    })
  }
}
