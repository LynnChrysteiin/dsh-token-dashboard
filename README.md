# dsh-token-dashboard

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

A DeepSeek Harness plugin that puts your **real-time account balance**, **token usage**, and **cost estimation** on one dashboard. Local-first: reads your DSH session logs and the DeepSeek `/user/balance` API. No extra cloud account — it reuses your existing DeepSeek key.

## Screenshots

![Dashboard](https://raw.githubusercontent.com/lyk308/dsh-token-dashboard/main/docs/screenshot.png)

![Token usage & models](https://raw.githubusercontent.com/lyk308/dsh-token-dashboard/main/docs/screenshot2.png)

## Features

- 💰 **Account balance** — live balance from the DeepSeek official `/user/balance` API (CNY/USD aware), with force-refresh.
- 📊 **Token usage** — Today / This month / All-time cards, plus request count, cache hit rate, and session count.
- 💵 **Cost estimation** — accurate DeepSeek V4 pricing, **peak/off-peak aware**, per-model cost, and Today / This month / All-time spend.
- 📈 **Usage distribution** — toggle **by model** / **by workspace**, and **by token** / **by cost**. Proportional share bar (top 8 + "其他" aggregate). Percentages match the bar exactly.
- 📉 **Daily trend** — an interactive mini area chart (grid + axes + date labels) of daily cost or tokens, with hover tooltips per day.
- 🗓 **Activity heatmap** — 30 / 90 / 180-day switch; green-shade intensity maps token usage.
- 🤖 **Model breakdown** — a table of Req / Input / Cache / Output / Cost per model.
- 🗂 **Recent sessions** — per-session total / cost / model / time, sorted by most recent activity.
- 📅 **Global time window** — switch the whole dashboard between 近7天 / 近30天 / 近90天 / 全部 (Today / This-month stay fixed).
- 📤 **Export** — one-click download of the current stats as **CSV** or **JSON**.

## Installation

This is a standard DSH bundle plugin, so install it with the official CLI:

```bash
# From GitHub
dsh plugin --profile web add github:lyk308/dsh-token-dashboard

# From npm
dsh plugin --profile web add @lyk308/dsh-token-dashboard
```

After installing, **refresh the web UI**. The dashboard appears under **Settings → 用量看板** (Usage Dashboard).

> Note: the plugin reads the DeepSeek API key from DSH's credentials service (`DEEPSEEK_API_KEY`). Without a valid key the balance card shows a hint; token usage still works because it comes from local session logs.

## Usage

1. Open **Settings → 用量看板**.
2. In the top bar, pick a **time window** (近7天 / 30天 / 90天 / 全部).
3. Switch the share bar between **by model / by workspace** and **by token / by cost**.
4. Hover the trend chart to see a single day's value.
5. Use **导出 CSV / 导出 JSON** to download the current stats.

## Configuration

The plugin works out of the box. The host half resolves sensible defaults in `lib/index.js`:

- `sessionsRoot` — defaults to `$DSH_HOME/sessions`.
- `balanceCacheMs` — balance cache TTL (default 300000 ms = 5 min).
- `sweepIntervalMs` — stats refresh interval (default 60000 ms).

> Cost estimation uses DeepSeek's official V4 pricing (CNY per 1,000,000 tokens) with peak/off-peak billing: peak = Mon–Fri 09:00–12:00 & 14:00–18:00 (off-peak is half price). Prices live in the `MODEL_PRICES` map in `lib/index.js` — edit it if DeepSeek changes prices.

## Development

- `lib/index.js` — host half: session scanning (multi-frame zstd), token aggregation, cost estimation, per-window filtering, balance proxy.
- `lib/client.js` — client half: the settings.section UI, trend chart, export, share toggles.

Edit `lib/client.js` → refresh the page to see changes. Edit `lib/index.js` → restart the DSH web profile.

## License

[MIT](./LICENSE)
