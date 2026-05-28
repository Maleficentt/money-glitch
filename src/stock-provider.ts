import * as vscode from 'vscode'
import { StockCategory, Stock } from './utils/types'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import isBetween from 'dayjs/plugin/isBetween'
import ConfigManager from './utils/config-manger'
import { queryStock } from './utils/data-service'
import StockManager from './utils/stock-manager'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isBetween)

class StockCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly stockCategory: StockCategory,
    public readonly stockCount: number,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(stockCategory, collapsibleState)

    this.contextValue = 'stockCategory'
    this.description = `(${stockCount})`
    this.tooltip = `${stockCategory} (${stockCount})`
  }
}

class StockItem extends vscode.TreeItem {
  constructor(public readonly stock: Stock, context: vscode.ExtensionContext) {
    const { name, quote } = stock
    const { percent, current } = quote
    const label = `  ${percent >= 0 ? `+${percent}` : ` ${percent}`}%   ${current.toFixed(2).padEnd(12, ' ')}    ${name}`
    super(label, vscode.TreeItemCollapsibleState.None)

    this.contextValue = 'stock'
    this.tooltip = StockItem.formatTooltip(stock)
    this.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      'resources',
      percent >= 0 ? percent > 2 ? 'up_2.svg' : 'up_1.svg' : percent < -2 ? 'down_2.svg' : 'down_1.svg'
    )
  }

  private static formatTooltip(stock: Stock): string {
    const { chg, percent, high, low, open, lastClose, volume, amount, lotSize, time } = stock.quote
    const quantity = Math.floor(volume / lotSize)
    const formatVolume = quantity > 100000 ? `${(quantity / 10000).toFixed(2)}万手` : `${quantity}手`
    const formatAmount = amount > 10000000000000 ? `${(amount / 1000000000000).toFixed(2)}万亿` : amount > 1000000000 ? `${(amount / 100000000).toFixed(2)}亿` : `${(amount / 10000).toFixed(2)}万`
    return `涨跌：${chg}   涨幅：${percent}%\n最高：${high}   最低：${low}\n今开：${open}   昨收：${lastClose}\n成交量：${formatVolume}  成交额：${formatAmount}\n更新时间：${dayjs(time).format('MM-DD HH:mm:ss')}`
  }
}


type StockTreeItem = StockCategoryItem | StockItem

class StockTreeProvider implements vscode.TreeDataProvider<StockTreeItem> {
  private configManager = ConfigManager.getInstance()
  private stockManager = StockManager.getInstance()
  private stockList: Stock[] = []
  private static readonly StockCategories: StockCategory[] = ['A Stock', 'HK Stock', 'US STOCK']
  private readonly defaultExpandedStockTypes = new Set<StockCategory>(['A Stock'])
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
      return StockTreeProvider.StockCategories.map(
        (stockCategory) =>
          new StockCategoryItem(
            stockCategory,
            this.getStocksByCategory(this.stockList, stockCategory).length,
            this.getStockTypeCollapsibleState(stockCategory)
          )
      )
    }

    if (element instanceof StockCategoryItem) {
      return this.stockList
        .filter((stock) => stock.category === element.stockCategory)
        .map((stock) => new StockItem(stock, this.context))
    }

    return []
  }

  async addStock(): Promise<void> {
    const quickPick = vscode.window.createQuickPick()
    quickPick.items = [{ label: '请输入关键词查询，如：0000001 或 上证指数; 期货输入大写字母开头' }]
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
      if (e[0].description) {
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

  async moveEntryUp(_item?: StockTreeItem): Promise<void> {
    console.log(_item)
    await vscode.window.showInformationMessage('Stock data source is reserved.')
  }

  async moveEntryDown(_item?: StockTreeItem): Promise<void> {
    console.log(_item)
    await vscode.window.showInformationMessage('Stock data source is reserved.')
  }

  refresh(): void {
    this.changeEmitter.fire()
  }

  private getStocksByCategory(stocks: Stock[], stockCategory: StockCategory): Stock[] {
    return stocks.filter((stock) => stock.category === stockCategory)
  }

  private getStockTypeCollapsibleState(
    stockCategory: StockCategory
  ): vscode.TreeItemCollapsibleState {
    return this.defaultExpandedStockTypes.has(stockCategory)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
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
}

export default StockTreeProvider
