const test = require('node:test')
const assert = require('node:assert/strict')
const Decimal = require('decimal.js')
const { getTradeFees, getHongKongConnectFees } = require('../out/utils/trade-validation')

const stock = (overrides = {}) => ({ region: 'HK', exchange: 'HK', type: 30, quote: { currency: 'HKD' }, ...overrides })
const trade = (type = 1, overrides = {}) => ({ type, price: 10, shares: 1000, broker: 'test', ...overrides })
const broker = (hkStockConnect, overrides = {}) => ({
  commissionRate: 0, stockMinCommission: 0, etfMinCommission: 0,
  stampTaxRate: 0.0005, transferRate: { value: 0.00001 },
  ...(hkStockConnect === undefined ? {} : { hkStockConnect }), ...overrides
})
const numbers = fees => Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, value.toNumber()]))

test('HK stock buys and sells charge each statutory fee separately at current southbound rates', () => {
  for (const side of [1, -1]) {
    const fees = getHongKongConnectFees(stock(), trade(side), broker())
    assert.deepEqual(numbers(fees), {
      commission: 0, stampTax: 10, tradingFee: 0.57, transactionLevy: 0.27,
      afrcLevy: 0.02, settlementFee: 0.42, total: 11.28
    })
    assert.equal(getTradeFees(stock(), trade(side), { test: broker() }).toNumber(), 11.28)
  }
})

test('stamp duty always rounds up to dollars and regulatory fees round half-up independently', () => {
  const fees = getHongKongConnectFees(stock(), trade(1, { price: 100.01, shares: 100 }), broker())
  assert.equal(fees.stampTax.toNumber(), 11)
  assert.equal(fees.total.toNumber(), 12.28)
  assert.equal(getHongKongConnectFees(stock(), trade(1, { price: 1, shares: 1 }), broker()).stampTax.toNumber(), 1)
  // Decimal's ambient rounding setting must not change the exchange's per-fee rules.
  const original = Decimal.rounding
  try {
    Decimal.set({ rounding: Decimal.ROUND_DOWN })
    const rounded = getHongKongConnectFees(stock(), trade(), broker())
    assert.equal(rounded.tradingFee.toNumber(), 0.57)
    assert.equal(rounded.afrcLevy.toNumber(), 0.02)
    assert.equal(rounded.total.toNumber(), 11.28)
  } finally { Decimal.set({ rounding: original }) }
})

test('stock-connect settlement fees have neither the old HK$2 minimum nor HK$100 cap', () => {
  assert.equal(getHongKongConnectFees(stock(), trade(1, { price: 10, shares: 1 }), broker()).settlementFee.toNumber(), 0)
  assert.equal(getHongKongConnectFees(stock(), trade(1, { price: 1000, shares: 3000 }), broker()).settlementFee.toNumber(), 126)
})

test('legacy brokers inherit commission and minimum while HK overrides respect explicit zeros', () => {
  const legacy = broker(undefined, { commissionRate: 0.0003, stockMinCommission: 5 })
  assert.equal(getTradeFees(stock(), trade(), { test: legacy }).toNumber(), 16.28)
  const custom = broker({ commissionRate: 0.001, minCommission: 2 }, { commissionRate: 0.0003, stockMinCommission: 5 })
  assert.equal(getTradeFees(stock(), trade(), { test: custom }).toNumber(), 21.28)
  const zero = broker({ commissionRate: 0, minCommission: 0 }, { commissionRate: 0.003, stockMinCommission: 100 })
  assert.equal(getTradeFees(stock(), trade(), { test: zero }).toNumber(), 11.28)
  const allZero = broker({ commissionRate: 0, minCommission: 0, stampTaxRate: 0, tradingFeeRate: 0,
    transactionLevyRate: 0, afrcLevyRate: 0, settlementFeeRate: 0 })
  assert.equal(getTradeFees(stock(), trade(), { test: allZero }).toNumber(), 0)
})

test('CNY minimum commissions are converted to HKD before taking the commission maximum', () => {
  const config = broker({ commissionRate: 0.0003, minCommission: 5, minimumCommissionCurrency: 'CNY' })
  const fees = getHongKongConnectFees(stock(), trade(), config, 1.1)
  assert.equal(fees.commission.toNumber(), 5.5)
  assert.equal(fees.total.toNumber(), 16.78)
  assert.equal(getTradeFees(stock(), trade(), { test: config }, 1.1).toNumber(), 16.78)
  const halfCent = broker({ commissionRate: 0, minCommission: 1.005, minimumCommissionCurrency: 'CNY' })
  assert.equal(getHongKongConnectFees(stock(), trade(), halfCent, 1).commission.toNumber(), 1.01)
  for (const rate of [undefined, 0, -1, Infinity, NaN]) {
    assert.throws(() => getTradeFees(stock(), trade(), { test: config }, rate), /汇率/)
  }
})

test('HK ETFs waive stamp duty on both sides but retain other southbound levies', () => {
  const etf = stock({ type: 13 })
  const config = broker(undefined, { stockMinCommission: 5, etfMinCommission: 2 })
  for (const side of [1, -1]) {
    const fees = getHongKongConnectFees(etf, trade(side), config)
    assert.equal(fees.stampTax.toNumber(), 0)
    assert.equal(fees.commission.toNumber(), 2)
    assert.equal(fees.settlementFee.toNumber(), 0.42)
    assert.equal(fees.total.toNumber(), 3.28)
  }
})

test('invalid HK fee configuration and non-HKD transactions are rejected', () => {
  const keys = ['commissionRate', 'minCommission', 'stampTaxRate', 'tradingFeeRate', 'transactionLevyRate', 'afrcLevyRate', 'settlementFeeRate']
  for (const key of keys) {
    for (const value of [-1, NaN, Infinity]) {
      assert.throws(() => getTradeFees(stock(), trade(), { test: broker({ [key]: value }) }), /有限数字/)
    }
  }
  assert.throws(() => getTradeFees(stock(), trade(), { test: broker({ minimumCommissionCurrency: 'USD' }) }), /HKD.*CNY/)
  assert.throws(() => getTradeFees(stock({ quote: { currency: 'USD' } }), trade(), { test: broker() }), /港币/)
  for (const malformed of [null, false, []]) {
    assert.throws(() => getTradeFees(stock(), trade(), { test: broker(malformed) }), /配置无效/)
  }
})

test('market dispatch supports HK identity, preserves A-share fees and keeps no-broker trades fee-free', () => {
  const legacy = broker(undefined, { commissionRate: 0.0002354, stockMinCommission: 5 })
  assert.equal(getTradeFees(stock({ region: 'OTHER' }), trade(), { test: legacy }).toNumber(), 16.28)
  assert.equal(getTradeFees(stock({ exchange: 'OTHER' }), trade(), { test: legacy }).toNumber(), 16.28)
  const cn = stock({ region: 'CN', exchange: 'SH', type: 11, quote: { currency: 'CNY' } })
  assert.equal(getTradeFees(cn, trade(1, { shares: 100 }), { test: legacy }).toNumber(), 5.01)
  assert.equal(getTradeFees(cn, trade(-1, { shares: 100 }), { test: legacy }).toNumber(), 5.51)
  assert.equal(getTradeFees(stock(), trade(1, { broker: '' }), {}).toNumber(), 0)
  assert.throws(() => getTradeFees(stock(), trade(), {}), /券商/)
})
