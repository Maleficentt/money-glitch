import * as vscode from 'vscode'
import TemplateEngine from './template-engine'
import StockManager from './stock-manager'
import ConfigManager from './config-manger'
import { queryStock } from './data-service'
import { Stock } from './types'

export default async function createSelectedWebview(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'selected',
    '自选',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  )

  const styleResetUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'normalize.css'))

  const templateEngine = TemplateEngine.getInstance()
  const html = await templateEngine.renderTemplate(
    context,
    'media/selected.html',
    {
      styleResetUri
    }
  )

  panel.webview.html = html

  const stockManager = StockManager.getInstance()
  const configManager = ConfigManager.getInstance()
  const indexSymbols = configManager.getIndexSymbols()
  const disposable = stockManager.onDidChangeStockList((stockList) => {
    const indices: Stock[] = []
    const stocks: Stock[] = []
    stockList.forEach(item => {
      if (indexSymbols.includes(item.symbol)) {
        indices.push(item)
      } else {
        stocks.push(item)
      }
    })
    panel.webview.postMessage({
      command: 'init',
      data: {
        indices,
        stocks
      }
    })
  })

  context.subscriptions.push(disposable)

  panel.onDidDispose(() => {
    disposable.dispose()
  })

  panel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
      case 'refresh':
        const stockList = stockManager.getStockList()
        const indices: Stock[] = []
        const stocks: Stock[] = []
        stockList.forEach(item => {
          if (indexSymbols.includes(item.symbol)) {
            indices.push(item)
          } else {
            stocks.push(item)
          }
        })
        panel.webview.postMessage({
          command: 'init',
          data: {
            indices,
            stocks
          }
        })
        break

      case 'addStock':
        configManager.addStockSymbol(message.data)
        break

      case 'setStockPosition':
        configManager.addStockSymbol(message.data.symbol)
        configManager.updatePosition(message.data)
        break

      case 'addStockTradeRecord':
        if (message.data.type > 0) {
          stockManager.buyStock(message.data)
        } else {
          stockManager.sellStock(message.data)
        }
        break

      case 'queryStock':
        queryStock(message.data).then(stockList => {
          panel.webview.postMessage({
            command: 'queryStockResponse',
            data: stockList
          })
        })
        break

    }
  })

}

