import * as vscode from 'vscode'
import axios from 'axios'
import { decode } from 'iconv-lite'
import requestHeader from './utils/request-header'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import isBetween from 'dayjs/plugin/isBetween'
import ConfigManager from './utils/config-manger'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isBetween)

// 持仓
// interface PositionStock {
//   code: string
//   name: string
//   quantity: number // 数量
//   cost: number // 成本
// }

type StockCategory = 'A Stock' | 'HK Stock' | 'US STOCK' | 'CN Future' | 'Oversea Future'
type StockType = 'sh' | 'sz' | 'bj' | 'hk' | 'usr_' | 'nf_' | 'hf_'

interface Stock {
  category: StockCategory
  type: StockType
  code: string
  name: string
  prevClose: number      // 昨收（昨天收盘价）
  open: number           // 今开
  high: number           // 最高
  low: number            // 最低
  last: number           // 最新价(现价)
  volume?: number        // 成交量
  amount?: number        // 成交额
  time: string           // 更新时间
}

type StockTreeItem = StockCategoryItem | StockItem

class StockCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly stockCategory: StockCategory,
    public readonly stockCount: number,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(stockCategory, collapsibleState)

    this.contextValue = 'stockCategory'
    this.description = `(${stockCount})`
    this.tooltip = `${stockCategory} (${stockCount})`
  }
}

class StockItem extends vscode.TreeItem {
  constructor(public readonly stock: Stock, context: vscode.ExtensionContext) {
    const change = stock.last && stock.prevClose
      ? ((stock.last - stock.prevClose) / stock.prevClose * 100).toFixed(2)
      : '0'
    // 方式2：带涨跌幅
    const label = `${Number(change) >= 0 ? `+${change}` : ` ${change}`}%   ${String(stock.last || '--').padEnd(12, ' ')}    ${stock.name}`
    super(label, vscode.TreeItemCollapsibleState.None)

    this.contextValue = 'stock'
    this.tooltip = StockItem.formatTooltip(stock)
    this.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      'resources',
      'up_2.svg'
    )
  }

  private static formatTooltip(stock: Stock): string {
    const change = stock.last && stock.prevClose
      ? ((stock.last - stock.prevClose) / stock.prevClose * 100).toFixed(2)
      : '0'
    const changeSymbol = Number(change) >= 0 ? '+' : ''

    return `${stock.name} (${stock.code})
━━━━━━━━━━━━━━━━━━━
💰 Current: ${stock.last?.toFixed(2) || '--'}
📊 Change: ${changeSymbol}${change}%
📈 High: ${stock.high || '--'}
📉 Low: ${stock.low || '--'}
🔓 Open: ${stock.open || '--'}
🔒 Prev Close: ${stock.prevClose || '--'}`
  }
}

class StockTreeProvider implements vscode.TreeDataProvider<StockTreeItem> {
  private configManager = ConfigManager.getInstance()
  private static readonly StockCategories: StockCategory[] = ['A Stock', 'HK Stock', 'US STOCK', 'CN Future', 'Oversea Future']
  private readonly defaultExpandedStockTypes = new Set<StockCategory>(['A Stock'])
  private readonly changeEmitter = new vscode.EventEmitter<
    StockTreeItem | undefined | null | void
  >()

  readonly onDidChangeTreeData = this.changeEmitter.event

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(this.changeEmitter)

    // 监听配置变化
    this.context.subscriptions.push(
      this.configManager.onConfigChange(() => {
        this.refresh()
      })
    )
  }

  getTreeItem(element: StockTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: StockTreeItem): Promise<StockTreeItem[]> {
    const stocks = await this.fetchStocks()

    if (!element) {
      return StockTreeProvider.StockCategories.map(
        (stockCategory) =>
          new StockCategoryItem(
            stockCategory,
            this.getStocksByCategory(stocks, stockCategory).length,
            this.getStockTypeCollapsibleState(stockCategory)
          )
      )
    }

    if (element instanceof StockCategoryItem) {
      return stocks
        .filter((stock) => stock.category === element.stockCategory)
        .map((stock) => new StockItem(stock, this.context))
    }

    return []
  }

  async addStock(): Promise<void> {
    const quickPick = vscode.window.createQuickPick()
    quickPick.items = [{ label: '请输入关键词查询，如：0000001 或 上证指数; 期货输入大写字母开头' }]
    let code: string | undefined
    let timer: number | null
    quickPick.onDidChangeValue((value) => {
      quickPick.busy = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      timer = setTimeout(async () => {
        const res = await this.getStockSuggestList(value)
        quickPick.items = res
        quickPick.busy = false
      }, 100) // 简单防抖
    })
    quickPick.onDidChangeSelection((e) => {
      if (e[0].description) {
        code = e[0].label && e[0].label.split(' | ')[0]
      }
    })
    quickPick.show()
    quickPick.onDidAccept(async () => {
      if (!code) {
        return
      }
      // 存储到配置的时候是接口的参数格式，接口请求时不需要再转换
      const newCode = code.replace('gb', 'gb_').replace('us', 'usr_')
      await this.configManager.addStockCode(newCode)
      vscode.window.showInformationMessage('Stock has saved.')
      quickPick.hide()
      quickPick.dispose()
    })
  }

  async deleteStock(item: StockItem): Promise<void> {
    const stock = item.stock
    const stockCode = stock.code
    const stockName = stock.name
    try {
      await this.configManager.removeStockCode(stockCode)
    } catch (error) {
      console.error('Failed to delete stock:', error)
      vscode.window.showErrorMessage(`Failed to delete ${stockName}`)
    }
  }

  async moveEntryUp(_item?: StockTreeItem): Promise<void> {
    console.log(_item)
    await vscode.window.showInformationMessage('Stock data source is reserved.')
  }

  async moveEntryDown(_item?: StockTreeItem): Promise<void> {
    console.log(_item)
    await vscode.window.showInformationMessage('Stock data source is reserved.')
  }

  refresh(): void {
    this.changeEmitter.fire()
  }

  private getStocksByCategory(stocks: Stock[], stockCategory: StockCategory): Stock[] {
    return stocks.filter((stock) => stock.category === stockCategory)
  }

  private getStockTypeCollapsibleState(
    stockCategory: StockCategory
  ): vscode.TreeItemCollapsibleState {
    return this.defaultExpandedStockTypes.has(stockCategory)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  }

  private fetchStocks(): Promise<Stock[]> {
    // [
    //   'sh000001',
    //   'sh000688',
    //   'sz399006',
    //   'usr_ixic',
    //   'usr_dji',
    //   'usr_inx',
    //   'nf_IF0',
    //   'nf_IH0',
    //   'nf_IC0',
    //   'nf_IM0',
    //   'hf_OIL',
    //   'hf_CHA50CFD',
    //   'sh603043',
    //   'sh600938',
    //   'sz002648',
    //   'hk01919',
    //   'sz300499',
    //   'sh601919',
    //   'hk00883',
    //   'sh601398',
    //   'sh600152',
    //   'sz159805',
    //   'sh563020',
    //   'hk01787',
    //   'sz000603',
    //   'sz000751',
    //   'hk00857',
    //   'sh600547',
    //   'sz002240',
    //   'sz300058',
    //   'sz300383',
    //   'sh603881',
    //   'sh601857',
    //   'sh600584',
    //   'sz000807'
    // ]
    const stockCodesConfig = this.configManager.getStockCodes()
    const allStockCodes = stockCodesConfig.map((code: string) => {
      if (/^[A-Z]+/.test(code)) {
        return code.replace(/^[A-Z]+/, (it: string) => `nf_${it}`)
      } else if (/cnf_/.test(code)) {
        return code.replace('cnf_', 'nf_')
      }
      return code
    })
    const hkCodes: string[] = [] // 港股单独请求腾讯港股数据源
    const stockCodes = allStockCodes.filter((code) => {
      if (code.startsWith('hk')) {
        hkCodes.push('hk' + code.substring(2).toUpperCase()) // 指数去掉'hk'并转为大写，适配腾讯港股接口
        return false
      } else {
        return true
      }
    })
    const url = `https://hq.sinajs.cn/list=${stockCodes
      .map((code) => code.replace('.', '$')) // 新浪接口中点号替换为$
      .join(',')}`
    return axios.get(url, {
      responseType: 'arraybuffer',
      validateStatus: (status) => {
        return status === 200
      },
      transformResponse: [
        (data) => {
          const body = decode(data, 'GB18030')
          return body
        }
      ],
      headers: {
        ...requestHeader(),
        Referer: 'http://finance.sina.com.cn/'
      }
    }).then(res => {
      const splitData = res.data.split('";\n')
      const estTime = dayjs().tz('America/New_York')
      // 判断美东时间的时间是否在4:00AM到9:30AM之间
      const isUsrPreMarket = estTime.isBetween(
        estTime.clone().set('hour', 4).set('minute', 0).set('second', 0),
        estTime.clone().set('hour', 9).set('minute', 30).set('second', 0)
      )
      // 判断美东时间的时间是否在9:30AM到4:00PM之间
      const isUsrMainMarket = estTime.isBetween(
        estTime.clone().set('hour', 9).set('minute', 30).set('second', 0),
        estTime.clone().set('hour', 16).set('minute', 0).set('second', 0)
      )
      // 判断美东时间的时间是否在4:00PM到8:00PM之间
      const isUsrAfterMarket = estTime.isBetween(
        estTime.clone().set('hour', 16).set('minute', 0).set('second', 0),
        estTime.clone().set('hour', 20).set('minute', 0).set('second', 0)
      )
      const stockList: Stock[] = []
      splitData.forEach((item: string) => {
        let code = item.split('="')[0].split('var hq_str_')[1]
        if (!code) return
        if (code?.includes('$')) {
          code = code.replace('$', '.') // 新浪接口中$替换回点号,否则会造成无法匹配删除的结果
        }
        const quoteData = item.split('="')[1].split(',')
        if (quoteData.length > 1) {
          const name = quoteData[0]
          let open = 0
          let prevClose = 0
          let last = 0
          let high = 0
          let low = 0
          let buy1 = 0
          const time = quoteData[quoteData.length - 2]
          let type = 'sh'
          let category = ''
          if (/^(sh|sz|bj)/.test(code)) {
            // A Stock
            category = 'A Stock'
            type = code.slice(0, 2)
            open = Number(quoteData[1])
            prevClose = Number(quoteData[2])
            last = Number(quoteData[3])
            high = Number(quoteData[4])
            low = Number(quoteData[5])
            buy1 = Number(quoteData[6])
            if (last === 0) {
              if (buy1 !== 0) {
                last = buy1
              } else {
                last = prevClose
              }
            }
          } else if (/^usr_/.test(code)) {
            // US Stock
            category = 'US Stock'
            type = code.slice(0, 4)
            // 0 名称，1 最新价 2 涨跌百分比
            // var hq_str_usr_nvda="英伟达,198.6900,-3.96,
            // 3 更新时间 4 涨跌数字 5 今开 6 最高 7 最低
            // 2025-11-05 17:27:07,-8.1900,203.0000,203.9699,197.9300,
            // 8 9 10 成交量 11
            // 212.1900,86.6000,188919320,189303100,4837505430000,
            // 13 14 15 16 17 18 19 20
            // 3.54,56.130000,0.00,0.00,0.01,0.00,24347000000,69,
            // 21 盘前最新价 22 盘前涨跌幅 23 盘前涨跌 24 美东时间 25 昨日美东收盘时间 26 昨日收盘价
            // 197.6300,-0.53,-1.06,Nov 05 04:27AM EST,Nov 04 04:00PM EST,206.8800,
            // 27 28 29 30 31 32 33 34 35 新一天盘前时昨日收盘价
            // 388870,1,2025,37901854538.6275,198.4000,196.5900,76916423.7300,197.1100,198.6900";

            open = Number(quoteData[5])
            prevClose = Number(quoteData[26])
            last = Number(quoteData[1])
            if (isUsrMainMarket) {
              last = Number(quoteData[1]) // 盘中价格
              prevClose = Number(quoteData[26]) // 昨收盘
            } else if (isUsrPreMarket) {
              // 兼容纳指等无盘前价格的情况
              if (Number(quoteData[21]) !== 0) {
                last = Number(quoteData[21]) // 盘前价格
              }
              // 兼容纳指等无盘前价格的情况
              if (Number(quoteData[35]) !== 0) {
                prevClose = Number(quoteData[35]) // 新一天盘前时昨日收盘价
              }
            } else if (isUsrAfterMarket) {
              // 兼容纳指等无盘后价格的情况
              if (Number(quoteData[21]) !== 0) {
                last = Number(quoteData[21]) // 盘后价格
              }
              // 兼容纳指等无盘后价格的情况
              if (Number(quoteData[1]) !== 0) {
                prevClose = Number(quoteData[1]) // 盘后的收盘价为盘中价
              }
            } else {
              // 夜盘时间取盘后价格
            }
            high = Number(quoteData[6])
            low = Number(quoteData[7])
          }
          stockList.push({
            category: category as StockCategory,
            type: type as StockType,
            code,
            name,
            open,
            prevClose,
            last,
            high,
            low,
            time
          })
        }
      })
      return Promise.resolve(stockList)
    })
  }

  private async getStockSuggestList(searchText = ''): Promise<vscode.QuickPickItem[]> {
    if (!searchText) {
      return Promise.resolve([{ label: '请输入关键词查询，如：0000001 或 上证指数; 期货输入大写字母开头' }])
    }

    const result: vscode.QuickPickItem[] = []

    // 期货大写字母开头
    const isFuture =
      /^[A-Z]/.test(searchText.charAt(0)) ||
      /nf_/.test(searchText) ||
      /hf_/.test(searchText) ||
      /fx_/.test(searchText)
    if (isFuture) {
      //期货使用新浪数据源
      const type = '85,86,88'
      const futureUrl = `http://suggest3.sinajs.cn/suggest/type=${type}&key=${encodeURIComponent(
        searchText
      )}`
      return axios.get(futureUrl, {
        responseType: 'arraybuffer',
        transformResponse: [
          (data) => {
            const body = decode(data, 'GB18030')
            return body
          }
        ],
        headers: requestHeader()
      }).then(res => {
        const text = res.data.slice(18, -2)
        if (!!text) {
          const tempArr = text.split(';')

          tempArr.forEach((item: string) => {
            const arr = item.split(',')
            let code = arr[3]
            const market = arr[1]
            code = code.toUpperCase()
            // 国内交易所
            if (market === '85' || market === '88') {
              code = 'nf_' + code
            } else if (market === '86') {
              // 海外交易所
              code = 'hf_' + code
            }
            // if (code.substr(0, 2) === 'of') {
            // 修改lof以及etf的前缀，防止被过滤
            // http://www.csisc.cn/zbscbzw/cpbmjj/201212/f3263ab61f7c4dba8461ebbd9d0c6755.shtml
            // 在上海证券交易所挂牌的证券投资基金使用50～59开头6位数字编码，在深圳证券交易所挂牌的证券投资基金使用15～19开头6位数字编码。
            // code = code.replace(/^(of)(5[0-9])/g, 'sh$2').replace(/^(of)(1[5-9])/g, 'sz$2');
            // }

            // 期货 suggest 请求返回的 code 小写开头改为大写

            // if (code === 'hkhsi' || code === 'hkhscei' || isFuture) {
            //   code = code.toUpperCase().replace('HK', 'hk');
            // }

            // 过滤多余的 us. 开头的股干扰
            // if ((STOCK_TYPE.includes(code.substr(0, 2)) && !code.startsWith('us.')) || isFuture) {
            result.push({
              label: `${code} | ${arr[4]}`,
              description: arr[7] && arr[7].replace(/"/g, '')
            })
            // }
          })
        }
        return Promise.resolve(result)
      }).catch(() => {
        return Promise.resolve([{ label: '期货查询失败，请重试' }])
      })
    } else {
      // 改为腾讯数据源
      return axios.get('https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get', {
        params: {
          q: searchText
        }
      }).then(res => {
        const stockListArray = res?.data?.data?.stock || []
        stockListArray.forEach((item: string[]) => {
          const code = item[1].toLowerCase()
          const name = item[2]
          const market = item[0]
          const _code = `${market}${code}`
          if (['sz', 'sh', 'bj'].includes(market)) {
            result.push({
              label: `${_code} | ${name}`,
              description: `A股`
            })
          } else if (['hk'].includes(market)) {
            // 港股个股 || 港股指数
            result.push({
              label: `${_code} | ${name}`,
              description: `港股`
            })
          } else if (['us'].includes(market)) {
            const codeSplit = _code.split('.')
            let usCode = codeSplit[0]
            if (codeSplit.length > 2) {
              // 有些美股代码会有多个点，如 BRK.B
              usCode = codeSplit.slice(0, codeSplit.length - 1).join('.')
            }
            result.push({
              label: `${usCode} | ${name}`,
              description: `美股`
            })
          }
        })
        return Promise.resolve(result)
      }).catch(() => {
        return Promise.resolve([{ label: '股票查询失败，请重试' }])
      })
    }
  }
}

export default StockTreeProvider
