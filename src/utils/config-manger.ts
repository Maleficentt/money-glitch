import * as vscode from 'vscode'
import { Broker, Position } from './types'
import { validatePosition } from './trade-validation'

class ConfigManager {
  private static instance: ConfigManager
  private config = vscode.workspace.getConfiguration('moneyGlitch')
  private positionWrites: Promise<void> = Promise.resolve()

  private constructor() { /* empty */ }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager()
    }
    return ConfigManager.instance
  }

  getConfig<T>(key: string, defaultValue: T): T {
    return this.config.get<T>(key, defaultValue)
  }

  updateConfig(key: string, value: unknown) {
    return this.config.update(key, value, vscode.ConfigurationTarget.Global)
  }

  refreshConfig() {
    this.config = vscode.workspace.getConfiguration('moneyGlitch')
  }

  getStockSymbols(): string[] {
    return this.getConfig<string[]>('stockSymbols', [])
  }

  addStockSymbol(symbol: string) {
    const symbols = this.getStockSymbols()
    if (!symbols.includes(symbol)) {
      return this.updateConfig('stockSymbols', [...symbols, symbol])
    }
  }

  removeStockSymbol(symbol: string) {
    const symbols = this.getStockSymbols()
    return this.updateConfig('stockSymbols', symbols.filter(c => c !== symbol))
  }

  getStatusBarStockSymbols(): string[] {
    return this.getConfig<string[]>('statusBarStockSymbols', [])
  }

  addStockSymbolToStatusBar(symbol: string) {
    const symbols = this.getStatusBarStockSymbols()
    if (!symbols.includes(symbol)) {
      return this.updateConfig('statusBarStockSymbols', [...symbols, symbol])
    }
  }

  removeStockSymbolFromStatusBar(symbol: string) {
    const symbols = this.getStatusBarStockSymbols()
    return this.updateConfig('statusBarStockSymbols', symbols.filter(c => c !== symbol))
  }

  async replaceStockSymbolInStatusBar(oldSymbol: string, newSymbol: string): Promise<void> {
    const symbols = this.getStatusBarStockSymbols()
    const index = symbols.findIndex(item => item === oldSymbol)
    if (index !== -1) {
      symbols.splice(index, 1, newSymbol)
      await this.updateConfig('statusBarStockSymbols', symbols)
    }
  }

  getPosition(): Record<string, Position> {
    return this.getConfig<Record<string, Position>>('position', {})
  }

  updatePositionWith(symbol: string, update: (current: Position | undefined) => Position | Promise<Position>): Promise<void> {
    const operation = this.positionWrites.then(async () => {
      if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('股票代码不能为空')
      this.refreshConfig()
      const positions = { ...this.getPosition() }
      const next = await update(positions[symbol])
      validatePosition(next)
      positions[symbol] = next
      await this.updateConfig('position', positions)
      this.refreshConfig()
    })
    this.positionWrites = operation.catch(() => { /* Keep the queue usable after a rejected write. */ })
    return operation
  }

  updatePosition(stockPosition: Position): Promise<void> {
    const { symbol, cost, shares } = stockPosition
    return this.updatePositionWith(symbol as string, current => ({
      ...current,
      cost,
      shares,
      tradeRecords: stockPosition.tradeRecords ?? current?.tradeRecords
    }))
  }

  getIndexSymbols(): string[] {
    return this.getConfig<string[]>('indexSymbols', [])
  }

  getBrokerMap(): Record<string, Broker> {
    return this.getConfig<Record<string, Broker>>('broker', {})
  }

}

export default ConfigManager
