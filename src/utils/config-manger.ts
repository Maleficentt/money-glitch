import * as vscode from 'vscode'
import { Position } from './types'

class ConfigManager {
  private static instance: ConfigManager
  private config = vscode.workspace.getConfiguration('moneyGlitch')

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

  updatePosition(stockPosition: Position) {
    const { ...position } = this.getPosition()
    const { symbol, cost, shares, tradeRecords } = stockPosition
    position[symbol as string] = {
      cost,
      shares,
      tradeRecords
    }
    return this.updateConfig('position', position)
  }
}

export default ConfigManager