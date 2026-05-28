import * as vscode from 'vscode'
import StockProvider from './stock-provider'
import ConfigManager from './utils/config-manger'
import { StatusBarManager } from './status-bar'
import createPositionWebview from './utils/position-webview'
import StockManager from './utils/stock-manager'

export function activate(context: vscode.ExtensionContext) {
  const configManager = ConfigManager.getInstance()

  const stockManager = StockManager.getInstance()
  stockManager.refresh()

  const statusBarManager = StatusBarManager.getInstance()

  const provider = new StockProvider(context)
  const treeView = vscode.window.createTreeView('stocks', {
    treeDataProvider: provider
  })

  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('moneyGlitch')) {
      configManager.refreshConfig()
      if (e.affectsConfiguration('moneyGlitch.stockSymbols')) {
        stockManager.refresh()
        statusBarManager.refresh()
      }
      if (e.affectsConfiguration('moneyGlitch.statusBarStockSymbols')) {
        statusBarManager.refresh()
      }
    }
  })

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('moneyGlitch.refreshStocks', () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand('moneyGlitch.addStock', () =>
      provider.addStock()
    ),
    vscode.commands.registerCommand('moneyGlitch.addToStatusBar', (stockItem) =>
      statusBarManager.addStockToStatusBar(stockItem.stock)
    ),
    vscode.commands.registerCommand('moneyGlitch.deleteStock', (stockItem) =>
      provider.deleteStock(stockItem)
    ),
    vscode.commands.registerCommand('moneyGlitch.moveEntryUp', (stockItem) =>
      provider.moveEntryUp(stockItem)
    ),
    vscode.commands.registerCommand('moneyGlitch.moveEntryDown', (stockItem) =>
      provider.moveEntryDown(stockItem)
    ),
    vscode.commands.registerCommand('moneyGlitch.changeStatusBarItem', (stockSymbol) => {
      statusBarManager.changeStatusBarItem(stockSymbol)
    }),
    vscode.commands.registerCommand('moneyGlitch.positionManagement', () => {
      createPositionWebview(context)
    }),
    vscode.commands.registerCommand('moneyGlitch.buyStock', (stockItem) => {
      stockManager.tradeStock(stockItem.stock, 1)
    }),
    vscode.commands.registerCommand('moneyGlitch.sellStock', (stockItem) => {
      stockManager.tradeStock(stockItem.stock, -1)
    }),
    vscode.commands.registerCommand('moneyGlitch.setStockPosition', (stockItem) => {
      stockManager.tradeStock(stockItem.stock, -1)
    }),
    {
      dispose: () => {
        statusBarManager.dispose()
        stockManager.dispose()
      }
    }
  )
}

export function deactivate() {
  const statusBarManager = StatusBarManager.getInstance()
  statusBarManager.dispose()
}
