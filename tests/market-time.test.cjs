const test = require('node:test')
const assert = require('node:assert/strict')
const { getNextMarketDelay, getMarketOpenTime, getMarketDate, retryDelay } = require('../out/utils/market-time')

function next(region, status, time) {
  const now = Date.parse(time)
  return new Date(now + getNextMarketDelay(region, status, now)).toISOString()
}

test('US close remains in the future across Shanghai midnight, with DST', () => {
  assert.equal(next('US', 5, '2026-07-08T14:00:00Z'), '2026-07-08T20:00:01.000Z')
  assert.equal(next('US', 5, '2026-07-08T17:00:00Z'), '2026-07-08T20:00:01.000Z')
  assert.equal(next('US', 5, '2026-11-11T15:00:00Z'), '2026-11-11T21:00:01.000Z')
  assert.equal(new Date(getMarketOpenTime('US', Date.parse('2026-11-11T17:00:00Z'))).toISOString(), '2026-11-11T14:30:00.000Z')
  assert.equal(getMarketDate('US', Date.parse('2026-11-12T01:00:00+08:00')), '2026-11-11')
})

test('CN lunch and close use market local time, without inherited seconds', () => {
  assert.equal(next('CN', 5, '2026-11-11T11:29:37+08:00'), '2026-11-11T03:30:01.000Z')
  assert.equal(next('CN', 4, '2026-11-11T12:00:00+08:00'), '2026-11-11T05:00:01.000Z')
  assert.equal(next('CN', 5, '2026-11-11T14:59:55+08:00'), '2026-11-11T07:00:01.000Z')
  assert.equal(getMarketDate('CN', Date.parse('2026-11-11T20:00:00Z')), '2026-11-12')
})

test('closed markets skip weekends and use the offset of the next trading date', () => {
  assert.equal(next('CN', 7, '2026-11-13T16:00:00+08:00'), '2026-11-16T01:15:01.000Z')
  assert.equal(next('US', 7, '2026-03-06T22:00:00Z'), '2026-03-09T13:30:01.000Z')
})

test('late provider status cannot create a zero-delay loop', () => {
  assert.equal(getNextMarketDelay('CN', 5, Date.parse('2026-11-11T15:01:00+08:00')), 30000)
  assert.equal(getNextMarketDelay('US', 5, Date.parse('2026-11-11T12:00:00Z')), 30000)
  assert.equal(retryDelay(1), 1000)
  assert.equal(retryDelay(2), 2000)
  assert.equal(retryDelay(100), 60000)
})
