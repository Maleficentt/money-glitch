import * as vscode from 'vscode'
import { Stock } from './utils/types'
import dayjs from 'dayjs'
import ConfigManager from './utils/config-manger'
import { queryStock } from './utils/data-service'
import StockManager from './utils/stock-manager'
import { isDefined } from './utils/common'

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
    stockId: string,
    public stock: Stock,
    private readonly context: vscode.ExtensionContext
  ) {
    super('', vscode.TreeItemCollapsibleState.None)
    this.id = stockId
    this.update(stock)
  }

  update(stock: Stock) {
    this.stock = stock
    const { name, quote, type, region } = this.stock
    const { percent, current, lastClose } = quote
    const percentFormat = isDefined(percent) ? `${percent >= 0 ? `+${percent.toFixed(2)}` : `${percent.toFixed(2)}`}%` : '--'
    const price = current || lastClose
    const currentFormat = isDefined(price) ? type === 13 ? price.toFixed(3) : price.toFixed(2) : '--'
    this.label = ` ${percentFormat.padEnd(7, ' ')}  ${currentFormat.padEnd(9, ' ')} ${name}${region !== 'CN' ? `[${region}]` : ''}`

    this.contextValue = type === 12 ? 'index' : 'stock'
    this.tooltip = this.formatTooltip()
    this.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
      percent >= 0 ? percent > 2 ? 'up_2.svg' : 'up_1.svg' : percent < -2 ? 'down_2.svg' : 'down_1.svg'
    )
  }

  private formatTooltip(): string {
    const { name, symbol, quote } = this.stock
    const { current, chg, percent, high, low, open, lastClose, volume, amount, lotSize, status, timestamp } = quote
    let formatVolume = '-'
    if (isDefined(volume)) {
      const quantity = Math.floor(volume / lotSize)
      formatVolume = quantity > 100000 ? `${(quantity / 10000).toFixed(2)}万手` : `${quantity}手`
    }
    const formatAmount = isDefined(amount) ? amount > 10000000000000 ? `${(amount / 1000000000000).toFixed(2)}万亿` : amount > 1000000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万` : '--'
    return `${name} ${symbol}\n最新：${current}\n涨跌：${chg}   涨幅：${percent}%\n最高：${high}   最低：${low}\n今开：${open}   昨收：${lastClose}\n成交量：${formatVolume}  成交额：${formatAmount}\n${status} ${dayjs(timestamp).format('MM-DD HH:mm:ss')}`
  }
}


type StockTreeItem = StockGroupItem | StockItem

class StockTreeProvider implements vscode.TreeDataProvider<StockTreeItem> {
  private configManager = ConfigManager.getInstance()
  private stockManager = StockManager.getInstance()
  private stockList: Stock[] = []
  private readonly changeEmitter = new vscode.EventEmitter<StockTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this.changeEmitter.event

  private stockCache = new Map<string, StockItem>()

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
      return [...this.getGroupItems()]
    }

    if (element instanceof StockGroupItem) {
      if (element.groupKey === 'ALL') {
        return this.stockList.map((stock) => {
          let item = this.stockCache.get(stock.symbol)
          if (!item) {
            const stockId = `${element.groupKey}_${stock.symbol}`
            item = new StockItem(stockId, stock, this.context)
            this.stockCache.set(stockId, item)
          } else {
            item.update(stock)
          }
          return item
        })
      } else {
        return this.stockList
          .filter((stock) => stock.region === element.groupKey)
          .map((stock) => {
            let item = this.stockCache.get(stock.symbol)
            if (!item) {
              const stockId = `${element.groupKey}_${stock.symbol}`
              item = new StockItem(stockId, stock, this.context)
              this.stockCache.set(stockId, item)
            } else {
              item.update(stock)
            }
            return item
          })
      }
    }

    return []
  }

  private getGroupItems(): StockGroupItem[] {
    const groups: StockGroupItem[] = []

    const groupByRegion = this.configManager.getConfig<boolean>('groupByRegion', true)
    if (groupByRegion) {
      const stocksByRegion = this.groupStocksByRegion()
      for (const [region, stocks] of stocksByRegion) {
        const count = stocks?.length || 0
        if (count > 0) { // 只显示有股票的地区
          groups.push(new StockGroupItem(
            region,
            count,
            vscode.TreeItemCollapsibleState.Collapsed
          ))
        }
      }
      groups.sort()
    }

    groups.unshift(new StockGroupItem(
      'ALL',
      this.stockList.length,
      vscode.TreeItemCollapsibleState.Expanded
    ))

    return groups
  }

  private groupStocksByRegion(): Map<string, Stock[]> {
    const groups = new Map<string, Stock[]>()
    for (const stock of this.stockList) {
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
      this.configManager.addStockSymbol(selectedSymbol)
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
    const { stock } = stockItem
    const stockSymbols = this.configManager.getStockSymbols()
    const index = stockSymbols.findIndex(symbol => symbol === stock.symbol)
    if ((direction > 0 && index < stockSymbols.length - 1) || (direction < 0 && index > 0)) {
      const newIndex = index + direction
      const newArr = [...stockSymbols];
      [newArr[index], newArr[newIndex]] = [newArr[newIndex], newArr[index]]
      this.configManager.updateConfig('stockSymbols', newArr)
    }
  }

  refresh(): void {
    this.changeEmitter.fire()
  }
}

export default StockTreeProvider
