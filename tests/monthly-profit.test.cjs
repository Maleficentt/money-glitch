const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { MonthlyProfitLedger } = require('../out/utils/monthly-profit')
const { SharedJsonStorage } = require('../out/utils/shared-json-storage')

const close = Date.parse('2026-11-11T07:05:00Z')
function fixture(seed = {}, initial = 0) {
  const values = structuredClone(seed)
  const state = { now: close, configured: initial, fail: false, writes: 0 }
  const storage = {
    get: key => structuredClone(values[key]),
    update: async (key, value) => { values[key] = structuredClone(value) }
  }
  const create = () => new MonthlyProfitLedger(storage, () => ({ value: state.configured, revision: state.revision }), async (value, revision) => {
    state.writes++
    if (state.fail) throw new Error('settings unavailable')
    state.configured = value
    state.revision = revision
  }, () => state.now)
  return { state, storage, create, ledger: create() }
}
function stock(symbol, profit, timestamp = close, marketStatusId = 7) {
  return { symbol, region: 'CN', profit: { todayProfit: profit }, quote: { timestamp, marketStatusId } }
}
const positions = { SH600000: { shares: 100, cost: 10 }, SZ000001: { shares: 100, cost: 10 } }

test('partial close settles available positions, then fills gaps and replaces corrections', async () => {
  const { ledger, state } = fixture({}, 100)
  const a = stock('SH600000', 20)
  await ledger.settle([a], positions)
  assert.equal(state.configured, 120)
  assert.equal(ledger.status, '等待收盘行情：SZ000001')
  assert.equal(ledger.isSettled(stock('SZ000001', -5)), false)
  assert.equal(ledger.isSettled(a), true)
  await ledger.settle([a, stock('SZ000001', -5)], positions)
  await ledger.settle([a, stock('SZ000001', -5)], positions)
  assert.equal(state.configured, 115)
  await ledger.settle([stock('SH600000', 30), stock('SZ000001', -5)], positions)
  assert.equal(state.configured, 125)
})

test('intraday, stale and invalid quotes are not booked', async () => {
  const { ledger, state } = fixture()
  await ledger.settle([stock('SH600000', 20, close, 5), stock('SZ000001', 30, close - 86400000)], positions)
  assert.equal(state.configured, 0)
  await ledger.settle([stock('SH600000', NaN), stock('SZ000001', 3, NaN)], positions)
  assert.equal(state.configured, 0)
})

test('failed setting write recovers after restart without duplicate profit', async () => {
  const f = fixture({}, 100)
  f.state.fail = true
  await assert.rejects(f.ledger.settle([stock('SH600000', 20)], positions))
  f.state.fail = false
  const restarted = f.create()
  await restarted.settle([stock('SH600000', 20)], positions)
  assert.equal(f.state.configured, 120)
  assert.equal(restarted.getMonthlyProfit(), 120)
})

test('failed ledger write never publishes an unrecorded amount', async () => {
  const f = fixture({}, 100)
  const update = f.storage.update
  f.storage.update = async () => { throw new Error('storage unavailable') }
  await assert.rejects(f.ledger.settle([stock('SH600000', 20)], positions))
  assert.equal(f.state.configured, 100)
  assert.equal(f.ledger.getMonthlyProfit(), 100)
  f.storage.update = update
  await f.ledger.settle([stock('SH600000', 20)], positions)
  assert.equal(f.state.configured, 120)
})

test('new month displays zero before close and preserves history', async () => {
  const f = fixture({}, 100)
  await f.ledger.settle([stock('SH600000', 20)], positions)
  f.state.now = Date.parse('2026-12-01T01:00:00Z')
  assert.equal(f.ledger.getMonthlyProfit(), 0)
  await f.ledger.settle([], {})
  assert.equal(f.state.configured, 0)
  assert.equal(f.storage.get('monthlyProfitLedger').months['2026-11'].days['2026-11-11'].stocks.SH600000, 20)
})

test('manual daily total replaces auto entry and backfills a missed day', async () => {
  const f = fixture()
  await f.ledger.settle([stock('SH600000', 20)], positions)
  await f.ledger.correctDay('2026-11-11', 12)
  await f.ledger.correctDay('2026-11-10', -2)
  await f.ledger.settle([stock('SH600000', 999)], positions)
  assert.equal(f.state.configured, 10)
  assert.equal(f.ledger.isSettled(stock('SZ000001', 100)), true)
  await assert.rejects(f.ledger.correctDay('2026-02-30', 1))
  await assert.rejects(f.ledger.correctDay('2026-11-12', 1))
  await assert.rejects(f.ledger.correctDay('2026-11-10', Infinity))
})

test('legacy settled total migrates without booking that day twice', async () => {
  const f = fixture({ monthlyProfitSettlement: { date: '2026-11-11', value: 120 } }, 120)
  await f.ledger.settle([stock('SH600000', 20)], positions)
  assert.equal(f.state.configured, 120)
  assert.equal(f.ledger.isSettled(stock('SH600000', 20)), true)
  await assert.rejects(f.ledger.correctDay('2026-11-10', 1), /旧版/)
})

test('manual monthly setting changes adjust baseline only once', async () => {
  const f = fixture({}, 100)
  await f.ledger.settle([stock('SH600000', 20)], positions)
  f.state.configured = 200
  assert.equal(f.ledger.getMonthlyProfit(), 200)
  await f.ledger.settle([stock('SH600000', 20)], positions)
  await f.ledger.settle([stock('SH600000', 20)], positions)
  assert.equal(f.state.configured, 200)
  await f.ledger.settle([stock('SH600000', 25)], positions)
  assert.equal(f.state.configured, 205)
})

test('overlapping settlements are serialized and remain idempotent', async () => {
  const f = fixture()
  await Promise.all([
    f.ledger.settle([stock('SH600000', 20)], positions),
    f.ledger.settle([stock('SH600000', 20), stock('SZ000001', 5)], positions)
  ])
  assert.equal(f.state.configured, 25)
})

// Each window has its own Memento cache and configuration snapshot. Only the file
// and the global settings represent shared state, as in separate extension hosts.
async function multiWindowFixture(t, initial = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'money-glitch-monthly-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  })
  const state = { configuration: { value: initial }, now: close, writes: 0 }
  const windows = []
  const broadcast = () => {
    for (const window of windows) if (!window.lag) window.sync()
  }
  const create = () => {
    const cached = {}
    const shared = new SharedJsonStorage(directory)
    const window = {
      snapshot: structuredClone(state.configuration), lag: false, fail: undefined, shared,
      sync() { this.snapshot = structuredClone(state.configuration) }
    }
    const storage = {
      get: key => structuredClone(cached[key]),
      update: async (key, value) => { cached[key] = structuredClone(value) }
    }
    window.ledger = new MonthlyProfitLedger(storage, () => structuredClone(window.snapshot), async (value, revision) => {
      state.writes++
      if (window.fail === 'before-value') throw new Error('settings unavailable')
      state.configuration.value = value
      broadcast()
      if (window.fail === 'after-value') throw new Error('revision write failed')
      state.configuration.revision = revision
      broadcast()
      window.sync()
      if (window.fail === 'after-revision') throw new Error('extension host stopped')
    }, () => state.now, shared)
    windows.push(window)
    return window
  }
  const edit = value => {
    state.configuration.value = value
    broadcast()
  }
  return { state, create, edit, shared: new SharedJsonStorage(directory) }
}

test('independent windows settle the same closing quotes only once and refresh their read views', async t => {
  const f = await multiWindowFixture(t, 100)
  const a = f.create()
  const b = f.create()
  const quotes = [stock('SH600000', 20), stock('SZ000001', 5)]
  await Promise.all([a.ledger.settle(quotes, positions), b.ledger.settle(quotes, positions)])
  assert.equal(f.state.configuration.value, 125)
  assert.equal(a.ledger.getMonthlyProfit(), 125)
  assert.equal(b.ledger.getMonthlyProfit(), 125)
  assert.equal(b.ledger.isSettled(quotes[0]), true)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 100)
  await Promise.all([a.ledger.settle(quotes, positions), b.ledger.settle(quotes, positions)])
  assert.equal(f.state.configuration.value, 125)
})

test('independent windows merge partial closes and replace symbol corrections without losing other symbols', async t => {
  const f = await multiWindowFixture(t, 100)
  const a = f.create()
  const b = f.create()
  await Promise.all([
    a.ledger.settle([stock('SH600000', 20)], positions),
    b.ledger.settle([stock('SZ000001', -5)], positions)
  ])
  assert.equal(f.state.configuration.value, 115)
  await Promise.all([
    a.ledger.settle([stock('SH600000', 25)], positions),
    b.ledger.settle([stock('SZ000001', -7)], positions)
  ])
  assert.equal(f.state.configuration.value, 118)
  assert.deepEqual(f.shared.read().months['2026-11'].days['2026-11-11'].stocks, { SH600000: 25, SZ000001: -7 })
})

test('manual monthly edits are applied once across windows, including a reset to an earlier automatic value', async t => {
  const f = await multiWindowFixture(t, 100)
  const a = f.create()
  const b = f.create()
  const quotes = [stock('SH600000', 20)]
  await a.ledger.settle(quotes, positions)
  const oldAutomaticValue = f.state.configuration.value
  f.edit(200)
  assert.equal(a.ledger.getMonthlyProfit(), 200)
  assert.equal(b.ledger.getMonthlyProfit(), 200)
  await Promise.all([a.ledger.settle(quotes, positions), b.ledger.settle(quotes, positions)])
  assert.equal(f.state.configuration.value, 200)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 180)
  f.edit(oldAutomaticValue)
  assert.equal(b.ledger.getMonthlyProfit(), 120)
  await Promise.all([a.ledger.settle(quotes, positions), b.ledger.settle(quotes, positions)])
  assert.equal(f.state.configuration.value, 120)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 100)
})

test('a daily manual correction survives settlement from another window with stale local state', async t => {
  const f = await multiWindowFixture(t)
  const a = f.create()
  const b = f.create()
  await a.ledger.settle([stock('SH600000', 20)], positions)
  a.lag = true
  await b.ledger.correctDay('2026-11-11', 12)
  assert.equal(a.ledger.getMonthlyProfit(), 12)
  assert.equal(a.ledger.isSettled(stock('SZ000001', 999)), true)
  await a.ledger.settle([stock('SH600000', 999)], positions)
  assert.equal(f.state.configuration.value, 12)
  await b.ledger.correctDay('2026-11-10', -2)
  await a.ledger.settle([stock('SH600000', 999)], positions)
  assert.equal(f.state.configuration.value, 10)
})

test('a manual edit cancelled by a quote correction still advances the publication revision', async t => {
  const f = await multiWindowFixture(t)
  const a = f.create()
  const b = f.create()
  await a.ledger.settle([stock('SH600000', 100)], positions)
  const previousRevision = f.state.configuration.revision
  f.edit(120)
  await a.ledger.settle([stock('SH600000', 80)], positions)
  assert.equal(f.state.configuration.value, 100)
  assert.notEqual(f.state.configuration.revision, previousRevision)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 20)
  await b.ledger.settle([stock('SH600000', 80)], positions)
  assert.equal(f.state.configuration.value, 100)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 20)
})

test('delayed configuration snapshots and an automatic ABA value sequence cannot become manual adjustments', async t => {
  const f = await multiWindowFixture(t)
  const a = f.create()
  const b = f.create()
  b.lag = true
  await a.ledger.settle([], {})
  const firstZero = structuredClone(f.state.configuration)
  await a.ledger.settle([stock('SH600000', 100)], positions)
  const intermediate = structuredClone(f.state.configuration)
  await a.ledger.settle([stock('SH600000', 0)], positions)
  assert.equal(f.state.configuration.value, 0)
  assert.notEqual(f.state.configuration.revision, firstZero.revision)
  assert.equal(b.ledger.getMonthlyProfit(), 0)
  for (const snapshot of [intermediate, firstZero]) {
    b.snapshot = snapshot
    assert.equal(b.ledger.getMonthlyProfit(), 0)
    await b.ledger.settle([stock('SH600000', 0)], positions)
    assert.equal(f.state.configuration.value, 0)
    assert.equal(f.shared.read().months['2026-11'].openingBalance, 0)
  }
  b.lag = false
  b.sync()
  f.edit(100)
  await b.ledger.settle([stock('SH600000', 0)], positions)
  assert.equal(f.state.configuration.value, 100)
  assert.equal(a.ledger.getMonthlyProfit(), 100)
})

for (const stage of ['before-value', 'after-value', 'after-revision']) {
  test(`another window recovers a journal interrupted ${stage} without counting profit again`, async t => {
    const f = await multiWindowFixture(t, 100)
    const a = f.create()
    const observer = f.create()
    a.fail = stage
    await assert.rejects(a.ledger.settle([stock('SH600000', 20)], positions))
    assert.ok(f.shared.read().pending)
    assert.equal(observer.ledger.getMonthlyProfit(), 120)
    assert.equal(observer.ledger.isSettled(stock('SH600000', 20)), true)
    const restarted = f.create()
    await restarted.ledger.settle([stock('SH600000', 20)], positions)
    assert.equal(f.state.configuration.value, 120)
    assert.equal(restarted.ledger.getMonthlyProfit(), 120)
    assert.equal(f.shared.read().pending, undefined)
    assert.equal(f.shared.read().months['2026-11'].openingBalance, 100)
    a.fail = undefined
    await a.ledger.settle([stock('SH600000', 20)], positions)
    assert.equal(f.state.configuration.value, 120)
  })
}

test('a manual edit after successful configuration publication survives a failed journal finalization', async t => {
  const f = await multiWindowFixture(t, 100)
  const a = f.create()
  const b = f.create()
  const write = a.shared.write.bind(a.shared)
  let failFinalization = true
  a.shared.write = async value => {
    if (!value.pending && failFinalization) {
      failFinalization = false
      throw new Error('journal finalization unavailable')
    }
    await write(value)
  }
  const quotes = [stock('SH600000', 20)]
  await assert.rejects(a.ledger.settle(quotes, positions), /journal finalization/)
  assert.equal(f.state.configuration.value, 120)
  assert.ok(f.shared.read().pending)
  f.edit(200)
  await b.ledger.settle(quotes, positions)
  assert.equal(f.state.configuration.value, 200)
  assert.equal(f.shared.read().months['2026-11'].openingBalance, 180)
  assert.equal(f.shared.read().pending, undefined)
  await a.ledger.settle(quotes, positions)
  assert.equal(f.state.configuration.value, 200)
})
