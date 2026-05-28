import axios from 'axios'
import { Quote, Stock, Exchange } from './types'

let cachedCookies: Record<string, string>

async function getCookie(source = 'xq') {
  // 1. 检查缓存
  if (cachedCookies) {
    return cachedCookies
  }

  // 2. 获取雪球令牌
  if (source === 'xq' || source === 'xueqiu') {
    const response = await axios.get('https://xueqiu.com/hq', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      withCredentials: true  // 自动接收和保存 Cookie
    })

    // 3. 从响应头中提取 Cookie
    const setCookieHeader = response.headers['set-cookie']
    const cookies = parseCookies(setCookieHeader)

    cachedCookies = {
      xq_a_token: cookies['xq_a_token'],
      u: cookies['u']
    }

    return cachedCookies
  } else {
    throw new Error(`get_token doesn't support ${source} source`)
  }
}

// 辅助函数：解析 Set-Cookie 头
function parseCookies(setCookieArray: string[] | undefined) {
  const cookies: Record<string, string> = {}
  if (!setCookieArray) return cookies

  setCookieArray.forEach(cookie => {
    const [keyValue] = cookie.split(';')
    const [key, value] = keyValue.split('=')
    if (key && value) {
      cookies[key.trim()] = value
    }
  })
  return cookies
}

interface Item {
  quote: Quote,
  market: Record<string, unknown>
}

const underscoreToCamelCase = (str: string) => {
  str = str.toLowerCase()
  const result = str.replace(/_([a-z])/g, (p, m) => m.toUpperCase())
  return result
}

export function getStockData(symbolList: string[], config = {}): Promise<Stock[]> {
  const BATCH_SIZE = 50

  // 将股票代码列表分成多个批次
  const batches: string[][] = []
  for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
    batches.push(symbolList.slice(i, i + BATCH_SIZE))
  }

  return getCookie().then(cookies => {
    // 创建所有批次的请求
    const requests = batches.map(batch => {
      const symbol = batch.join(',')
      return axios.get('https://stock.xueqiu.com/v5/stock/batch/quote.json', {
        params: {
          symbol: symbol,
          extend: 'detail',
          is_delay_hk: true
        },
        headers: {
          Cookie: `xq_a_token=${cookies.xq_a_token}; u=${cookies.u}`,
          'User-Agent': 'Mozilla/5.0'
        },
        ...config
      }).then(res => {
        const stocks: Stock[] = []
        res.data.data.items.map((item: Item) => {
          if (item.quote) {
            const { region, status, status_id } = item.market
            const quote: Quote = { ...item.quote }
            for (const key in quote) {
              const newKey: string = underscoreToCamelCase(key)
              quote[newKey] = quote[key]
            }
            quote.status = status as string
            quote.statusId = status_id as number
            const { exchange, symbol, code, name } = quote as Quote
            const stock: Stock = {
              region: region as string,
              exchange: exchange as Exchange,
              symbol: symbol as string,
              code: code as string,
              name: name as string,
              quote
            }
            stocks.push(stock)
          }
        })
        return stocks
      }).catch(error => {
        return Promise.reject(error)
      })
    })

    return Promise.all(requests).then(resList => {
      const stockList = resList.flat()
      return stockList
    }).catch(err => {
      return Promise.reject(err)
    })
  })
}

export function getRealtimeQuote(symbolList: string[], config = {}): Promise<Record<string, Quote>> {
  return getCookie().then(cookies => {
    const symbol = symbolList.join(',')
    return axios.get('https://stock.xueqiu.com/v5/stock/realtime/quotec.json', {
      params: {
        symbol: symbol,
        _: new Date().getTime()
      },
      headers: {
        Cookie: `xq_a_token=${cookies.xq_a_token}; u=${cookies.u}`,
        'User-Agent': 'Mozilla/5.0'
      },
      ...config
    }).then(res => {
      const quoteMap: Record<string, Quote> = {}
      res.data.data.forEach((item: Quote) => {
        const quote = { ...item }
        for (const key in quote) {
          const newKey: string = underscoreToCamelCase(key)
          quote[newKey] = quote[key]
        }
        quoteMap[item.symbol as string] = quote
      })
      return quoteMap
    }).catch(error => {
      return Promise.reject(error)
    })
  })
}

export function queryStock(code: string): Promise<[]> {
  return getCookie().then(cookies => {
    // 创建所有批次的请求
    return axios.get('https://xueqiu.com/query/v1/search/stock.json', {
      params: {
        code,
        size: 10
      },
      headers: {
        Cookie: `xq_a_token=${cookies.xq_a_token}; u=${cookies.u}`,
        'User-Agent': 'Mozilla/5.0'
      }
    }).then(res => {
      const stocks = res.data.stocks.filter((item: Record<string, unknown>) => item.stock_id !== 0) || []
      return stocks
    }).catch(error => {
      return Promise.reject(error)
    })
  })
}