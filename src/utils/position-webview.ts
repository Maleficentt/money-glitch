import * as vscode from 'vscode'
import TemplateEngine from './template-engine'
import StockManager from './stock-manager'
import ConfigManager from './config-manger'
import { queryStock } from './data-service'

export default async function createPositionWebview(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'position',
    '持仓',
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
    'media/position.html',
    {
      styleResetUri
    }
  )

  panel.webview.html = html

  const stockManager = StockManager.getInstance()
  const configManager = ConfigManager.getInstance()
  const disposable = stockManager.onDidChangeStockList((stocks) => {
    panel.webview.postMessage({
      command: 'init',
      data: stocks
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
        panel.webview.postMessage({
          command: 'init',
          data: stockList
        })
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

