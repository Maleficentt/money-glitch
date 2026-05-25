import * as vscode from 'vscode'

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

  async updateConfig(key: string, value: unknown) {
    await this.config.update(key, value, vscode.ConfigurationTarget.Global)
  }

  // 监听配置变化
  onConfigChange(callback: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('moneyGlitch')) {
        this.config = vscode.workspace.getConfiguration('moneyGlitch')
        callback()
      }
    })
  }

  getStockCodes(): string[] {
    return this.getConfig<string[]>('stockCodes', [])
  }

  async addStockCode(code: string): Promise<void> {
    const codes = this.getStockCodes()
    if (!codes.includes(code)) {
      await this.updateConfig('stockCodes', [...codes, code])
    }
  }

  async removeStockCode(code: string): Promise<void> {
    const codes = this.getStockCodes()
    await this.updateConfig('stockCodes', codes.filter(c => c !== code))
  }
}

export default ConfigManager