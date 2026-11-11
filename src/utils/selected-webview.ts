import * as vscode from 'vscode'
import TemplateEngine from './template-engine'
import StockManager from './stock-manager'
import ConfigManager from './config-manger'
import { queryStock } from './data-service'
import IndexManager from './index-manager'

let selectedPanelCount = 0

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
  let disposed = false
  let active = false
  const panelDisposables: vscode.Disposable[] = []
  context.subscriptions.push(panel)
  panel.onDidDispose(() => {
    if (disposed) return
    disposed = true
    panelDisposables.forEach(disposable => disposable.dispose())
    if (active) {
      selectedPanelCount--
      if (selectedPanelCount === 0) IndexManager.getInstance().dispose()
    }
  })

  const styleResetUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'normalize.css'))

  const templateEngine = TemplateEngine.getInstance()
  const html = await templateEngine.renderTemplate(
    context,
    'media/selected.html',
    {
      styleResetUri
    }
  )
  if (disposed) return

  const stockManager = StockManager.getInstance()
  const indexManager = IndexManager.getInstance()
  const configManager = ConfigManager.getInstance()
  const selectedStocks = () => stockManager.getStockList().filter(stock => configManager.getStockSymbols().includes(stock.symbol))
  selectedPanelCount++
  active = true
  if (selectedPanelCount === 1) indexManager.refresh()
  const stockDisposable = stockManager.onDidChangeStockList((stocks) => {
    panel.webview.postMessage({
      command: 'refresh',
      data: {
        stocks: stocks.filter(stock => configManager.getStockSymbols().includes(stock.symbol)),
        holdings: stocks
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
  panelDisposables.push(stockDisposable, indexDisposable, indexMinuteDisposable)

  const messageDisposable = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message.command !== 'string') return
    try {
      switch (message.command) {
        case 'init':
        case 'refresh':
          const stockList = selectedStocks()
          const indexList = indexManager.getStockList()
          const brokerMap = configManager.getBrokerMap()
          const brokerList = Object.keys(brokerMap).map(key => brokerMap[key])
          panel.webview.postMessage({
            command: 'refresh',
            data: {
              stocks: stockList,
              holdings: stockManager.getStockList(),
              indices: indexList,
              brokers: brokerList
            }
          })
          await panel.webview.postMessage({ command: 'refreshMinute', data: indexManager.getMinuteDataMap() })
          break

        case 'addStock':
          await configManager.addStockSymbol(message.data)
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

        case 'deleteStock':
          await configManager.removeStockSymbol(message.data)
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

