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

function pageFixture(name) {
  const html = fs.readFileSync(path.resolve(__dirname, `../media/${name}.html`), 'utf8')
  let options
  const sent = []
  const sandbox = vm.createContext({ Vue: function (value) { options = value }, console, setTimeout })
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]).runInContext(sandbox)
  }
  const page = { ...options.data, vscode: { postMessage: message => sent.push(message) } }
  for (const [key, method] of Object.entries(options.methods)) page[key] = method.bind(page)
  return { page, html, sent, filters: options.filters }
}

function mixedHoldings() {
  return [
    ['SH600000', 'CN', 'CNY', 10, 9, 10, 9, 1000, 100],
    ['00700', 'HK', 'HKD', 20, 15, 16, 12, 1600, 400],
    ['AAPL', 'US', 'USD', 5, 4, 25, 20, 2500, 500]
  ].map(([symbol, region, currency, current, cost, cnyCurrent, cnyCost, marketValue, profit]) => ({
    ...stock(symbol, current), region,
    quote: { ...stock(symbol, current).quote, currency, high: current + 1, amount: 1234 },
    position: { shares: 100, cost },
    positionCny: { currency: 'CNY', current: cnyCurrent, cost: cnyCost, marketValue },
    profit: { totalProfit: profit, todayProfit: profit / 2, totalProfitRate: 10, todayProfitRate: 5 }
  }))
}

function populateHoldings(name, page, holdings) {
  if (name === 'position') page.initStockList(holdings)
  else page.init({ holdings, stocks: holdings })
}

test('both pages aggregate CN/HK/US holdings and weights in CNY without changing raw prices', () => {
  for (const name of ['position', 'selected']) {
    const { page, filters } = pageFixture(name)
    const holdings = mixedHoldings()
    const original = structuredClone(holdings)
    populateHoldings(name, page, holdings)
    assert.equal(page.totalMarketValue, 5100)
    assert.equal(page.valuationIncomplete, false)
    assert.equal(page.rateWarning, false)
    assert.equal(page.calculatePositionRate(1600), 31.37)
    assert.equal(page.calculatePositionRate(2500), 49.02)
    assert.equal(filters.formatMoney(0), '0.00')
    assert.equal(filters.formatMoney(1.234567), '1.2346')
    if (name === 'position') {
      assert.equal(page.totalProfit, 1000)
      assert.equal(page.todayProfit, 500)
      assert.equal(page.totalProfitRate, 19.61)
      assert.equal(page.stockList[1].marketValue, 1600)
    } else {
      assert.equal(page.stockList[1].quote.current, 20)
      const summary = page.getHoldSummary({ columns: [{ property: 'name' }, { property: 'positionCny.marketValue' }] })
      assert.equal(summary[1], '5,100.00')
    }
    assert.deepEqual(holdings, original)
  }
})

test('unavailable rates show unknown amounts and weights while keeping held stocks editable', () => {
  for (const name of ['position', 'selected']) {
    const { page, filters } = pageFixture(name)
    const holdings = mixedHoldings()
    delete holdings[1].positionCny
    delete holdings[1].profit
    populateHoldings(name, page, holdings)
    assert.equal(page.totalMarketValue, 3500)
    assert.equal(page.rateWarning, true)
    assert.equal(page.valuationIncomplete, true)
    assert.equal(page.calculatePositionRate(1000), undefined)
    assert.equal(filters.formatMoney(undefined), '--')
    assert.equal(filters.formatPercent(page.calculatePositionRate(undefined)), '--')
    const rows = name === 'position' ? page.stockList : page.holdList
    assert.equal(rows.length, 3)
    assert.equal(rows[1].positionCny, undefined)
    if (name === 'position') {
      assert.equal(rows[1].marketValue, undefined)
      assert.equal(rows[1].profit.totalProfit, '--')
      assert.equal(page.totalProfit, 600)
    }
    page.showHoldForm(rows[1])
    assert.equal(page.holdFormData.cost, 15)
    assert.equal(page.holdCurrency, 'HKD')
    populateHoldings(name, page, [holdings[1]])
    assert.equal(filters.formatMoney(page.totalMarketValue), '--')
    assert.equal(page.calculatePositionRate(0), undefined)
    populateHoldings(name, page, [])
    assert.equal(page.totalMarketValue, 0)
    assert.equal(page.rateWarning, false)
  }
})

test('stale usable CNY valuations remain visible with a warning', () => {
  for (const name of ['position', 'selected']) {
    const { page } = pageFixture(name)
    const holdings = mixedHoldings()
    holdings[2].exchangeRateStale = true
    populateHoldings(name, page, holdings)
    assert.equal(page.totalMarketValue, 5100)
    assert.equal(page.rateWarning, true)
    assert.equal(page.valuationIncomplete, false)
    assert.equal(page.calculatePositionRate(2500), 49.02)
  }
})

test('missing profit with valid CNY valuation does not become a complete zero return', () => {
  const { page, filters } = pageFixture('position')
  const holdings = mixedHoldings()
  delete holdings[1].profit
  page.initStockList(holdings)
  assert.equal(page.totalMarketValue, 5100)
  assert.equal(page.totalProfit, 600)
  assert.equal(page.stockList[1].profit.totalProfit, '--')
  assert.equal(page.profitIncomplete, true)
  assert.equal(page.rateWarning, true)
  assert.equal(page.valuationIncomplete, false)
  assert.equal(page.totalProfitRate, undefined)
  assert.equal(page.todayProfitRate, undefined)
  assert.equal(page.calculatePositionRate(1600), 31.37)
  page.initStockList([holdings[1]])
  assert.equal(page.totalMarketValue, 1600)
  assert.equal(filters.formatMoney(page.totalProfit), '--')
  assert.equal(filters.formatMoney(page.todayProfit), '--')
})

test('currency display never replaces native price or cost in edit submissions', () => {
  for (const name of ['position', 'selected']) {
    const { page, sent, html } = pageFixture(name)
    const holdings = mixedHoldings()
    const original = structuredClone(holdings)
    populateHoldings(name, page, holdings)
    const rows = name === 'position' ? page.stockList : page.holdList
    for (const row of rows) {
      page.mutationPending = false
      page.showHoldForm(row)
      assert.equal(page.holdCurrency, row.quote.currency)
      page.submitHoldForm()
      assert.equal(sent.at(-1).data.cost, row.position.cost)
      page.mutationPending = false
      page.showTradeForm(row, 1)
      assert.equal(page.tradeCurrency, row.quote.currency)
      page.submitTradeForm()
      assert.equal(sent.at(-1).data.tradeRecord.price, row.quote.current)
      assert.equal(sent.at(-1).data.stock.quote.current, row.quote.current)
    }
    assert.match(html, /成本（原币/)
    assert.match(html, /成交价（原币/)
    page.handlePosition()
    assert.equal(page.holdCurrency, '')
    page.handleTrade()
    assert.equal(page.tradeCurrency, '')
    assert.equal(page.selectedStock, null)
    assert.deepEqual(holdings, original)
  }
})

test('holding templates use CNY fields for every monetary column; watchlist keeps quote prices', () => {
  const { html: position } = pageFixture('position')
  const positionTable = position.slice(position.indexOf('<el-table ref="table"'), position.indexOf('</el-table>'))
  assert.doesNotMatch(positionTable, /row\.quote\.current|row\.position\.cost/)
  assert.match(positionTable, /row\.positionCny\.current/)
  assert.match(positionTable, /row\.positionCny\.cost/)
  const { html: selected } = pageFixture('selected')
  const start = selected.search(/<el-tab-pane\b[^>]*\bname="position"/)
  const heldTable = selected.slice(start, selected.indexOf('</el-tab-pane>', start))
  for (const field of ['current', 'chg', 'amount', 'high', 'low', 'marketCapital', 'floatMarketCapital', 'cost', 'marketValue']) {
    assert.match(heldTable, new RegExp(`row\\.positionCny\\.${field}`))
    assert.doesNotMatch(heldTable, new RegExp(`row\\.quote\\.${field}\\b`))
  }
  const watchlist = selected.slice(selected.indexOf('<el-tab-pane label="全部"'), start)
  assert.match(watchlist, /row\.quote\.current/)
  assert.match(watchlist, /row\.quote\.amount/)
})
