import axios from 'axios'
const underscoreToCamelCase = (str) => {
  str = str.toLowerCase()
  const result = str.replace(/_([a-z])/g, (p, m) => m.toUpperCase())
  return result
}

let cachedCookies = null
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
function parseCookies(setCookieArray) {
  const cookies = {}
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


function getRealtimeQuote(symbolList, config = {}) {
  const BATCH_SIZE = 50

  // 将股票代码列表分成多个批次
  const batches = []
  for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
    batches.push(symbolList.slice(i, i + BATCH_SIZE))
  }

  return getCookie().then(cookies => {
    // 创建所有批次的请求
    const requests = batches.map(batch => {
      const symbol = batch.join(',')
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
        const quoteMap = {}
        res.data.data.forEach((item) => {
          const quote = { ...item }
          quoteMap[item.symbol] = quote
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


getRealtimeQuote(["SH600938",
    "SZ002648",
    "SH603043",
    "SH601919",
    "SZ300499",
    "SZ002837",
    "SZ301018",
    "SH601857",
    "00857",
    "SZ000807",
    "SZ000878",
    "SZ000630",
    "SZ159805",
    "SZ300058",
    "SZ000100",
    "SH603290",
    "SH600460",
    "SH603667",
    "SZ002050",
    "SZ301313",
    "SZ002229",
    "SH601866",
    "SH600152",
    "SH601872",
    "SZ000786",
    "SZ300308",
    "SZ300502",
    "SZ000595",
    "SZ002394",
    "SH600499",
    "SH600936",
    "SZ002579"]).then(res => {
      console.log(res)
    })