import * as vscode from 'vscode'
import StockProvider from './stock-provider'

export function activate(context: vscode.ExtensionContext) {
  const provider = new StockProvider(context)
  const treeView = vscode.window.createTreeView('stocks', {
    treeDataProvider: provider
  })

  // status bar item to show selected stock
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.command = 'workbench.action.showCommands'
  statusBarItem.hide()
  context.subscriptions.push(statusBarItem)

  // const updateStatusBarFromSelection = (selection?: readonly vscode.TreeItem[]) => {
  //   const item = selection && selection[0]
  //   if (!item) {
  //     statusBarItem.hide()
  //     return
  //   }
  //   // StockTreeProvider's StockItem stores the raw stock under a `stock` property
  //   const stock = (item as any).stock
  //   if (!stock) {
  //     statusBarItem.hide()
  //     return
  //   }
  //   const last = typeof stock.last === 'number' ? stock.last.toFixed(2) : '--'
  //   const prevClose = typeof stock.prevClose === 'number' ? stock.prevClose : 0
  //   const change = prevClose ? ((stock.last - prevClose) / prevClose * 100).toFixed(2) : '0'
  //   const sign = Number(change) >= 0 ? '+' : ''
  //   statusBarItem.text = `$(graph) ${stock.name} ${last} (${sign}${change}%)`
  //   statusBarItem.tooltip = `${stock.name} (${stock.code})`
  //   statusBarItem.show()
  // }

  // // update when selection changes
  // treeView.onDidChangeSelection((e) => updateStatusBarFromSelection(e.selection))

  // // update when provider refreshes (keep selected stock price up-to-date)
  // provider.onDidChangeTreeData(() => updateStatusBarFromSelection(treeView.selection))

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('money-glitch.addStock', () =>
      provider.addStock()
    ),
    vscode.commands.registerCommand('money-glitch.deleteStock', (item) =>
      provider.deleteStock(item)
    ),
    vscode.commands.registerCommand('money-glitch.moveEntryUp', (item) =>
      provider.moveEntryUp(item)
    ),
    vscode.commands.registerCommand('money-glitch.moveEntryDown', (item) =>
      provider.moveEntryDown(item)
    ),
    vscode.commands.registerCommand('money-glitch.refreshStocks', () =>
      provider.refresh()
    )
  )
}

// export function deactivate() {}
