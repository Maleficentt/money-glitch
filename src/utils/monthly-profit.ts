import type { Memento } from 'vscode'
import Decimal from 'decimal.js'
import { Position, Stock } from './types'
import { getMarketDate } from './market-time'
import { randomUUID } from 'node:crypto'
import { SharedJsonStorage } from './shared-json-storage'

export interface MonthlyProfitConfiguration {
  value: number
  revision?: string
}

interface DailyProfit {
  stocks: Record<string, number>
  manualTotal?: number
}
interface MonthProfit {
  openingBalance: number
  days: Record<string, DailyProfit>
  legacyDate?: string
}
interface ProfitLedger {
  months: Record<string, MonthProfit>
  publishedMonth?: string
  publishedValue?: number
  publishedRevision?: string
  pending?: { month: string, value: number, revision?: string }
}

const KEY = 'monthlyProfitLedger'

/** The ledger is authoritative; settings are an idempotent projection of it. */
export class MonthlyProfitLedger {
  private ledger: ProfitLedger
  private queue: Promise<void> = Promise.resolve()
  status = ''

  constructor(
    private readonly storage: Memento,
    private readonly readConfiguration: () => MonthlyProfitConfiguration,
    private readonly writeValue: (value: number, revision: string) => PromiseLike<void>,
    private readonly now: () => number = Date.now,
    private readonly sharedStorage?: SharedJsonStorage<ProfitLedger>
  ) {
    const saved = sharedStorage?.read() ?? storage.get<ProfitLedger>(KEY)
    if (saved) {
      this.ledger = saved
    } else {
      const pending = storage.get<{ date: string, value: number }>('monthlyProfitPending')
      const legacy = pending ?? storage.get<{ date: string }>('monthlyProfitSettlement')
      const month = legacy?.date.slice(0, 7) ?? this.today().slice(0, 7)
      const value = pending?.value ?? readConfiguration().value
      this.ledger = {
        months: { [month]: { openingBalance: value, days: {}, legacyDate: legacy?.date } },
        publishedMonth: month,
        publishedValue: value,
        pending: pending ? { month, value } : undefined
      }
    }
  }

  private today() {
    return getMarketDate('CN', this.now())
  }

  private total(month: string, ledger = this.ledger): number {
    const entry = ledger.months[month]
    if (!entry) return 0
    return Number(Object.values(entry.days).reduce((sum, day) => sum.add(
      day.manualTotal ?? Object.values(day.stocks).reduce((subtotal, value) => subtotal.add(value), new Decimal(0))
    ), new Decimal(entry.openingBalance)).toFixed(2))
  }

  getMonthlyProfit(): number {
    this.reload()
    const month = this.today().slice(0, 7)
    const configuration = this.readConfiguration()
    const configured = configuration.value
    const adjustment = !this.ledger.pending && this.ledger.publishedMonth === month &&
      configuration.revision === this.ledger.publishedRevision &&
      this.ledger.publishedValue !== undefined && Number.isFinite(configured)
      ? new Decimal(configured).sub(this.ledger.publishedValue) : new Decimal(0)
    return new Decimal(this.total(month)).add(adjustment).toNumber()
  }

  isSettled(stock: Stock): boolean {
    this.reload()
    if (stock.region !== 'CN' || !Number.isFinite(stock.quote.timestamp)) return false
    const date = getMarketDate('CN', stock.quote.timestamp)
    const month = this.ledger.months[date.slice(0, 7)]
    const day = month?.days[date]
    return month?.legacyDate === date || day?.manualTotal !== undefined ||
      (day !== undefined && Object.prototype.hasOwnProperty.call(day.stocks, stock.symbol))
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(() => this.sharedStorage
      ? this.sharedStorage.runExclusive(operation) : operation())
    this.queue = result.catch(() => undefined)
    return result
  }

  private async save(ledger: ProfitLedger) {
    if (this.sharedStorage) await this.sharedStorage.write(ledger)
    else await this.storage.update(KEY, ledger)
    this.ledger = ledger
  }

  private reload() {
    const saved = this.sharedStorage ? this.sharedStorage.read() : this.storage.get<ProfitLedger>(KEY)
    if (saved) this.ledger = saved
  }

  private async publish() {
    let pending = this.ledger.pending
    if (!pending) return
    // Persist the token before either setting is written, including legacy pending writes.
    if (!pending.revision) {
      pending = { ...pending, revision: randomUUID() }
      await this.save({ ...this.ledger, pending })
    }
    // A completed settings write may precede a failed final ledger save. Preserve any later manual edit.
    if (this.readConfiguration().revision !== pending.revision) {
      await this.writeValue(pending.value, pending.revision!)
    }
    await this.save({
      ...this.ledger,
      publishedMonth: pending.month,
      publishedValue: pending.value,
      publishedRevision: pending.revision,
      pending: undefined
    })
  }

  private async update(operation: (ledger: ProfitLedger, month: MonthProfit) => void) {
    // The cross-window lock must cover reload, reconciliation, journal and settings publication.
    this.reload()
    await this.publish()
    const currentMonth = this.today().slice(0, 7)
    const ledger: ProfitLedger = JSON.parse(JSON.stringify(this.ledger))
    const month = ledger.months[currentMonth] ??= { openingBalance: 0, days: {} }
    // Preserve intentional edits to the public setting as an opening-balance adjustment.
    const configuration = this.readConfiguration()
    const configured = configuration.value
    const manuallyAdjusted = ledger.publishedMonth === currentMonth && ledger.publishedValue !== undefined &&
      configuration.revision === ledger.publishedRevision &&
      Number.isFinite(configured) && configured !== ledger.publishedValue
    if (manuallyAdjusted) {
      month.openingBalance = new Decimal(month.openingBalance).add(configured).sub(ledger.publishedValue!).toNumber()
    }
    operation(ledger, month)
    const value = this.total(currentMonth, ledger)
    if (manuallyAdjusted || !ledger.publishedRevision || ledger.publishedMonth !== currentMonth || ledger.publishedValue !== value) {
      ledger.pending = { month: currentMonth, value, revision: randomUUID() }
    }
    if (JSON.stringify(ledger) !== JSON.stringify(this.ledger)) await this.save(ledger)
    await this.publish()
  }

  settle(stocks: Stock[], positions: Record<string, Position>): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.update((_ledger, month) => {
          const today = this.today()
          const day = month.days[today]
          if (month.legacyDate === today || day?.manualTotal !== undefined) {
            this.status = day?.manualTotal !== undefined ? '今日收益已手动结算' : '今日收益已结算'
            return
          }
          const symbols = Object.keys(positions).filter(symbol => /^(SH|SZ|BJ)/.test(symbol) &&
            (positions[symbol].shares > 0 || positions[symbol].tradeRecords?.some(record => record.time === today)))
          const waiting: string[] = []
          for (const symbol of symbols) {
            const stock = stocks.find(item => item.symbol === symbol)
            if (!stock || stock.region !== 'CN' || !stock.profit || !Number.isFinite(stock.profit.todayProfit) ||
              !Number.isFinite(stock.quote.timestamp) || stock.quote.marketStatusId !== 7 ||
              getMarketDate('CN', stock.quote.timestamp) !== today) {
              waiting.push(symbol)
              continue
            }
            // Replacing a symbol's daily value allows late quotes/trade corrections without double counting.
            const entry = month.days[today] ??= { stocks: {} }
            entry.stocks[symbol] = stock.profit.todayProfit
          }
          this.status = waiting.length ? `等待收盘行情：${waiting.join('、')}` : symbols.length ? '今日收益已结算' : ''
        })
      } catch (error) {
        this.status = '月收益保存失败，将在下次刷新重试'
        throw error
      }
    })
  }

  /** Explicit daily totals can backfill missed days without inventing historical quotes. */
  correctDay(date: string, value: number): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > this.today() || !Number.isFinite(value)) {
      return Promise.reject(new Error('请输入有效的历史日期及有限收益金额'))
    }
    return this.enqueue(async () => {
      await this.update(ledger => {
        const month = ledger.months[date.slice(0, 7)] ??= { openingBalance: 0, days: {} }
        if (month.legacyDate && date <= month.legacyDate) {
          throw new Error('该日期已包含在旧版累计余额中，无法单独修正；请调整 monthlyProfit 总额')
        }
        month.days[date] = { stocks: {}, manualTotal: Number(new Decimal(value).toFixed(2)) }
      })
      this.status = `${date} 收益已手动记录`
    })
  }
}
