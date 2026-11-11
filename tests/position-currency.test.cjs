const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { getPositionCny, getStockCurrency } = require('../out/utils/position-currency')

test('market value converts before rounding; negative cost and fallback prices remain valid', () => {
  const item = { region: 'HK', position: { cost: -2, shares: 1000 }, quote: { currency: 'HKD', current: 0.1, lastClose: 0.2 } }
  assert.equal(getPositionCny(item, 3).marketValue, 33.33)
  assert.equal(getPositionCny(item, 2).cost, -1)
  item.quote.current = 0
  assert.equal(getPositionCny(item, 2).current, 0.1)
  assert.equal(getPositionCny(item, 2).marketValue, 100)
  for (const rate of [0, -1, NaN, Infinity]) assert.equal(getPositionCny(item, rate), undefined)
  assert.equal(getStockCurrency({ region: 'US', quote: {} }), 'USD')
  assert.equal(getStockCurrency({ region: 'UNKNOWN', quote: {} }), '')
})

test('every monetary quote field is converted while raw quotes and quantities remain intact', () => {
  const quote = { current: 12, lastClose: 10, chg: 2, amount: 12345, high: 14, low: 9,
    open: 11, marketCapital: 1000000, floatMarketCapital: 800000, volume: 1000, percent: 20 }
  const item = { position: { cost: 10, shares: 100 }, quote }
  const converted = getPositionCny(item, 2)
  assert.deepEqual(converted, {
    currency: 'CNY', current: 6, cost: 5, marketValue: 600, lastClose: 5, chg: 1, amount: 6172.5,
    high: 7, low: 4.5, open: 5.5, marketCapital: 500000, floatMarketCapital: 400000
  })
  assert.equal(item.quote.current, 12)
  assert.equal(item.quote.amount, 12345)
  assert.equal(item.quote.volume, 1000)
  assert.equal(item.quote.percent, 20)
})

test('status bar uses CNY totals and toggles monthly profit without new stock data', () => {
  let onStocks
  const items = []
  const config = {}
  const stockManager = {
    onDidChangeStockList: callback => { onStocks = callback; return { dispose() {} } },
    getMonthlyProfit: () => -123.45, isProfitSettled: () => true,
    getSettlementStatus: () => '', getRefreshStatus: () => ''
  }
  const mocks = {
    vscode: { StatusBarAlignment: { Left: 1 }, window: { createStatusBarItem: () => {
      const item = { show() {}, dispose() {} }; items.push(item); return item
    } } },
    './utils/config-manger': { getInstance: () => ({ getConfig: (key, fallback) => config[key] ?? fallback }) },
    './utils/stock-manager': { getInstance: () => stockManager }
  }
  const filename = require.resolve('../out/status-bar')
  delete require.cache[filename]
  const original = Module._load
  Module._load = function (id, ...args) { return mocks[id] ?? original.call(this, id, ...args) }
  let manager
  try { manager = require(filename).StatusBarManager.getInstance() } finally { Module._load = original }
  const stocks = [1200, 600, 9600].map((value, index) => ({
    name: ['A股', '港股', '美股'][index], region: ['CN', 'HK', 'US'][index],
    position: { shares: 100, cost: 10 }, quote: { current: 12, timestamp: Date.now() },
    positionCny: { currency: 'CNY', current: value / 100, cost: 10, marketValue: value },
    profit: { totalProfit: value / 6, todayProfit: value / 6, totalProfitRate: 20, todayProfitRate: 20 }
  }))
  onStocks(stocks)
  assert.equal(items[0].text, '💰 1900 | -123.45 | 1900')
  assert.match(items[0].tooltip, /总市值: 11400/)
  assert.match(items[0].tooltip, /持仓盈亏: 1900 \(16\.67%\)/)
  assert.match(items[0].tooltip, /当月盈亏: -123\.45 \(-1\.08%\)/)
  const visibleTooltip = items[0].tooltip

  config.showMonthlyProfit = false
  manager.refresh()
  assert.equal(items[0].text, '💰 1900 | 1900')
  assert.doesNotMatch(items[0].tooltip, /当月盈亏|-123\.45|-1\.08%/)
  assert.match(items[0].tooltip, /总市值: 11400/)
  assert.match(items[0].tooltip, /持仓盈亏: 1900 \(16\.67%\)/)
  assert.match(items[0].tooltip, /当日盈亏: 1900 \(16\.67%\)/)

  config.showMonthlyProfit = true
  manager.refresh()
  assert.equal(items[0].text, '💰 1900 | -123.45 | 1900')
  assert.equal(items[0].tooltip, visibleTooltip)

  onStocks([...stocks, { name: '缺汇率', position: { shares: 10 }, quote: {}, region: 'HK' }])
  assert.match(items[0].tooltip, /总市值: 11400/)
  assert.match(items[0].tooltip, /持仓盈亏: 1900 \(16\.67%\)/)
  manager.dispose()
})
