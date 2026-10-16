# dsh-token-dashboard

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 的用量看板：把**账户余额**、**Token 使用量**和**花费**放在一个页面里，按天、按模型、按工作区看清钱花在哪。

数据全部来自本地 —— 会话日志 + DeepSeek 官方余额接口，不需要额外的云端账号。

## 截图

<table>
<tr>
<td width="33%"><img src="docs/screenshot-overview.png" alt="用量看板全貌"></td>
<td width="33%"><img src="docs/screenshot-usage.png" alt="Token 使用量与成本构成"></td>
<td width="33%"><img src="docs/screenshot-activity.png" alt="用量分布与活跃度"></td>
</tr>
<tr>
<td valign="top">设置 → 用量看板，顶部切换时间范围或导出数据。</td>
<td valign="top">成本按三档计费拆分，右侧对齐显示 tokens、占比、金额。</td>
<td valign="top">按工作区的占比与每日曲线，以及整年活跃度热力图。</td>
</tr>
</table>

## 功能

**余额**
- 实时账户余额（DeepSeek 官方接口，自动识别 CNY / USD），可强制刷新。

**用量**
- 今日 / 本月 / 总计三张卡片，加请求数、缓存命中率、会话数。
- 全局时间范围：近 7 天 / 近 30 天 / 全部。

**花费**
- 按 DeepSeek 的三档计费分别算出金额：**缓存命中输入、缓存未命中输入、输出**。三者单价最多差 30 倍，只看总数看不出钱花在哪。
- 支持峰谷价：高峰为周一至周五 09:00–12:00、14:00–18:00，空闲时段减半。

**分布与趋势**
- 用量分布可切换**按模型 / 按工作区**，以及**按 Token / 按成本**，配占比条。
- 每种分组各画一条**每日平滑曲线**，直接看出谁在什么时候用得多。

**活跃度**
- 整年热力图（53 周 × 7 天，行对齐真实星期），鼠标移上去显示当天日期、Token 与花费。

**明细与导出**
- 按模型明细表（请求数 + 三档花费），最近会话列表。
- 一键导出 CSV / JSON。

## 安装

```bash
dsh plugin --profile <profile> add @astralux/dsh-token-dashboard
```

装完**刷新网页**，看板出现在 **设置 → 用量看板**。

也可以从 GitHub 或本地目录安装：

```bash
dsh plugin --profile <profile> add github:LynnChrysteiin/dsh-token-dashboard
dsh plugin --profile <profile> add /本仓库的绝对路径
```

## 使用

1. 打开 **设置 → 用量看板**。
2. 顶部选时间范围（近 7 天 / 近 30 天 / 全部）。
3. 在「用量分布」里切换按模型 / 按工作区、按 Token / 按成本。
4. 鼠标移到热力图格子上看某一天的具体用量。
5. 需要留档就点「导出 CSV / 导出 JSON」。

## 配置

不用配置即可使用。想改的话，host 半在 `lib/index.js` 里读这几个值：

| 项 | 默认 | 说明 |
|---|---|---|
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话日志目录 |
| `balanceCacheMs` | `300000` | 余额缓存时长（5 分钟） |
| `sweepIntervalMs` | `60000` | 统计刷新间隔 |

改价格：编辑 `lib/index.js` 里的 `MODEL_PRICES`（元/百万 tokens，含峰谷两组）。

## 说明

- **余额显示「未配置 DeepSeek API Key」**：说明你用的是账号态登录而不是 API Key。余额卡片会空着，**Token 与花费统计不受影响**（它们来自本地会话日志）。
- **没有构建步骤**：两半都是纯 JavaScript，无依赖。改 `lib/client.js` 刷新页面即可，改 `lib/index.js` 需要重启 DSH。

## 来源

Fork 自 [lyk308/dsh-token-dashboard](https://github.com/lyk308/dsh-token-dashboard)，MIT 许可，原作者 [@lyk308](https://github.com/lyk308)。本仓库在其基础上修好了 dsh 0.2.0-rc.2 的兼容问题（原版在这个版本上所有数字都读成 0），并做了上面这些扩展。

## 许可证

[MIT](./LICENSE)
