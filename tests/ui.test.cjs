const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')

class Emitter {
  listeners = new Set()
  event = callback => {
    this.listeners.add(callback)
    return { dispose: () => this.listeners.delete(callback) }
  }
  fire(value) { return Promise.all([...this.listeners].map(callback => callback(value))) }
  dispose() { this.listeners.clear() }
}

function fixture({ render = async () => '<html></html>' } = {}) {
  const stockEvents = new Emitter()
  const indexEvents = new Emitter()
  const minuteEvents = new Emitter()
  const panels = []
  const writes = []
  const config = {
    symbols: ['SH600000'],
    getStockSymbols() { return this.symbols },
    getConfig: (_, fallback) => fallback,
    getBrokerMap: () => ({}),
    updatePosition: async data => { writes.push(['position', data]) },
    addStockSymbol: async symbol => { writes.push(['symbol', symbol]) },
    removeStockSymbol: async () => {}
  }
  const stockManager = {
    stocks: [],
    onDidChangeStockList: stockEvents.event,
    getStockList() { return this.stocks },
    buyStock: async () => {},
    sellStock: async () => {}
  }
  const indexManager = {
    starts: 0, stops: 0,
    refresh() { this.starts++ },
    dispose() { this.stops++ },
    getStockList: () => [],
    getMinuteDataMap: () => ({ SH000001: [{ current: 3000 }] }),
    onDidChangeStockList: indexEvents.event,
    onDidChangeMinuteData: minuteEvents.event
  }
  const vscode = {
    EventEmitter: Emitter,
    TreeItem: class { constructor(label, state) { this.label = label; this.state = state } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    ViewColumn: { One: 1 },
    window: { createWebviewPanel() {
      const disposal = new Emitter()
      const messages = new Emitter()
      const panel = {
        sent: [],
        onDidDispose: disposal.event,
        dispose: () => disposal.fire(),
        receive: data => messages.fire(data),
        messages,
        webview: {
          asWebviewUri: uri => uri,
          onDidReceiveMessage: messages.event,
          postMessage: async data => { panel.sent.push(data); return true }
        }
      }
      panels.push(panel)
      return panel
    } }
  }
  const original = Module._load
  Module._load = function (request, parent, main) {
    if (request === 'vscode') return vscode
    if (request.endsWith('/config-manger')) return { default: { getInstance: () => config }, __esModule: true }
    if (request.endsWith('/stock-manager')) return { default: { getInstance: () => stockManager }, __esModule: true }
    if (request.endsWith('/index-manager')) return { default: { getInstance: () => indexManager }, __esModule: true }
    if (request.endsWith('/template-engine')) return { default: { getInstance: () => ({ renderTemplate: render }) }, __esModule: true }
    if (request.endsWith('/data-service')) return { queryStock: async () => [] }
    return original.call(this, request, parent, main)
  }
  const load = filename => {
    const location = path.resolve(__dirname, '../out', filename)
    delete require.cache[location]
    return require(location).default
  }
  let Provider, selected, position
  try {
    Provider = load('stock-provider.js')
    selected = load('utils/selected-webview.js')
    position = load('utils/position-webview.js')
  } finally { Module._load = original }
  const context = { extensionUri: 'extension', subscriptions: [] }
  return { Provider, selected, position, context, panels, stockEvents, indexEvents, minuteEvents, stockManager, indexManager, config, writes }
}

const stock = (symbol = 'SH600000', current = 10) => ({
  symbol, name: 'Example', region: 'CN', type: 11,
  quote: { current, lastClose: 10, percent: 1, status: 1, timestamp: Date.now(), lotSize: 100 }
})

test('tree caches each group identity, updates quotes, evicts removals and hides holdings outside watchlist', async () => {
  const f = fixture()
  const provider = new f.Provider(f.context)
  await f.stockEvents.fire([stock(), stock('SH600001')])
  const groups = await provider.getChildren()
  const [allItem] = await provider.getChildren(groups.find(group => group.groupKey === 'ALL'))
  const [regionItem] = await provider.getChildren(groups.find(group => group.groupKey === 'CN'))
  assert.notEqual(allItem, regionItem)
  await f.stockEvents.fire([stock('SH600000', 11)])
  const repeated = await provider.getChildren(groups[0])
  assert.equal(repeated.length, 1)
  assert.equal(repeated[0], allItem)
  assert.equal(repeated[0].stock.quote.current, 11)
  await f.stockEvents.fire([])
  assert.equal(provider.stockCache.size, 0)
  f.context.subscriptions.forEach(disposable => disposable.dispose())
  assert.equal(f.stockEvents.listeners.size, 0)
})

test('selected panels share polling, stop after last close, and restart on reopen', async () => {
  const f = fixture()
  await f.selected(f.context)
  await f.selected(f.context)
  assert.equal(f.indexManager.starts, 1)
  assert.equal(f.indexEvents.listeners.size, 2)
  await f.panels[0].dispose()
  assert.equal(f.indexManager.stops, 0)
  await f.panels[1].dispose()
  assert.equal(f.indexManager.stops, 1)
  assert.equal(f.indexEvents.listeners.size, 0)
  assert.equal(f.stockEvents.listeners.size, 0)
  assert.equal(f.minuteEvents.listeners.size, 0)
  await f.selected(f.context)
  assert.equal(f.indexManager.starts, 2)
  f.stockManager.stocks = [stock(), stock('SH600001')]
  await f.panels[2].receive({ command: 'refresh' })
  const initial = f.panels[2].sent.find(message => message.command === 'refresh')
  assert.equal(initial.command, 'refresh')
  assert.equal(initial.data.stocks.length, 1)
  assert.equal(initial.data.holdings.length, 2)
  assert.deepEqual(f.panels[2].sent.at(-1), { command: 'refreshMinute', data: { SH000001: [{ current: 3000 }] } })
  await f.panels[2].dispose()
})

test('closing during template load does not attach listeners or start polling', async () => {
  let finish
  const f = fixture({ render: () => new Promise(resolve => { finish = resolve }) })
  const opening = f.selected(f.context)
  await f.panels[0].dispose()
  finish('<html></html>')
  await opening
  assert.equal(f.indexManager.starts, 0)
  assert.equal(f.stockEvents.listeners.size, 0)
  assert.equal(f.panels[0].messages.listeners.size, 0)
})

test('both webviews await writes, report failures and leave invalid positions out of watchlist', async () => {
  for (const factory of ['selected', 'position']) {
    const f = fixture()
    await f[factory](f.context)
    const panel = f.panels[0]
    f.stockManager.sellStock = async () => { throw Error('卖出数量不能超过持仓') }
    await panel.receive({ command: 'addStockTradeRecord', data: { stock: stock(), tradeRecord: { type: -1 } } })
    assert.deepEqual(panel.sent.at(-1), { command: 'operationError', data: '卖出数量不能超过持仓' })
    f.config.updatePosition = async () => { throw Error('数量无效') }
    await panel.receive({ command: 'setStockPosition', data: { symbol: 'SH600001' } })
    assert.equal(f.writes.length, 0)
    f.config.updatePosition = async () => { f.writes.push('saved') }
    await panel.receive({ command: 'setStockPosition', data: { symbol: 'SH600001' } })
    assert.deepEqual(f.writes, ['saved', ['symbol', 'SH600001']])
    assert.deepEqual(panel.sent.at(-1), { command: 'operationSuccess', data: 'setStockPosition' })
    await panel.dispose()
    assert.equal(panel.messages.listeners.size, 0)
  }
})

test('HTML scripts parse and keep trade form open until persisted success', () => {
  for (const name of ['position', 'selected']) {
    const html = fs.readFileSync(path.resolve(__dirname, `../media/${name}.html`), 'utf8')
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(text => text.trim())
    let options, onMessage
    const sent = [], errors = []
    const context = vm.createContext({
      Vue: function (value) { options = value },
      window: { addEventListener: (_, callback) => { onMessage = callback } },
      acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
      console, setTimeout
    })
    for (const source of scripts) new vm.Script(source).runInContext(context)
    const instance = { ...options.data, $message: { error: message => errors.push(message) } }
    options.mounted.call(instance)
    instance.tradeFormVisible = true
    instance.selectedStock = stock()
    options.methods.submitTradeForm.call(instance)
    options.methods.submitTradeForm.call(instance)
    assert.equal(sent.filter(message => message.command === 'addStockTradeRecord').length, 1)
    assert.equal(instance.tradeFormVisible, true)
    onMessage({ data: { command: 'operationError', data: '写入失败' } })
    assert.equal(instance.tradeFormVisible, true)
    assert.equal(instance.mutationPending, false)
    assert.deepEqual(errors, ['写入失败'])
    onMessage({ data: { command: 'operationSuccess', data: 'addStockTradeRecord' } })
    assert.equal(instance.tradeFormVisible, false)
  }
})
