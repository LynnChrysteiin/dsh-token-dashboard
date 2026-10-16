# dsh-token-dashboard

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

一个 DeepSeek Harness 插件，把**实时账户余额**、**Token 使用量**和**成本拆分**整合在一个看板上。本地优先：读取你的 DSH 会话日志 + DeepSeek 官方 `/user/balance` 接口，无需额外云端账号（沿用你已有的 DeepSeek key）。

> **这是一个 fork。** 原始项目：[lyk308/dsh-token-dashboard](https://github.com/lyk308/dsh-token-dashboard)（MIT）。改动内容与原因见下。

## 来源与改动

Fork 自 [`lyk308/dsh-token-dashboard`](https://github.com/lyk308/dsh-token-dashboard) v0.1.6，MIT 许可，作者 [@lyk308](https://github.com/lyk308)。原版在 dsh 0.2.0-rc.2 上**所有数字都读成 0**；本 fork 修复了这一点并做了扩展。

兼容性修复（每一处单独存在都足以让看板全空）：

- **会话日志根本没被找到。** `findSessionLogs` 匹配的是 `session.jsonl[.zstd]`，但 dsh 0.2.0-rc.2 写的是 `session.v4.jsonl.zstd`。现在正则接受可选的 `.v<N>` 段。
- **usage 读错位置。** 原代码只读 `data.chunk.usage`（旧的流式形状），而提交后的 `assistant/message` 事件把它放在 `data.usage`。
- **成本与按天视图在另一条代码路径上有同样的假设**，导致 cost、每日桶、今日/本月卡片和工作区拆分全为 0，而总量却有数。

在修复之上新增：

- **按计费档位拆分成本** —— 缓存命中输入、缓存未命中输入、输出分别计价（单价差最多 30 倍，合计看不出钱花在哪）。
- **整年活跃度热力图** —— 53 列 × 7 天，行对齐真实星期，带月份标签与即时悬停提示。
- **分组趋势曲线** —— 按模型或按工作区，在所选窗口上各画一条平滑曲线。
- **修正缓存命中率** —— 现在是 `cacheRead / (cacheRead + input)`；原实现除以全部 token（含输出）。

## 功能

- **账户余额** —— DeepSeek 官方 `/user/balance` 实时获取（自动识别 CNY/USD），支持强制刷新。
- **Token 使用量** —— 今日 / 本月 / 总计三卡，加请求数、缓存命中率、会话数。
- **成本构成** —— 每个数字拆成 DeepSeek 的三个计费档位（缓存命中输入 / 未命中输入 / 输出），tokens、占比、金额分列对齐。
- **峰谷定价** —— DeepSeek V4 官方价格，高峰 = 周一至周五 09:00–12:00、14:00–18:00（空闲时段减半）。
- **用量分布** —— 可切换**按模型 / 按工作区**与**按 Token / 按成本**，带占比条（前 8 项 + 「其他」聚合），下方是该分组的每日时间轴曲线。曲线是平滑曲线，不是折线。
- **活跃度热力图** —— 整年贡献图式网格，悬停即时显示当天日期、Token 与花费。
- **按模型明细** —— 每个模型的 Req 与三档成本；悬停单元格可见原始 token 数。
- **最近会话** —— 按活跃时间排序，展示每次会话的 token / 成本 / 模型 / 时间。
- **全局时间窗口** —— 一键切换近7天 / 近30天 / 全部（今日、本月保持不变）。
- **数据导出** —— 一键导出当前统计为 **CSV** 或 **JSON**。

## 安装

这是一个标准 DSH bundle 插件，用官方 CLI 安装：

```bash
# 从 GitHub
dsh plugin --profile <profile> add github:LynnChrysteiin/dsh-token-dashboard

# 从 npm
dsh plugin --profile <profile> add @lynnchrysteiin/dsh-token-dashboard

# 从本地检出（开发用）
dsh plugin --profile <profile> add /本仓库的绝对路径
```

安装后**刷新网页**。看板位于 **设置 → 用量看板**。

> 说明：插件从 DSH 的凭据服务读取 DeepSeek API Key（`DEEPSEEK_API_KEY`）。没有有效 key 时余额卡片显示引导文案；Token 用量仍可正常统计（来自本地会话日志）。

## 使用方法

1. 打开 **设置 → 用量看板**。
2. 顶部选择**时间范围**（近7天 / 近30天 / 全部）。
3. 切换占比条与曲线的 **按模型 / 按工作区** 以及 **按 Token / 按成本**。
4. 悬停热力图任意格子，查看当天日期、Token 与花费。
5. 点 **导出 CSV / 导出 JSON** 下载当前统计数据。

## 配置

插件开箱即用，host 半在 `lib/index.js` 里解析合理默认值：

- `sessionsRoot` —— 默认为 `$DSH_HOME/sessions`。
- `balanceCacheMs` —— 余额缓存时长（默认 300000 毫秒 = 5 分钟）。
- `sweepIntervalMs` —— 统计刷新间隔（默认 60000 毫秒）。

> 成本估算使用 DeepSeek 官方 V4 定价（元/百万 tokens），按峰谷计费。价格定义在 `lib/index.js` 的 `MODEL_PRICES`，可随 DeepSeek 调价而修改。把它们挪进插件 Config 以便用 profile patch 覆盖，是一个已知的待办改进。

## 开发

- `lib/index.js` —— host 半：会话扫描（多帧 zstd）、Token 聚合、分档成本、窗口过滤、余额代理。
- `lib/client.js` —— client 半：settings.section 界面、平滑曲线图、整年热力图、导出、占比切换。

两半都是纯 JavaScript，**没有构建步骤**。改 `lib/client.js` → 刷新页面即可；改 `lib/index.js` → 需要重启 DSH。

## 许可证

[MIT](./LICENSE)。原始版权归上游作者所有；本 fork 沿用同一许可并保留原始 `LICENSE` 文件。
