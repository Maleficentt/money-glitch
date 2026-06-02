import * as vscode from 'vscode'
import TemplateEngine from './template-engine'
import StockManager from './stock-manager'
import ConfigManager from './config-manger'
import { queryStock } from './data-service'
import IndexManager from './index-manager'

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
  const indexManager = IndexManager.getInstance()
  indexManager.refresh()
  const stockDisposable = stockManager.onDidChangeStockList((stocks) => {
    panel.webview.postMessage({
      command: 'refresh',
      data: {
        stocks
      }
    })
  })
  const indexDisposable = indexManager.onDidChangeStockList((indices) => {
    panel.webview.postMessage({
      command: 'refresh',
      data: {
        indices
      }
    })
  })
  const indexMinuteDisposable = indexManager.onDidChangeMinuteData((minuteData) => {
    panel.webview.postMessage({
      command: 'refreshMinute',
      data: minuteData
    })
  })
  context.subscriptions.push(stockDisposable, indexDisposable, indexMinuteDisposable)

  panel.onDidDispose(() => {
    stockDisposable.dispose()
    indexDisposable.dispose()
    indexMinuteDisposable.dispose()
  })

  const configManager = ConfigManager.getInstance()

  panel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
      case 'refresh':
        const stockList = stockManager.getStockList()
        const indexList = indexManager.getStockList()
        panel.webview.postMessage({
          command: 'refresh',
          data: {
            stocks: stockList,
            indices: indexList
          }
        })
        indexManager.getMarketQuote()
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

      case 'deleteStock':
        configManager.removeStockSymbol(message.data)
        break

    }
  })

}

