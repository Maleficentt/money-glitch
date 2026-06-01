import * as vscode from 'vscode'
import { Stock } from './utils/types'
import dayjs from 'dayjs'
import ConfigManager from './utils/config-manger'
import { queryStock } from './utils/data-service'
import StockManager from './utils/stock-manager'

class StockGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupKey: string,
    public readonly stockCount: number,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(groupKey, collapsibleState)

    this.contextValue = 'group'
    this.description = `(${stockCount})`
    this.tooltip = `${groupKey} (${stockCount})`
  }
}

class StockItem extends vscode.TreeItem {
  constructor(
    public readonly stock: Stock,
    isIndex: boolean,
    context: vscode.ExtensionContext
  ) {
    const { name, quote, type } = stock
    const { percent, current } = quote
    const percentFormat = percent.toFixed(2)
    const currentFormat = type === 13 ? current.toFixed(3) : current.toFixed(2)
    const label = ` ${isIndex ? '   ' : ''} ${percent >= 0 ? `+${percentFormat}` : ` ${percentFormat}`}%   ${currentFormat.padEnd(12, ' ')}    ${name}`
    super(label, vscode.TreeItemCollapsibleState.None)

    this.contextValue = isIndex ? 'index' : 'stock'
    this.tooltip = StockItem.formatTooltip(stock)
    this.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      'resources',
      percent >= 0 ? percent > 2 ? 'up_2.svg' : 'up_1.svg' : percent < -2 ? 'down_2.svg' : 'down_1.svg'
    )
  }

  private static formatTooltip(stock: Stock): string {
    const { name, symbol, quote } = stock
    const { chg, percent, high, low, open, lastClose, volume, amount, lotSize, status, timestamp } = quote
    const quantity = Math.floor(volume / lotSize)
    const formatVolume = quantity > 100000 ? `${(quantity / 10000).toFixed(2)}万手` : `${quantity}手`
    const formatAmount = amount > 10000000000000 ? `${(amount / 1000000000000).toFixed(2)}万亿` : amount > 1000000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万`
    return `${name} ${symbol}\n涨跌：${chg}   涨幅：${percent}%\n最高：${high}   最低：${low}\n今开：${open}   昨收：${lastClose}\n成交量：${formatVolume}  成交额：${formatAmount}\n${status} ${dayjs(timestamp).format('MM-DD HH:mm:ss')}`
  }
}


type StockTreeItem = StockGroupItem | StockItem

class StockTreeProvider implements vscode.TreeDataProvider<StockTreeItem> {
  private configManager = ConfigManager.getInstance()
  private stockManager = StockManager.getInstance()
  private stockList: Stock[] = []
  private readonly changeEmitter = new vscode.EventEmitter<
    StockTreeItem | undefined | null | void
  >()

  readonly onDidChangeTreeData = this.changeEmitter.event

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(this.changeEmitter)

    this.stockManager.onDidChangeStockList((stocks) => {
      this.stockList = stocks
      this.refresh()
    })
  }

  getTreeItem(element: StockTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: StockTreeItem): Promise<StockTreeItem[]> {
    if (!element) {
      return [...this.getIndexItems(), ...this.getGroupItems()]
    }

    if (element instanceof StockGroupItem) {
      const indexSymbols = this.configManager.getIndexSymbols()
      const stockList = this.stockList
        .filter(stock => !indexSymbols.includes(stock.symbol))
      if (element.groupKey === 'ALL') {
        return stockList.map((stock) => new StockItem(stock, false, this.context))
      } else {
        return stockList
          .filter((stock) => stock.region === element.groupKey)
          .map((stock) => new StockItem(stock, false, this.context))
      }
    }

    return []
  }

  private getGroupItems(): StockGroupItem[] {
    const groups: StockGroupItem[] = []
    const stocksByRegion = this.groupStocksByRegion()

    let allCount = 0
    for (const [region, stocks] of stocksByRegion) {
      const count = stocks?.length || 0
      if (count > 0) { // 只显示有股票的地区
        groups.push(new StockGroupItem(
          region,
          count,
          vscode.TreeItemCollapsibleState.Collapsed
        ))
        allCount += count
      }
    }

    groups.sort()

    groups.unshift(new StockGroupItem(
      'ALL',
      allCount,
      vscode.TreeItemCollapsibleState.Expanded
    ))

    return groups
  }

  private getIndexItems(): StockItem[] {
    const indexSymbols = this.configManager.getIndexSymbols()
    const indexItems: StockItem[] = []
    this.stockList.forEach(stock => {
      if (indexSymbols.includes(stock.symbol)) {
        indexItems.push(new StockItem(stock, true, this.context))
      }
    })
    return indexItems
  }

  private groupStocksByRegion(): Map<string, Stock[]> {
    const indexSymbols = this.configManager.getIndexSymbols()
    const groups = new Map<string, Stock[]>()
    for (const stock of this.stockList) {
      if (indexSymbols.includes(stock.symbol)) continue
      const region = stock.region
      if (!groups.has(region)) {
        groups.set(region, [])
      }
      groups.get(region)!.push(stock)
    }
    return groups
  }

  async addStock(): Promise<void> {
    const quickPick = vscode.window.createQuickPick()
    quickPick.items = [{ label: '请输入股票名称或代码' }]
    let selectedSymbol: string | undefined
    let timer: NodeJS.Timeout | null
    quickPick.onDidChangeValue((value) => {
      quickPick.busy = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      timer = setTimeout(async () => {
        const res = await this.getStockSuggestList(value)
        quickPick.items = res
        quickPick.busy = false
      }, 100) // 简单防抖
    })
    quickPick.onDidChangeSelection((e) => {
      if (e[0].label) {
        selectedSymbol = e[0].label && e[0].label.split(' | ')[0]
      }
    })
    quickPick.show()
    quickPick.onDidAccept(async () => {
      if (!selectedSymbol) {
        return
      }
      await this.configManager.addStockSymbol(selectedSymbol)
      quickPick.hide()
      quickPick.dispose()
    })
  }

  private async getStockSuggestList(searchText = ''): Promise<vscode.QuickPickItem[]> {
    if (!searchText) {
      return Promise.resolve([{ label: '添加自选股票' }])
    }
    const result: vscode.QuickPickItem[] = []

    return queryStock(searchText).then(stockList => {
      stockList.forEach((item: Record<string, string>) => {
        const { code, name, ind_name } = item
        result.push({
          label: `${code} | ${name}`,
          description: ind_name ?? ''
        })
      })
      return Promise.resolve(result)
    }).catch(() => {
      return Promise.resolve([{ label: '股票查询失败，请重试' }])
    })
  }

  async deleteStock(item: StockItem): Promise<void> {
    const stock = item.stock
    const stockSymbol = stock.symbol
    const stockName = stock.name
    try {
      await this.configManager.removeStockSymbol(stockSymbol)
    } catch (error) {
      console.error('Failed to delete stock:', error)
      vscode.window.showErrorMessage(`Failed to delete ${stockName}`)
    }
  }

  swap(stockItem: StockItem, direction: number) {
    const { stock, contextValue } = stockItem
    const stockSymbols = this.configManager.getStockSymbols()
    const indexSymbols = this.configManager.getIndexSymbols()
    const swapIndexSymbols = stockSymbols.filter(item => indexSymbols.includes(item))
    const swapOtherSymbols = stockSymbols.filter(item => !indexSymbols.includes(item))
    let swapSymbols = [...stockSymbols]
    const isIndex = contextValue === 'index'
    if (isIndex) {
      swapSymbols = swapIndexSymbols
    } else {
      swapSymbols = swapOtherSymbols
    }
    const index = swapSymbols.findIndex(symbol => symbol === stock.symbol)
    if ((direction > 0 && index < swapSymbols.length - 1) || (direction < 0 && index > 0)) {
      const newIndex = index + direction
      const newArr = [...swapSymbols];
      [newArr[index], newArr[newIndex]] = [newArr[newIndex], newArr[index]]
      const newStockSymbols = isIndex ? [...newArr, ...swapOtherSymbols] : [...swapIndexSymbols, ...newArr]
      this.configManager.updateConfig('stockSymbols', newStockSymbols)
    }
  }

  refresh(): void {
    this.changeEmitter.fire()
  }
}

export default StockTreeProvider
