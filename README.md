# dsh-token-dashboard

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

A DeepSeek Harness plugin that puts your **real-time account balance**, **token usage**, and **cost breakdown** on one dashboard. Local-first: it reads your DSH session logs and the DeepSeek `/user/balance` API, and needs no extra cloud account — it reuses your existing DeepSeek key.

> **This is a fork.** Original work: [lyk308/dsh-token-dashboard](https://github.com/lyk308/dsh-token-dashboard) (MIT). See [Origin and changes](#origin-and-changes) for what this fork changes and why.

## Origin and changes

Forked from [`lyk308/dsh-token-dashboard`](https://github.com/lyk308/dsh-token-dashboard) v0.1.6, MIT licensed, by [@lyk308](https://github.com/lyk308). The original plugin reads zero for every figure on dsh 0.2.0-rc.2; this fork restores that and extends the dashboard.

Compatibility fixes (each one alone was enough to blank the dashboard):

- **Session logs were never found.** `findSessionLogs` matched `session.jsonl[.zstd]`, but dsh 0.2.0-rc.2 writes `session.v4.jsonl.zstd`. The pattern now accepts an optional `.v<N>` segment.
- **Usage was read from the wrong place.** The reader only looked at `data.chunk.usage` (the older streaming shape); committed `assistant/message` events carry it at `data.usage`.
- **Cost and the per-day view had the same assumption on a separate code path**, which zeroed cost, the daily buckets, the today/this-month cards and the workspace split while totals still counted.

Added on top:

- **Cost split by billing bucket** — cache-hit input, cache-miss input, and output priced separately (they differ by up to 30×, so a single total hides where the money goes).
- **Full-year activity heatmap** — 53 columns × 7 days, rows aligned to real weekdays, month labels, instant hover tooltip.
- **Per-group smooth-curve timeline** — one curve per model or workspace over the selected window.
- **Corrected cache hit rate** — now `cacheRead / (cacheRead + input)`; it previously divided by all tokens including output.

## Features

- **Account balance** — live balance from the DeepSeek official `/user/balance` API (CNY/USD aware), with force-refresh.
- **Token usage** — Today / This month / All-time cards, plus request count, cache hit rate, and session count.
- **Cost breakdown** — every figure split into DeepSeek's three billing buckets (cache-hit input / cache-miss input / output) with tokens, share of spend, and amount in aligned columns.
- **Peak/off-peak pricing** — DeepSeek V4 rates, peak = Mon–Fri 09:00–12:00 & 14:00–18:00 (off-peak is half).
- **Usage distribution** — toggle **by model** / **by workspace** and **by token** / **by cost**, with a proportional share bar (top 8 + an "其他" aggregate) and a per-group daily timeline below it. Curves are smooth, not polylines.
- **Activity heatmap** — a full year as a contribution-style grid, with an instant tooltip showing each day's date, tokens and cost.
- **Model breakdown** — Req plus the three cost buckets per model; hover a cell for its raw token count.
- **Recent sessions** — per-session total / cost / model / time, sorted by most recent activity.
- **Global time window** — switch the dashboard between 近7天 / 近30天 / 全部 (Today / This-month stay fixed).
- **Export** — one-click download of the current stats as **CSV** or **JSON**.

## Installation

This is a standard DSH bundle plugin, so install it with the official CLI:

```bash
# From GitHub
dsh plugin --profile <profile> add github:LynnChrysteiin/dsh-token-dashboard

# From npm
dsh plugin --profile <profile> add @astralux/dsh-token-dashboard

# From a local checkout (development)
dsh plugin --profile <profile> add /absolute/path/to/this/repo
```

After installing, **refresh the web UI**. The dashboard appears under **Settings → 用量看板** (Usage Dashboard).

> Note: the plugin reads the DeepSeek API key from DSH's credentials service (`DEEPSEEK_API_KEY`). Without a valid key the balance card shows a hint; token usage still works because it comes from local session logs.

## Usage

1. Open **Settings → 用量看板**.
2. In the top bar, pick a **time window** (近7天 / 近30天 / 全部).
3. Switch the share bar and its timeline between **by model / by workspace** and **by token / by cost**.
4. Hover any heatmap cell for that day's date, tokens and cost.
5. Use **导出 CSV / 导出 JSON** to download the current stats.

## Configuration

The plugin works out of the box. The host half resolves sensible defaults in `lib/index.js`:

- `sessionsRoot` — defaults to `$DSH_HOME/sessions`.
- `balanceCacheMs` — balance cache TTL (default 300000 ms = 5 min).
- `sweepIntervalMs` — stats refresh interval (default 60000 ms).

> Cost estimation uses DeepSeek's official V4 pricing (CNY per 1,000,000 tokens) with peak/off-peak billing. Prices live in the `MODEL_PRICES` map in `lib/index.js` — edit it if DeepSeek changes prices. Moving them into the plugin Config so a profile patch can override them is a known improvement.

## Development

- `lib/index.js` — host half: session scanning (multi-frame zstd), token aggregation, per-bucket cost, per-window filtering, balance proxy.
- `lib/client.js` — client half: the settings.section UI, smooth-curve chart, year heatmap, export, share toggles.

Both halves are plain JavaScript with no build step. Edit `lib/client.js` → refresh the page. Edit `lib/index.js` → restart the DSH process.

## License

[MIT](./LICENSE). Original copyright belongs to the upstream author; this fork keeps the same license and the original `LICENSE` file.
