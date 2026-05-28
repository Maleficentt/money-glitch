/**
 * 判断A股股票代码是否为ETF
 * @param {string} code - 股票代码，支持格式："510050"、"SH.510050"、"sz.159915"等
 * @returns {boolean} - true表示是ETF，false表示不是ETF
 */
export default function isETF(code: string | number): boolean {
  // 提取纯数字代码（去除市场前缀）
  const numericCode = String(code).replace(/^[A-Za-z]*\.?/, '')

  // 必须是6位数字
  if (!/^\d{6}$/.test(numericCode)) {
    return false
  }

  // 提取前两位或前三位作为判断依据
  const prefix2 = numericCode.substring(0, 2)
  const prefix3 = numericCode.substring(0, 3)

  // 上海交易所 (SH) - 51、58开头
  if (prefix2 === '51') {
    // 510xxx-519xxx 都是ETF
    return true
  }
  if (prefix2 === '58') {
    // 580xxx-589xxx 都是ETF
    return true
  }
  if (prefix2 === '56') {
    // 56开头：部分为ETF，需要进一步判断常见ETF代码段
    // 常见ETF: 560010, 561010, 562000, 563000等大部分是ETF
    // 但有些LOF也用56开头，因此这里返回true（或可设为false，按需调整）
    // 保守做法：仅当特定范围返回true
    const etf56Prefixes = ['560', '561', '562', '563', '564', '565', '566', '567', '568', '569']
    return etf56Prefixes.includes(prefix3)
  }

  // 深圳交易所 (SZ) - 159开头全部是ETF
  if (prefix3 === '159') {
    return true
  }

  // 16开头不是ETF（LOF或封闭基金）
  if (prefix2 === '16') {
    return false
  }

  // 其他情况默认不是ETF
  return false
}