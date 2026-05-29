// utils/StatusBarManager.ts
import * as vscode from 'vscode'
import ConfigManager from './utils/config-manger'
import { Position, Stock } from './utils/types'
import StockManager from './utils/stock-manager'
import Decimal from 'decimal.js'
import dayjs from 'dayjs'

export class StatusBarManager {
  private static instance: StatusBarManager
  private stockBarItems: vscode.StatusBarItem[] = []
  private configManager = ConfigManager.getInstance()
  private stockManager = StockManager.getInstance()
  private stockList: Stock[] = []
  private readonly MAX_STOCKS = 4
  private profitBarItem: vscode.StatusBarItem | null = null

  private constructor() {
    this.stockManager.onDidChangeStockList((stocks) => {
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
    const { name, quote } = stock
    const { current, percent } = quote
    return `${this.shortenName(name)} ${current.toFixed(3)} ${percent}%`
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
    const { chg, percent, high, low, open, lastClose, volume, amount, lotSize, status, time } = quote
    const quantity = Math.floor(volume / lotSize)
    const formatVolume = quantity > 100000 ? `${(quantity / 10000).toFixed(2)}万手` : `${quantity}手`
    const formatAmount = amount > 10000000000000 ? `${(amount / 1000000000000).toFixed(2)}万亿` : amount > 1000000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万`
    return `${name} ${symbol}\n涨跌：${chg}   涨幅：${percent}%\n最高：${high}   最低：${low}\n今开：${open}   昨收：${lastClose}\n成交量：${formatVolume}  成交额：${formatAmount}\n${status} ${dayjs(time).format('MM-DD HH:mm:ss')}`
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
    this.stockList.forEach((item: Stock) => {
      const { profit } = item
      if (!profit) return
      const { shares } = item.position as Position
      const { current } = item.quote
      totalMarketValue = totalMarketValue.add(new Decimal(current).mul(shares))
      totalProfit = totalProfit.add(profit.totalProfit)
      todayProfit = todayProfit.add(profit.todayProfit)
    })
    const totalProfitRate = totalProfit.div(totalMarketValue).mul(100).toFixed(2)
    const todayProfitRate = todayProfit.div(totalMarketValue).mul(100).toFixed(2)
    this.profitBarItem.text = `💰 ${totalProfit} | ${todayProfit}`
    this.profitBarItem.tooltip = `总市值: ${totalMarketValue} 持仓收益: ${totalProfit} (${totalProfitRate}%) 当日盈亏: ${todayProfit} (${todayProfitRate}%)\r\n` +
      '-----------------------------\r\n' +
      this.stockList.filter(item => !!item.profit)
        .sort((a, b) => b.profit!.todayProfit - a.profit!.todayProfit)
        .map((v) => {
          return `${v.name} 持仓收益: ${v.profit!.totalProfit} (${v.profit!.totalProfitRate}%) 当日盈亏: ${v.profit!.todayProfit} (${v.profit!.todayProfitRate}%) `
        })
        .join('\r\n-----------------------------\r\n')
    this.profitBarItem.command = {
      command: 'moneyGlitch.positionManagement',
      title: '持仓管理'
    }
    this.profitBarItem.show()
  }

  dispose(): void {
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
      label: `股票卖出`,
      description: 'buy'
    })
    stockNameList.unshift({
      label: `股票买入`,
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