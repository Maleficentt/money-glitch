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
      command: 'refresh',
      data: stocks
    })
  })

  context.subscriptions.push(disposable)

  panel.onDidDispose(() => {
    disposable.dispose()
  })

  panel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
      case 'init':
        const stockList = stockManager.getStockList()
        const brokerMap = configManager.getBrokerMap()
        const brokerList = Object.keys(brokerMap).map(key => brokerMap[key])
        panel.webview.postMessage({
          command: 'init',
          data: {
            stockList,
            brokerList
          }
        })
        break

      case 'setStockPosition':
        configManager.addStockSymbol(message.data.symbol)
        configManager.updatePosition(message.data)
        break

      case 'addStockTradeRecord':
        const { stock, tradeRecord } = message.data
        if (tradeRecord.type > 0) {
          stockManager.buyStock(stock, tradeRecord)
        } else {
          stockManager.sellStock(stock, tradeRecord)
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

