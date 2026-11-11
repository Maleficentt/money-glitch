const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function load(relative, mocks) {
  const filename = require.resolve(relative)
  delete require.cache[filename]
  const original = Module._load
  Module._load = function (id, ...args) {
    return Object.hasOwn(mocks, id) ? mocks[id] : original.call(this, id, ...args)
  }
  try { return require(filename) } finally { Module._load = original }
}

class EventEmitter {
  calls = []
  event = () => ({ dispose() {} })
  fire(value) { this.calls.push(value) }
  dispose() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function timers(run) {
  const original = { setTimeout, clearTimeout, error: console.error }
  const scheduled = new Map()
  let count = 0
  global.setTimeout = (callback, delay) => {
    const id = ++count
    scheduled.set(id, { callback, delay })
    return id
  }
  global.clearTimeout = id => scheduled.delete(id)
  console.error = () => {}
  try { await run(scheduled) } finally {
    global.setTimeout = original.setTimeout
    global.clearTimeout = original.clearTimeout
    console.error = original.error
  }
}
const stock = { symbol: 'SH600000', region: 'CN', quote: { marketStatusId: 7 } }
function manager(kind, service, positions = {}) {
  const config = {
    getStockSymbols: () => ['SH600000'], getIndexSymbols: () => ['SH600000'],
    getPosition: () => positions
  }
  const mocks = {
    vscode: { EventEmitter }, './config-manger': { getInstance: () => config },
    './data-service': { getMinuteData: async () => [], ...service }
  }
  const instance = load(`../out/utils/${kind}-manager`, mocks).default.getInstance()
  if (kind === 'stock') instance.formatStockList = async () => {}
  return instance
}

for (const kind of ['stock', 'index']) {
  test(`${kind}: full refresh retries all existing symbols after a plain Error`, async () => timers(async scheduled => {
    const calls = []
    const instance = manager(kind, { getStockData: async symbols => {
      calls.push(symbols)
      if (calls.length === 1) throw new Error('Network unavailable')
      return [stock]
    } })
    instance.stockList = [stock]
    instance.getStockData(true)
    await flush()
    const retry = [...scheduled.values()][0]
    assert.equal(retry.delay, 1000)
    retry.callback()
    await flush()
    assert.deepEqual(calls, [['SH600000'], ['SH600000']])
    instance.dispose()
    assert.equal(scheduled.size, 0)
  }))

  test(`${kind}: superseded or disposed requests cannot replace data or revive timers`, async () => timers(async scheduled => {
    const first = deferred()
    const second = deferred()
    let count = 0
    const instance = manager(kind, { getStockData: () => ++count === 1 ? first.promise : second.promise })
    instance.getStockData(true)
    instance.getStockData(true)
    first.resolve([stock])
    await flush()
    assert.deepEqual(instance.getStockList(), [])
    assert.equal(scheduled.size, 0)
    instance.dispose()
    second.resolve([stock])
    await flush()
    assert.deepEqual(instance.getStockList(), [])
    assert.equal(scheduled.size, 0)
  }))
}

test('held stocks outside watchlist are requested for profit accounting', async () => timers(async () => {
  let requested
  const instance = manager('stock', { getStockData: async symbols => { requested = symbols; return [] } }, {
    SZ000001: { shares: 100, cost: 10 }, BJ430047: { shares: 0, cost: 0 }
  })
  instance.getStockData(true)
  await flush()
  assert.deepEqual(requested, ['SH600000', 'SZ000001'])
  instance.dispose()
}))

test('an empty portfolio still recalculates settlement and retains periodic refresh', async () => timers(async scheduled => {
  let calculations = 0
  const instance = manager('stock', { getStockData: async () => { assert.fail('No network request needed') } })
  instance.configManager.getStockSymbols = () => []
  instance.formatStockList = async () => { calculations++ }
  instance.getStockData(true)
  await flush()
  assert.equal(calculations, 1)
  assert.deepEqual(instance.getStockList(), [])
  assert.equal([...scheduled.values()][0].delay, 600000)
  instance.dispose()
}))

test('incremental refresh with no new symbols restarts market polling', async () => timers(async scheduled => {
  let calculations = 0
  const instance = manager('stock', { getStockData: async () => { assert.fail('All symbols already loaded') } })
  instance.stockList = [stock]
  instance.formatStockList = async () => { calculations++ }
  instance.getStockData()
  await flush()
  assert.equal(calculations, 1)
  assert.equal(scheduled.size, 2)
  instance.dispose()
}))

test('cancellation while calculating profits does not schedule another poll', async () => timers(async scheduled => {
  const calculation = deferred()
  const instance = manager('stock', { getStockData: async () => [stock] })
  instance.formatStockList = () => calculation.promise
  instance.getStockData(true)
  await flush()
  instance.dispose()
  calculation.resolve()
  await flush()
  assert.equal(scheduled.size, 0)
  assert.equal(instance._onDidChangeStockList.calls.length, 0)
}))

test('index minute requests cannot recreate timers after disposal; refresh can restart', async () => timers(async scheduled => {
  const minute = deferred()
  const instance = manager('index', { getStockData: async () => [stock], getMinuteData: () => minute.promise })
  instance.refresh()
  await flush()
  instance.dispose()
  minute.reject(new Error('Connection closed'))
  await flush()
  assert.equal(scheduled.size, 0)
  instance.refresh()
  await flush()
  assert.ok(scheduled.size > 0)
  instance.dispose()
}))

test('exchange rates deduplicate concurrent requests, cache old market dates by TTL and flag fallback', async () => {
  const originalNow = Date.now
  let now = Date.parse('2026-11-14T09:00:00Z')
  Date.now = () => now
  const pending = deferred()
  const rates = ['USD', 'HKD'].map(quote => ({ base: 'CNY', quote, date: '2026-11-13', rate: 1 }))
  let calls = 0
  const api = load('../out/utils/data-service', { axios: {
    get: (url, config) => {
      assert.equal(config.timeout, 10000)
      calls++
      return calls === 1 ? pending.promise : Promise.reject(new Error('Offline'))
    }, isAxiosError: () => false
  } })
  try {
    const a = api.getExchangeRates()
    const b = api.getExchangeRates()
    assert.equal(a, b)
    pending.resolve({ data: rates })
    assert.deepEqual(await a, rates)
    assert.equal(api.getExchangeRateStatus().stale, false)
    await api.getExchangeRates()
    assert.equal(calls, 1)
    now += 6 * 60 * 60 * 1000 + 1
    assert.deepEqual(await api.getExchangeRates(), rates)
    assert.equal(api.getExchangeRateStatus().stale, true)
    assert.equal(api.getExchangeRateStatus().error, 'Offline')
    await api.getExchangeRates()
    assert.equal(calls, 2)
  } finally { Date.now = originalNow }
})

test('exchange failure without cached rates rejects and throttles retries', async () => {
  let calls = 0
  const api = load('../out/utils/data-service', { axios: {
    get: async () => { calls++; throw new Error('Offline') }, isAxiosError: () => false
  } })
  await assert.rejects(api.getExchangeRates(), /Offline/)
  await assert.rejects(api.getExchangeRates(), /Offline/)
  assert.equal(calls, 1)
  assert.equal(api.getExchangeRateStatus().stale, true)
})

test('authentication requests deduplicate and expired tokens are refreshed on retry', async () => {
  let cookies = 0
  let fail = false
  const api = load('../out/utils/data-service', { axios: {
    isAxiosError: error => error.isAxiosError,
    get: async (url, config) => {
      assert.equal(config.timeout, 10000)
      if (url.endsWith('/hq')) {
        cookies++
        return { headers: { 'set-cookie': ['xq_a_token=abc; Path=/', 'u=123; Path=/'] } }
      }
      if (fail) throw { isAxiosError: true, response: { status: 401 } }
      return url.includes('/batch/') ? { data: { data: { items: [] } } } : { data: { data: [] } }
    }
  } })
  await Promise.all([api.getStockData(['SH600000']), api.getRealtimeQuote(['SH600000'])])
  assert.equal(cookies, 1)
  fail = true
  await assert.rejects(api.getStockData(['SH600000']))
  fail = false
  await api.getStockData(['SH600000'])
  assert.equal(cookies, 2)
})
