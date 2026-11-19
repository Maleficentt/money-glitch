# money-glitch

* Real-time stock quotes
* Position profit and loss statistics

## Features

![持仓](./feature_position.png)

## Requirements

* vscode version at least 1.120.0

## Extension Settings

This extension contributes the following settings:

* `moneyGlitch.stockSymbols`: List of stock symbol.
* `moneyGlitch.statusBarStockSymbols`: List of stock symbol in statusBar.
* `moneyGlitch.position`: stock position detail
* `moneyGlitch.monthlyProfit`: 已结算的 A 股月度收益。手动调整此值会作为当月余额调整保留。
* `moneyGlitch.showMonthlyProfit`: 是否在状态栏及悬浮提示中显示月收益，默认 `true`。设为 `false` 后立即隐藏月收益，自动结算和保存仍正常运行。

## 持仓金额显示

持仓页、自选页的持仓标签及状态栏持仓汇总统一以人民币显示金额。非人民币股票的现价、成本、持仓市值及持仓表中的其他行情金额使用同一缓存汇率换算；盈亏已按人民币计算，不会重复换汇。股数、成交量和涨跌幅保持原单位。缺少汇率时显示 `--` 并提示统计不完整，过期缓存会明确提示。买卖价格和持仓成本的编辑仍按股票原币输入，表单会标明币种。

## 当日盈亏比例

当日盈亏比例统一按 `当日盈亏 ÷（日初持仓市值 + 当日买入金额及买入费用）× 100%` 计算。日初股数由当前股数减去当日买入、加上当日卖出还原，再按昨收价计值；当日卖出或清仓不会扣减该基数。单股、持仓页汇总及状态栏使用相同口径，汇总前先将金额换算为人民币。基数无效或缺少必要数据时比例显示 `--`。该比例不包含账户现金；多次买入会累计买入投入，包括用卖出所得再次买入的部分。

## 港股通费用

`moneyGlitch.broker` 中的每个券商支持 `hkStockConnect` 配置。选择券商后，香港股票（`region` 或 `exchange` 为 `HK`）按港股通逐笔计费，适用于港币成交；其他市场继续使用原有规则。选择“无”仍表示零费用估算。项目目前没有单独区分香港本地券商账户与港股通账户，不应将该分支作为直接港股账户的收费表。

以下子配置可添加到现有券商对象中。佣金万三、最低 5 元人民币仅为示例，请替换成账户的净佣金协议（不含下面单列的税费），避免重复计费：

```json
{
  "hkStockConnect": {
    "commissionRate": 0.0003,
    "minCommission": 5,
    "minimumCommissionCurrency": "CNY",
    "stampTaxRate": 0.001,
    "tradingFeeRate": 0.0000565,
    "transactionLevyRate": 0.000027,
    "afrcLevyRate": 0.0000015,
    "settlementFeeRate": 0.000042
  }
}
```

没有新增子配置的旧券商也会使用上述港股通税费默认值。`commissionRate` 未填时沿用该券商原佣金率，`minCommission` 未填时沿用原股票或 ETF 最低佣金；默认最低佣金币种为 **HKD**，这是兼容旧计算的默认口径，不代表已核实账户的港股通佣金。最低佣金实际为人民币时需明确设置 `minimumCommissionCurrency: "CNY"`，计算时按现有 HKD/CNY 汇率折算成港元。

普通股票买卖均收印花税，并向上取整到港元；ETF（行情类型 `13`）免印花税。交易费、证监会交易征费、会财局交易征费及股份交收费分别四舍五入至港元小数点后两位，再与佣金相加。例如，普通股票成交 10,000 港元，税费为 `10 + 0.57 + 0.27 + 0.02 + 0.42 = 11.28` 港元，另加佣金。股份交收费采用中国结算港股通的 0.0042%，没有旧的 2 港元最低收费或 100 港元上限。

新交易记录会保存后端算出的 `fees`（成交币种）快照，买卖成本与当日盈亏使用同一笔费用；之后修改券商配置或估值汇率不会改写该快照。旧记录没有快照时按当前配置估算。每条交易记录独立计费；若交割单将分笔成交合并计费，应相应归并录入。

这里计算的是逐笔交易费用，不含按持仓日计收的证券组合费。人民币最低佣金换算及持仓估值仍使用项目的汇率缓存，未接入中国结算实际港股通结算汇兑比率，因此属于费用估算。

费率依据：[上交所港股通交易税费](https://www.sse.com.cn/services/charge/hkexsc/)、[中国结算深圳市场收费表（2026-01-01 更新）](https://www.chinaclear.cn/zdjs/fbzyls/202512/a59388fbfa714c5fa546784891a42e30/files/深圳市场证券登记结算业务收费及代收税费一览表.pdf)。

## 收盘结算与补录

扩展运行时，收到当日 A 股收盘行情后，按日期、股票保存收益记录，并更新 `monthlyProfit`。持仓即使移出自选，仍会获取行情。缺少某只股票的行情不会阻止其他股票结算，状态栏提示尚待结算的股票；后续刷新补齐记录，同日行情或交易修正会替换原记录，不会重复累计。

每月独立累计，月初显示从零开始。状态栏月收益包含本月已结算金额及当日尚未结算的 A 股盈亏，不包含港美股。账本保存在扩展全局存储目录的 `monthly-profit-ledger.json` 中，同一存储目录下的多个窗口共用账本，结算和补录串行执行。首次运行会迁移原有本地账本；没有账本时，以原配置金额作为期初余额。

`monthlyProfit` 使用用户级配置，仍可手动调整。内部配置 `monthlyProfitRevision` 用于识别自动写入及延迟通知，请勿手动修改。升级后请重新加载所有 VS Code 窗口，以免旧版本继续写入。此前已经重复累计的金额不会自动回滚；确认正确总额后，可手动修正用户设置中的 `moneyGlitch.monthlyProfit`。

扩展关闭期间不会后台获取历史行情。可在命令面板执行 **Money Glitch: 补录/修正每日收益**，输入日期及该日 A 股总盈亏。该操作替换该日自动记录，后续刷新保留手动金额；重复输入同一日期可再次修正。旧版迁移余额缺少逐日明细，已包含在其中的日期请通过调整 `monthlyProfit` 总额修正。

## 开发验证

运行 `npm test` 执行编译、lint 和不依赖行情网络的回归测试，覆盖交易校验、行情重试、市场调度、收益结算及缓存等场景。

## Known Issues


## Release Notes

### 1.0.0

* stock crud
* position crud
* profit statistic

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
