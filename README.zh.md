# dsh-token-dashboard

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

一个 DeepSeek Harness 插件，把**实时账户余额**、**Token 使用量**和**成本估算**整合在一个看板上。本地优先：读取你的 DSH 会话日志 + DeepSeek 官方 `/user/balance` 接口，无需额外云端账号（沿用你已有的 DeepSeek key）。

## 效果预览

![用量看板](https://raw.githubusercontent.com/lyk308/dsh-token-dashboard/main/docs/screenshot.png)

![Token 用量与模型](https://raw.githubusercontent.com/lyk308/dsh-token-dashboard/main/docs/screenshot2.png)

## 功能

- 💰 **账户余额** — 通过 DeepSeek 官方 `/user/balance` 接口实时获取（自动识别 CNY/USD），支持强制刷新。
- 📊 **Token 使用量** — 今日 / 本月 / 总计三卡，加请求数、缓存命中率、会话数。
- 💵 **成本估算** — 精确的 DeepSeek V4 定价，**区分峰谷时段**，按模型成本，以及 今日/本月/总计 花费。
- 📈 **用量分布** — 可在**按模型 / 按工作区**之间切换，也支持**按 Token / 按成本**。带比例占比条（前 8 项 + 「其他」聚合），百分比与占比条完全一致。
- 📉 **每日趋势** — 可交互的 mini 面积图（网格 + 坐标轴 + 日期标注），展示每日成本或 Token，鼠标悬停显示单日数值。
- 🗓 **活跃度热力图** — 30 / 90 / 180 天切换，绿色深浅映射 Token 用量。
- 🤖 **按模型明细** — 每个模型的 Req / Input / Cache / Output / Cost 表格。
- 🗂 **最近会话** — 按活跃时间排序，展示每次会话的 token / 成本 / 模型 / 时间。
- 📅 **全局时间窗口** — 一键切换整个看板的统计范围：近7天 / 近30天 / 近90天 / 全部（「今日 / 本月」保持不变）。
- 📤 **数据导出** — 一键导出当前统计为 **CSV** 或 **JSON**。

## 安装

这是一个标准 DSH bundle 插件，用官方 CLI 安装：

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:lyk308/dsh-token-dashboard

# 从 npm 安装
dsh plugin --profile web add @lyk308/dsh-token-dashboard
```

安装后**刷新网页**即可。看板位于 **设置 → 用量看板**。

> 说明：插件从 DSH 的凭据服务读取 DeepSeek API Key（`DEEPSEEK_API_KEY`）。没有有效 key 时余额卡片显示引导文案；Token 用量仍可正常统计（来自本地会话日志）。

## 使用方法

1. 打开 **设置 → 用量看板**。
2. 顶部选择**时间范围**（近7天 / 30天 / 90天 / 全部）。
3. 切换占比条的 **按模型 / 按工作区** 以及 **按 Token / 按成本**。
4. 在趋势图上**悬停**，查看某一天的数值。
5. 点 **导出 CSV / 导出 JSON** 下载当前统计数据。

## 配置

插件基本无需配置即可使用，host 半在 `lib/index.js` 里解析合理默认值：

- `sessionsRoot` — 默认为 `$DSH_HOME/sessions`。
- `balanceCacheMs` — 余额缓存时长（默认 300000 毫秒 = 5 分钟）。
- `sweepIntervalMs` — 统计刷新间隔（默认 60000 毫秒）。

> 成本估算使用 DeepSeek 官方 V4 定价（元/百万 tokens），按峰谷计费：高峰 = 周一至周五 09:00-12:00、14:00-18:00（空闲时段减半）。价格定义在 `lib/index.js` 的 `MODEL_PRICES`，可随 DeepSeek 调价而修改。

## 开发

- `lib/index.js` — host 半：会话扫描（多帧 zstd）、Token 聚合、成本估算、时间窗口过滤、余额代理。
- `lib/client.js` — client 半：settings.section 界面、趋势图、数据导出、占比切换。

改 `lib/client.js` → 刷新页面即可看到变化。改 `lib/index.js` → 重启 DSH web profile。

## 许可证

[MIT](./LICENSE)
