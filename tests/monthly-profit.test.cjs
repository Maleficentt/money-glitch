const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MonthlyProfitLedger } = require('../out/utils/monthly-profit')

const close = Date.parse('2026-11-11T07:05:00Z')
function fixture(seed = {}, initial = 0) {
  const values = structuredClone(seed)
  const state = { now: close, configured: initial, fail: false, writes: 0 }
  const storage = {
    get: key => structuredClone(values[key]),
    update: async (key, value) => { values[key] = structuredClone(value) }
  }
  const create = () => new MonthlyProfitLedger(storage, () => state.configured, async value => {
    state.writes++
    if (state.fail) throw new Error('settings unavailable')
    state.configured = value
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
  assert.equal(ledger.status, '等待收盘行情')
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
