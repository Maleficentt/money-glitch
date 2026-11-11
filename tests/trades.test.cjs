const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

function fixture({ positions = {}, rates = [], rateError, stale = false, writeError = false } = {}) {
  const values = { position: structuredClone(positions), broker: {}, stockSymbols: [] }
  let rateCalls = 0
  let rejectNextWrite = writeError
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => values[key] ?? fallback,
      update: async (key, value) => {
        await new Promise(resolve => setImmediate(resolve))
        if (rejectNextWrite) { rejectNextWrite = false; throw Error('disk full') }
        values[key] = structuredClone(value)
      }
    }) }
  }
  const service = {
    getExchangeRates: async () => { rateCalls++; if (rateError) throw rateError; return rates },
    getExchangeRateStatus: () => ({ stale, fetchedAt: Date.now() })
  }
  const stockPath = path.resolve(__dirname, '../out/utils/stock-manager.js')
  const configPath = path.resolve(__dirname, '../out/utils/config-manger.js')
  delete require.cache[stockPath]
  delete require.cache[configPath]
  const original = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode
    if (request === './data-service') return service
    return original.call(this, request, parent, isMain)
  }
  let manager, config
  try {
    manager = require(stockPath).default.getInstance()
    config = require(configPath).default.getInstance()
  } finally { Module._load = original }
  return { manager, config, values, rateCalls: () => rateCalls }
}

const stock = (symbol = 'SH600000', currency = 'CNY') => ({
  symbol, type: 11, exchange: currency === 'CNY' ? 'SH' : 'HK', region: currency === 'CNY' ? 'CN' : 'HK',
  quote: { currency, current: 12, lastClose: 10, status: 1, marketStatusId: 5, timestamp: Date.now() }
})
const trade = (type, overrides = {}) => ({ type, price: 10, shares: 100, broker: '', ...overrides })

test('configured fees preserve minimum commission, rounding and ETF sell exemption', () => {
  const { getTradeFees } = require('../out/utils/trade-validation')
  const brokers = { test: {
    commissionRate: 0.0002354, stockMinCommission: 5, etfMinCommission: 0,
    stampTaxRate: 0.0005, transferRate: { value: 0.00001, SZ: 0 }
  } }
  assert.equal(getTradeFees(stock(), trade(1, { broker: 'test' }), brokers).toNumber(), 5.01)
  assert.equal(getTradeFees(stock(), trade(-1, { broker: 'test' }), brokers).toNumber(), 5.51)
  assert.equal(getTradeFees({ ...stock(), exchange: 'SZ' }, trade(1, { broker: 'test' }), brokers).toNumber(), 5)
  assert.equal(getTradeFees({ ...stock(), type: 13 }, trade(-1, { broker: 'test' }), brokers).toNumber(), 0.24)
  assert.throws(() => getTradeFees(stock(), trade(1, { broker: 'missing' }), brokers), /券商/)
})

test('no-broker buy and sell use zero fees and persist before resolving', async () => {
  const f = fixture()
  await f.manager.buyStock(stock(), trade(1))
  assert.equal(f.values.position.SH600000.cost, 10)
  assert.equal(f.values.position.SH600000.shares, 100)
  await f.manager.sellStock(stock(), trade(-1, { price: 12 }))
  assert.equal(f.values.position.SH600000.shares, 0)
  assert.equal(f.values.position.SH600000.totalProfit, 200)
  assert.equal(f.rateCalls(), 0)
})

test('invalid numeric input and overselling never mutate positions', async () => {
  const f = fixture({ positions: { SH600000: { cost: 10, shares: 100 } } })
  const before = structuredClone(f.values.position)
  for (const invalid of [{ price: Infinity }, { price: NaN }, { price: 0 }, { price: -1 },
    { shares: Infinity }, { shares: 0 }, { shares: -1 }, { shares: 1.5 }, { shares: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(f.manager.buyStock(stock(), trade(1, invalid)))
    await assert.rejects(f.manager.sellStock(stock(), trade(-1, invalid)))
  }
  await assert.rejects(f.manager.sellStock(stock(), trade(-1, { shares: 200 })), /不能超过/)
  assert.deepEqual(f.values.position, before)
})

test('concurrent transactions read the latest persisted position', async () => {
  const f = fixture()
  await Promise.all([
    f.manager.buyStock(stock(), trade(1)),
    f.manager.buyStock(stock(), trade(1, { price: 20 }))
  ])
  assert.equal(f.values.position.SH600000.shares, 200)
  assert.equal(f.values.position.SH600000.cost, 15)
  assert.equal(f.values.position.SH600000.tradeRecords.length, 2)
  const results = await Promise.allSettled([
    f.manager.sellStock(stock(), trade(-1, { shares: 150 })),
    f.manager.sellStock(stock(), trade(-1, { shares: 150 }))
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(f.values.position.SH600000.shares, 50)
})

test('failed persistence rejects and does not poison later transactions', async () => {
  const f = fixture({ writeError: true })
  await assert.rejects(f.manager.buyStock(stock(), trade(1)), /disk full/)
  assert.deepEqual(f.values.position, {})
  await f.manager.buyStock(stock(), trade(1))
  assert.equal(f.values.position.SH600000.shares, 100)
})

test('position edits reject invalid numbers and preserve existing trade history', async () => {
  const records = [trade(1)]
  const f = fixture({ positions: { SH600000: { cost: 10, shares: 100, tradeRecords: records } } })
  await assert.rejects(f.config.updatePosition({ symbol: 'SH600000', cost: NaN, shares: 100 }))
  await assert.rejects(f.config.updatePosition({ symbol: 'SH600000', cost: 10, shares: -1 }))
  await f.config.updatePosition({ symbol: 'SH600000', cost: -2, shares: 100 })
  assert.equal(f.values.position.SH600000.cost, -2)
  assert.deepEqual(f.values.position.SH600000.tradeRecords, records)
})

test('CN profit does not fetch exchange rates; missing foreign rates do not block CN', async () => {
  const f = fixture({ positions: { SH600000: { cost: 10, shares: 100 } }, rateError: Error('offline') })
  f.manager.stockList = [stock()]
  await f.manager.formatStockList()
  assert.equal(f.rateCalls(), 0)
  assert.equal(f.manager.getStockList()[0].profit.todayProfit, 200)
  f.values.position.HK00700 = { cost: 10, shares: 100 }
  f.manager.stockList = [stock(), { ...stock('HK00700', 'HKD'), profit: { todayProfit: 999 } }]
  await f.manager.formatStockList()
  assert.equal(f.manager.getStockList()[0].profit.todayProfit, 200)
  assert.equal(f.manager.getStockList()[1].profit, undefined)
})

test('stale foreign quote conversion is marked, and realized profit is converted only once', async () => {
  const f = fixture({ rates: [{ quote: 'HKD', rate: 2 }] })
  await f.manager.buyStock(stock('HK00700', 'HKD'), trade(1))
  await f.manager.sellStock(stock('HK00700', 'HKD'), trade(-1, { price: 12 }))
  assert.equal(f.values.position.HK00700.totalProfit, 100)
  f.manager.stockList = [stock('HK00700', 'HKD')]
  await f.manager.formatStockList()
  assert.equal(f.manager.getStockList()[0].profit.totalProfit, 100)
  await f.manager.buyStock(stock('HK00700', 'HKD'), trade(1))
  assert.equal(f.values.position.HK00700.cost, 8)
  const cached = fixture({ positions: { HK00700: { cost: 10, shares: 100 } }, rates: [{ quote: 'HKD', rate: 2 }], stale: true })
  cached.manager.stockList = [stock('HK00700', 'HKD')]
  await cached.manager.formatStockList()
  assert.equal(cached.manager.getStockList()[0].profit.todayProfit, 100)
  assert.equal(cached.manager.getStockList()[0].exchangeRateStale, true)
})
