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
  let disposed = false
  const panelDisposables: vscode.Disposable[] = []
  context.subscriptions.push(panel)
  panel.onDidDispose(() => {
    disposed = true
    panelDisposables.forEach(disposable => disposable.dispose())
  })

  const styleResetUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'normalize.css'))

  const templateEngine = TemplateEngine.getInstance()
  const html = await templateEngine.renderTemplate(
    context,
    'media/position.html',
    {
      styleResetUri
    }
  )
  if (disposed) return

  const stockManager = StockManager.getInstance()
  const configManager = ConfigManager.getInstance()
  const disposable = stockManager.onDidChangeStockList((stocks) => {
    panel.webview.postMessage({
      command: 'refresh',
      data: stocks
    })
  })

  panelDisposables.push(disposable)

  const messageDisposable = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message.command !== 'string') return
    try {
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
          await configManager.updatePosition(message.data)
          await configManager.addStockSymbol(message.data.symbol)
          await panel.webview.postMessage({ command: 'operationSuccess', data: message.command })
          break

        case 'addStockTradeRecord':
          const { stock, tradeRecord } = message.data
          if (tradeRecord.type > 0) {
            await stockManager.buyStock(stock, tradeRecord)
          } else {
            await stockManager.sellStock(stock, tradeRecord)
          }
          await panel.webview.postMessage({ command: 'operationSuccess', data: message.command })
          break

        case 'queryStock':
          const results = await queryStock(message.data)
          if (!disposed) await panel.webview.postMessage({ command: 'queryStockResponse', data: results })
          break

      }
    } catch (error) {
      if (!disposed) {
        await panel.webview.postMessage({ command: 'operationError', data: error instanceof Error ? error.message : '操作失败，请重试' })
      }
    }
  })
  panelDisposables.push(messageDisposable)
  panel.webview.html = html

}

