import axios, { AxiosRequestConfig } from 'axios'
import { Quote, Stock, Exchange } from './types'
let cachedCookies: Record<string, string> | undefined
let cookieRequest: Promise<Record<string, string>> | undefined

function request(url: string, config: AxiosRequestConfig = {}) {
  return axios.get(url, { timeout: 10000, ...config }).catch((error: unknown) => {
    if (axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)) {
      cachedCookies = undefined
    }
    throw error
  })
}

async function getCookie(source = 'xq') {
  // 1. 检查缓存
  if (cachedCookies) {
    return cachedCookies
  }
  if (cookieRequest) return cookieRequest

  // 2. 获取雪球令牌
  if (source === 'xq' || source === 'xueqiu') {
    cookieRequest = request('https://xueqiu.com/hq', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      withCredentials: true  // 自动接收和保存 Cookie
    }).then(response => {

      // 3. 从响应头中提取 Cookie
      const setCookieHeader = response.headers['set-cookie']
      const cookies = parseCookies(setCookieHeader)
      if (!cookies.xq_a_token || !cookies.u) throw new Error('Missing market data authentication cookies')

      cachedCookies = {
        xq_a_token: cookies['xq_a_token'],
        u: cookies['u']
      }

      return cachedCookies
    }).finally(() => { cookieRequest = undefined })
    return cookieRequest
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
      return request('https://stock.xueqiu.com/v5/stock/batch/quote.json', {
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
            quote.marketStatus = status as string
            quote.marketStatusId = status_id as number
            const { exchange, symbol, code, name, type } = quote as Quote
            const stock: Stock = {
              region: region as string,
              exchange: exchange as Exchange,
              symbol: symbol as string,
              code: code as string,
              name: name as string,
              type: type as number,
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
      return request('https://stock.xueqiu.com/v5/stock/realtime/quotec.json', {
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
            quote[newKey] = quote[key] ?? 0
          }
          quoteMap[item.symbol as string] = quote
        })
        return quoteMap
      }).catch(error => {
        return Promise.reject(error)
      })
    })

    return Promise.all(requests).then(resList => {
      const quoteMap = {}
      resList.forEach(item => {
        Object.assign(quoteMap, item)
      })
      return quoteMap
    }).catch(err => {
      return Promise.reject(err)
    })
  })
}

export function queryStock(code: string): Promise<[]> {
  return getCookie().then(cookies => {
    // 创建所有批次的请求
    return request('https://xueqiu.com/query/v1/search/stock.json', {
      params: {
        code,
        size: 10
      },
      headers: {
        Cookie: `xq_a_token=${cookies.xq_a_token}; u=${cookies.u}`,
        'User-Agent': 'Mozilla/5.0'
      }
    }).then(res => {
      const stocks = res.data.stocks.filter((item: Record<string, unknown>) => item.exchange !== 'F') || []
      return stocks
    }).catch(error => {
      return Promise.reject(error)
    })
  })
}

export function getMinuteData(symbol: string, config = {}): Promise<[]> {
  return getCookie().then(cookies => {
    return request('https://stock.xueqiu.com/v5/stock/chart/minute.json', {
      params: {
        symbol,
        period: '1d'
      },
      headers: {
        Cookie: `xq_a_token=${cookies.xq_a_token}; u=${cookies.u}`,
        'User-Agent': 'Mozilla/5.0'
      },
      ...config
    }).then(res => {
      return res.data.data.items
    }).catch(error => {
      return Promise.reject(error)
    })
  })
}

export interface ExchangeRate {
  date: string
  base: string
  quote: string
  rate: number
}

let exchangeRates: ExchangeRate[] = []
let exchangeRequest: Promise<ExchangeRate[]> | undefined
let exchangeFetchedAt: number | null = null
let exchangeRetryAt = 0
let exchangeError: string | undefined
const exchangeTtl = 6 * 60 * 60 * 1000

export function getExchangeRateStatus() {
  return {
    stale: exchangeFetchedAt === null || Date.now() - exchangeFetchedAt >= exchangeTtl || !!exchangeError,
    fetchedAt: exchangeFetchedAt,
    error: exchangeError
  }
}

export function getExchangeRates(): Promise<ExchangeRate[]> {
  if (exchangeRequest) return exchangeRequest
  if (exchangeRates.length && (!getExchangeRateStatus().stale || Date.now() < exchangeRetryAt)) {
    return Promise.resolve(exchangeRates)
  }
  if (Date.now() < exchangeRetryAt) return Promise.reject(new Error(exchangeError))
  exchangeRequest = request('https://api.frankfurter.dev/v2/rates', {
    params: {
      base: 'CNY',
      quotes: 'USD,HKD'
    }
  }).then(res => {
    const rates = res.data as ExchangeRate[]
    if (!Array.isArray(rates) || !['USD', 'HKD'].every(currency =>
      rates.some(rate => rate.base === 'CNY' && rate.quote === currency && Number.isFinite(rate.rate) && rate.rate > 0))) {
      throw new Error('Invalid exchange rates')
    }
    exchangeRates = rates
    exchangeFetchedAt = Date.now()
    exchangeRetryAt = 0
    exchangeError = undefined
    return exchangeRates
  }).catch((error: unknown) => {
    exchangeError = error instanceof Error ? error.message : String(error)
    exchangeRetryAt = Date.now() + 60000
    if (exchangeRates.length) return exchangeRates
    throw error
  }).finally(() => { exchangeRequest = undefined })
  return exchangeRequest
}
