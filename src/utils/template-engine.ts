import * as vscode from 'vscode'
import * as fs from 'fs'

export type TemplateData = Record<string, any>

export default class TemplateEngine {
  private static instance: TemplateEngine
  private templateCache = new Map<string, string>()

  private constructor() { /* empty */ }

  static getInstance(): TemplateEngine {
    if (!TemplateEngine.instance) {
      TemplateEngine.instance = new TemplateEngine()
    }
    return TemplateEngine.instance
  }

  /**
     * 加载模板文件
     * @param context 扩展上下文
     * @param templatePath 模板文件路径
     * @returns 模板内容
     */
  async loadTemplate(context: vscode.ExtensionContext, templatePath: string): Promise<string> {
    // 检查缓存
    if (this.templateCache.has(templatePath)) {
      return this.templateCache.get(templatePath)!
    }

    const fullPath = vscode.Uri.joinPath(context.extensionUri, templatePath)
    const content = fs.readFileSync(fullPath.fsPath, 'utf-8')

    // 缓存模板
    this.templateCache.set(templatePath, content)

    return content
  }

  /**
     * 渲染模板（支持变量替换）
     * @param template 模板字符串
     * @param data 数据对象
     * @returns 渲染后的 HTML
     */
  render(template: string, data: TemplateData): string {
    let result = template

    // 替换变量 ${variableName}
    result = result.replace(/\$\{([^}]+)\}/g, (match, key) => {
      const value = this.getNestedValue(data, key.trim())
      return value !== undefined ? String(value) : match
    })

    // 替换 JavaScript 对象（特殊处理）
    result = result.replace(/\$\{([^}]+)\}/g, (match, key) => {
      if (key.includes('Data') || key.includes('data')) {
        const value = this.getNestedValue(data, key.trim())
        return value !== undefined ? JSON.stringify(value) : match
      }
      return match
    })

    return result
  }

  /**
     * 渲染模板文件
     * @param context 扩展上下文
     * @param templatePath 模板路径
     * @param data 数据
     * @returns 渲染后的 HTML
     */
  async renderTemplate(
    context: vscode.ExtensionContext,
    templatePath: string,
    data: TemplateData
  ): Promise<string> {
    const template = await this.loadTemplate(context, templatePath)
    return this.render(template, data)
  }

  /**
     * 获取嵌套属性值
     */
  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.')
    let value = obj

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key]
      } else {
        return undefined
      }
    }

    return value
  }

  /**
     * 清除缓存
     */
  clearCache(): void {
    this.templateCache.clear()
  }
}