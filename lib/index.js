/**
 * dsh-token-dashboard — host half.
 *
 * Aggregates token usage from DSH persistent session logs (multi-frame zstd
 * JSONL), and proxies DeepSeek `/user/balance` for the account balance card.
 *
 * Runtime contract (dsh bundle host plugin):
 *   - default export = the Cordis plugin (a function `(ctx, config) => {...}`).
 *   - `inject` = required services: `webServer` (route registration) and
 *     `credentials` (DeepSeek API key resolution).
 *
 * The browser half rides `dsh.client` manifest; this file only owns the node
 * half: session scan + aggregated statistics + balance proxy, exposed as a few
 * JSON routes under `/api/token-dashboard/*`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { zstdDecompressSync, createZstdDecompress } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";

const ZSTD_MAGIC = 0xfd2fb528; // bytes 28 b5 2f fd (little-endian)

// ---- DeepSeek V4 pricing (CNY per 1,000,000 tokens) ----
// Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// Prices are peak/off-peak. Off-peak = half of peak. Peak = Mon–Fri 09:00–12:00, 14:00–18:00.
// deepseek-v4-flash and deepseek-v4-flash-vision-exp share the same price.
const MODEL_PRICES = {
	"deepseek-v4-flash": { cacheHit: [0.05, 0.10], cacheMiss: [1.5, 3.0], output: [4.5, 9.0] },
	"deepseek-v4-flash-vision-exp": { cacheHit: [0.05, 0.10], cacheMiss: [1.5, 3.0], output: [4.5, 9.0] },
	"deepseek-v4-pro": { cacheHit: [0.15, 0.30], cacheMiss: [4.5, 9.0], output: [13.5, 27.0] }
};
// Fallback for any model not in the table (use flash's price).
const FALLBACK_PRICE = MODEL_PRICES["deepseek-v4-flash"];

/**
 * Whether the given timestamp falls in DeepSeek's peak period.
 * Peak = Mon–Fri 09:00–12:00 and 14:00–18:00 (Beijing time / local device time).
 * @param {number|null} timeMs - epoch milliseconds of the event.
 * @returns {boolean}
 */
function isPeakTime(timeMs) {
	if (!timeMs) return false;
	const d = new Date(timeMs);
	const dow = d.getDay(); // 0=Sun .. 6=Sat
	if (dow === 0 || dow === 6) return false; // weekends are off-peak
	const mins = d.getHours() * 60 + d.getMinutes();
	// 09:00-12:00 => 540-720 ; 14:00-18:00 => 840-1080
	return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080);
}

/**
 * Break one usage event's cost into the three DeepSeek billing buckets.
 *
 * DeepSeek charges cache-hit input, cache-miss input, and output at three
 * different rates (and each rate halves off-peak), so a single total cannot be
 * attributed back to a bucket after the fact. Reasoning tokens are billed as
 * output and are folded into `output`.
 *
 * @param {{input:number, output:number, cacheRead:number, reasoning?:number}} t
 * @param {number|null} timeMs
 * @param {string} model
 * @returns {{cacheHit:number, cacheMiss:number, output:number, total:number}}
 */
function costParts(t, timeMs, model) {
	const p = MODEL_PRICES[model] || FALLBACK_PRICE;
	const peak = isPeakTime(timeMs) ? 1 : 0;
	const cacheHit = ((t.cacheRead || 0) * p.cacheHit[peak]) / 1e6;
	const cacheMiss = ((t.input || 0) * p.cacheMiss[peak]) / 1e6;
	const output = ((t.output || 0) + (t.reasoning || 0)) * p.output[peak] / 1e6;
	return { cacheHit, cacheMiss, output, total: cacheHit + cacheMiss + output };
}

/**
 * Compute the CNY cost of one usage event given its token breakdown + timestamp.
 * @param {{input:number, output:number, cacheRead:number}} t
 * @param {number|null} timeMs
 * @param {string} model
 * @returns {number}
 */
function costOf(t, timeMs, model) {
	return costParts(t, timeMs, model).total;
}

/**
 * Format a timestamp as its LOCAL calendar day, `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0,10)`: that is the UTC day, and mixing
 * it with locally-walked day windows shifts every bucket by one day east of
 * UTC. Day attribution should match the wall clock the user reads.
 *
 * @param {Date|number} value
 * @returns {string}
 */
function localDayKey(value) {
	const d = value instanceof Date ? value : new Date(value);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Add one event's three cost buckets onto any accumulator carrying them.
 * One helper keeps the day / workspace / model / session / total views from
 * drifting apart, which is exactly what happened when each site summed its own.
 * @param {object} target
 * @param {{cacheHit:number, cacheMiss:number, output:number, total:number}} parts
 */
function addCost(target, parts) {
	if (parts === undefined) return;
	target.cost = (target.cost || 0) + parts.total;
	target.costCacheHit = (target.costCacheHit || 0) + parts.cacheHit;
	target.costCacheMiss = (target.costCacheMiss || 0) + parts.cacheMiss;
	target.costOutput = (target.costOutput || 0) + parts.output;
}

/**
 * Split a zstd buffer into its constituent frames. DSH writes multi-frame zstd
 * (one frame per chunk). We walk frame headers to find each frame boundary by
 * scanning for the next magic; each slice is one complete zstd frame, which
 * `zstdDecompressSync` decodes independently.
 * @param {Buffer} buf
 * @returns {{start:number,end:number}[]}
 */
function splitZstdFrames(buf) {
	const frames = [];
	let off = 0;
	while (off < buf.length) {
		if (buf.length - off < 4) break;
		if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break; // torn tail / non-frame
		// frame header descriptor byte
		const fhd = buf.readUInt8(off + 4);
		let hdrLen = 5;
		if (fhd & 0x01) hdrLen += 1; // window descriptor present
		const didBits = (fhd >> 1) & 0x3;
		hdrLen += [0, 1, 2, 4][didBits]; // dict id length
		const fcs = fhd & 0x08;
		if (fcs) {
			const low = buf.readUInt8(off + hdrLen);
			if (low === 0xff) {
				// 8-byte content size (rare in DSH chunked logs); read and skip
				hdrLen += 9;
			} else {
				hdrLen += 1;
			}
		}
		// find next frame magic to bound this frame
		let next = -1;
		for (let i = off + hdrLen; i < buf.length - 3; i++) {
			if (buf.readUInt32LE(i) === ZSTD_MAGIC) { next = i; break; }
		}
		const end = next === -1 ? buf.length : next;
		frames.push({ start: off, end });
		off = end;
	}
	return frames;
}

/**
 * Decompress a (possibly multi-frame) zstd buffer to a UTF-8 string.
 * @param {Buffer} buf
 * @returns {string}
 */
function zstdDecompressToText(buf) {
	// DSH writes MULTI-frame zstd (one frame per chunk). A naive single-shot
	// `zstdDecompressSync(buf)` silently returns only the FIRST frame's bytes on
	// Node, which is why we must always split into frames and decode each one.
	const frames = splitZstdFrames(buf);
	if (frames.length === 0) {
		// fallback: maybe a genuine single-frame buffer whose magic walk failed
		try {
			const out = zstdDecompressSync(buf);
			return out.toString("utf8");
		} catch {
			return "";
		}
	}
	const parts = [];
	for (const { start, end } of frames) {
		try {
			parts.push(zstdDecompressSync(buf.subarray(start, end)));
		} catch {
			// skip a corrupt frame; keep the rest of the log's data
		}
	}
	if (parts.length === 0) return "";
	return Buffer.concat(parts).toString("utf8");
}

/** Normalize a token-usage event into our source-neutral shape.
 *
 * dsh 0.2.0-rc.2 commits `assistant/message` with the record at
 * `data.usage` and the answering model at `data.message.source.model`; older
 * builds carried a streaming `data.chunk.usage`. Both shapes are accepted here,
 * because reading only the streaming one made every counter zero on a current
 * dsh even once the session files were found.
 *
 * @param {boolean} inRange - false skips aggregation (used for window filtering).
 */
function usagesFromEvent(obj, acc, currentModel, timeMs, inRange) {
	if (inRange === false) return;
	if (!obj || typeof obj !== "object") return;
	const data = obj.data;
	if (!data) return;
	const chunk = data.chunk ?? data;
	const usage = data.usage ?? chunk.usage;
	if (!usage || typeof usage !== "object") return;
	// Support both camelCase (DSH) and snake_case (OpenAI) keys.
	const input = usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0;
	const output = usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0;
	const cacheRead = usage.cacheReadTokens ?? usage.cachedTokens ?? usage.cached_tokens ?? 0;
	const reasoning = usage.reasoningTokens ?? usage.reasoning_tokens ?? 0;
	const sum = input + output + cacheRead + reasoning;
	acc.total += sum;
	acc.input += input;
	acc.output += output;
	acc.cacheRead += cacheRead;
	acc.reasoning += reasoning;
	acc.events += 1;
	acc.req += 1;
	acc.cacheHits += cacheRead;
	// per-model attribution: the committed message carries its answering model at
	// data.message.source.model; the streaming shape carried it on the chunk.
	// Store per-model BROKEN-DOWN counters so the UI can render Req/Input/Cache/Output/Total.
	const model = chunk.model || data.model || data.message?.source?.model || obj.model || currentModel || "unknown";
	if (model) {
		let m = acc.byModel[model];
		if (m === undefined) { m = acc.byModel[model] = { req: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0 }; }
		m.req += 1;
		m.input += input;
		m.output += output;
		m.cacheRead += cacheRead;
		m.reasoning += reasoning;
		m.total += sum;
		addCost(m, costParts({ input, output, cacheRead, reasoning }, timeMs, model));
	}
}

/**
 * Recursively walk the sessions root for session log files.
 *
 * dsh 0.2.0-rc.2 writes `session.v4.jsonl.zstd` (the `v4` is the session log
 * format version), while older builds wrote `session.jsonl[.zstd]`. The
 * optional `(\.v\d+)?` segment accepts both, so the dashboard does not read an
 * empty session set — and therefore report zeros for every card — on a current
 * dsh. Anchored so `session.v4.jsonl.zstd.map` and unrelated files never match.
 *
 * @param {string} root
 * @returns {string[]} absolute paths
 */
function findSessionLogs(root) {
	const out = [];
	if (!existsSync(root)) return out;
	const walk = (dir) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
		}
	};
	walk(root);
	return out;
}

/** Aggregate token stats across all session logs under `root`.
 * @param {string} root - sessions directory.
 * @param {number|null} days - if set, byModel/byWorkspace/byDay/bySession are
 *   filtered to events within the last `days` days, while total/cost/today/
 *   thisMonth remain full-window (those are cardinal period facts).
 */
function aggregateTokens(root, days) {
	const acc = {
		total: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0,
		costCacheHit: 0, costCacheMiss: 0, costOutput: 0,
		events: 0, req: 0, cacheHits: 0, sessions: 0, files: 0,
		byModel: {}, byDay: {}, byDayAll: {}, byWorkspace: {}, bySession: {}
	};
	const files = findSessionLogs(root);
	acc.files = files.length;
	const now = new Date();
	// Day and month keys are LOCAL, not UTC. `toISOString()` buckets by UTC day
	// while the client walks local calendar days, so anywhere east of UTC the two
	// disagreed by one day: the window ran to "yesterday" and the most recent day's
	// usage was dropped from the curves entirely. It also meant "Today" counted a
	// UTC day, which after 08:00 in UTC+8 no longer matches the local date.
	const todayKey = localDayKey(now);
	const monthKey = todayKey.slice(0, 7);
	// Range cutoff (epoch ms): events older than this are excluded from the
	// per-group aggregates when `days` is provided. null = no filtering.
	const cutoff = (days && days > 0) ? Date.now() - days * 86400 * 1000 : null;
	for (const file of files) {
		let bytes;
		try { bytes = readFileSync(file); } catch { continue; }
		const text = file.endsWith(".zstd") ? zstdDecompressToText(bytes) : bytes.toString("utf8");
		if (!text) continue;
		acc.sessions += 1;
		// Session id: the parent directory name of each session.jsonl[.zstd].
		// Path shape: .../sessions/<workspace>/<session-id>/session.jsonl[.zstd]
		let sessionId = basename(dirname(file));
		let sRec = acc.bySession[sessionId];
		if (sRec === undefined) { sRec = acc.bySession[sessionId] = { id: sessionId, total: 0, cost: 0, req: 0, first: null, last: null, model: null, workspace: "unknown" }; }
		const lines = text.split("\n");
		let ws = "unknown";
		let currentModel = null;
		for (const line of lines) {
			if (!line) continue;
			let o;
			try { o = JSON.parse(line); } catch { continue; }
			if (o.type === "session" && o.cwd) { ws = o.cwd; sRec.workspace = ws; const t0 = o.createdAt; if (t0 && (sRec.first === null || t0 < sRec.first)) sRec.first = t0; }
			// Track the active model. DSH records it on:
			//  - request/header: data.header.config.model  (authoritative)
			//  - request/context: data.model
			//  - assistant/message: data.usage.model
			if (o.type === "request/header") {
				const m = o.data?.header?.config?.model || o.data?.model || null;
				if (m) currentModel = m;
				if (m && (sRec.model === null || currentModel)) sRec.model = m;
			} else if (o.type === "assistant/message") {
				const m = o.data?.usage?.model || o.data?.model || null;
				if (m) currentModel = m;
			} else if (o.type === "request/context") {
				const m = o.data?.model || null;
				if (m) currentModel = m;
			}
			// Whether this event falls within the requested window (computed once so
			// both the usageBlock branch and usagesFromEvent can use it).
			const evT = o.time ?? o.createdAt;
			const inRange = cutoff === null || (evT && evT >= cutoff);
			// Per-day + per-workspace accumulation must happen per event BEFORE the
			// generic usagesFromEvent bump, so we mirror the same broken-down shape.
			// Accept both the committed `data.usage` (dsh 0.2.0-rc.2) and the older
			// streaming `data.chunk.usage`; reading only the latter left cost, byDay,
			// and the today/this-month cards at zero while totals still counted.
			const usageBlock = o.data?.usage ?? o.data?.chunk?.usage;
			if (usageBlock) {
				const inTok = usageBlock.inputTokens ?? usageBlock.prompt_tokens ?? usageBlock.promptTokens ?? 0;
				const outTok = usageBlock.outputTokens ?? usageBlock.completion_tokens ?? usageBlock.completionTokens ?? 0;
				const cTok = usageBlock.cacheReadTokens ?? usageBlock.cachedTokens ?? usageBlock.cached_tokens ?? 0;
				const rTok = usageBlock.reasoningTokens ?? usageBlock.reasoning_tokens ?? 0;
				const sum = inTok + outTok + cTok + rTok;
				const t = o.time ?? o.createdAt;
				const day = t ? localDayKey(t) : null;
				// cost of this single event (peak/off-peak aware, model-aware), split into
				// the three DeepSeek billing buckets so every view can separate them.
				const parts = costParts({ input: inTok, output: outTok, cacheRead: cTok, reasoning: rTok }, t, currentModel || "unknown");
				const cost = parts.total;
				// Whether this event is within the requested window (reuse outer inRange).
				if (inRange) addCost(acc, parts);
				// Two day views, on purpose:
				//   byDay    — window-filtered, so the share bar's totals and the per-day
				//              curves describe the same slice and cannot contradict.
				//   byDayAll — never filtered, because the activity heatmap spans a full
				//              year and needs history the selected window excludes.
				// Keeping one bucket for both made the bar and the curve disagree.
				const dayTargets = (!inRange && day !== null) ? [acc.byDayAll] : [acc.byDay, acc.byDayAll];
				if (day !== null) for (const target of dayTargets) {
					let d = target[day];
					if (d === undefined) d = target[day] = { total: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, byWorkspace: {}, byModel: {} };
					if (d.byWorkspace === undefined) d.byWorkspace = {};
					if (d.byModel === undefined) d.byModel = {};
					d.total += sum;
					d.input += inTok;
					d.output += outTok;
					d.cacheRead += cTok;
					addCost(d, parts);
					// Per-workspace / per-model split INSIDE the day bucket: the client needs
					// the date x group cross-product to draw one curve per group, and a flat
					// byWorkspace/byModel total cannot be decomposed back into days.
					let dw = d.byWorkspace[ws];
					if (dw === undefined) dw = d.byWorkspace[ws] = { total: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, req: 0 };
					dw.total += sum;
					dw.input += inTok;
					dw.output += outTok;
					dw.cacheRead += cTok;
					addCost(dw, parts);
					dw.req += 1;
					const dayModel = currentModel || "unknown";
					let dm = d.byModel[dayModel];
					if (dm === undefined) dm = d.byModel[dayModel] = { total: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, req: 0 };
					dm.total += sum;
					dm.input += inTok;
					dm.output += outTok;
					dm.cacheRead += cTok;
					addCost(dm, parts);
					dm.req += 1;
				}
				// today / thisMonth are cardinal period facts (全量, independent of window)
				if (day !== null) {
					if (day === todayKey) { acc.today = (acc.today || 0) + sum; acc.todayCost = (acc.todayCost || 0) + cost; }
					if (day.slice(0, 7) === monthKey) { acc.thisMonth = (acc.thisMonth || 0) + sum; acc.thisMonthCost = (acc.thisMonthCost || 0) + cost; }
				}
				// per-workspace broken-down counters
				if (inRange) {
					let w = acc.byWorkspace[ws];
					if (w === undefined) { w = acc.byWorkspace[ws] = { req: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0 }; }
					w.req += 1;
					w.input += inTok;
					w.output += outTok;
					w.cacheRead += cTok;
					w.reasoning += rTok;
					w.total += sum;
					addCost(w, parts);
					// per-session accumulation
					sRec.total += sum;
					addCost(sRec, parts);
					sRec.req += 1;
					sRec.model = currentModel || sRec.model;
					const evTime = o.time ?? o.createdAt;
					if (evTime) { if (sRec.first === null || evTime < sRec.first) sRec.first = evTime; if (sRec.last === null || evTime > sRec.last) sRec.last = evTime; }
				}
			}
			usagesFromEvent(o, acc, currentModel, o.time ?? o.createdAt, inRange);
		}
	}
	// With no window selected every day is in range, so the two views are the same
	// data; alias instead of duplicating 365 buckets on the wire.
	if (cutoff === null) acc.byDay = acc.byDayAll;
	return acc;
}

/**
 * Proxy DeepSeek `/user/balance`.
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
async function fetchBalance(apiKey) {
	if (!apiKey) return { status: "unconfigured", message: "未配置 DeepSeek API Key" };
	const res = await fetch("https://api.deepseek.com/user/balance", {
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
	});
	if (!res.ok) return { status: "error", httpStatus: res.status, message: res.statusText };
	const json = await res.json();
	return { status: "ok", data: json };
}

/** A simple JSON response helper for the node:http handler. */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store"
	});
	res.end(body);
}

/**
 * The Cordis plugin. `ctx` is the DSH context, `config` the merged config from
 * the bundle patch row.
 */
export function apply(ctx, config) {
	// sessionsRoot defaults to $DSH_HOME/sessions (config no longer forces it via
	// the patch; the host half resolves its own default so the minimal patch
	// `- insert: { id, name }` always parses and mounts).
	const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
	const sessionsRoot = config?.sessionsRoot || join(dshHome, "sessions");
	const balanceCacheMs = config?.balanceCacheMs ?? 300000;
	const sweepIntervalMs = config?.sweepIntervalMs ?? 60000;
	const logLevel = config?.logLevel ?? "info";

	// ---- stats cache: keep a synchronous-but-heavy full scan OFF the request
	// thread. Aggregate once every STATS_TTL_MS, serve cached results meanwhile.
	// A sync scan of the whole sessions tree takes ~1.5s and would block the DSH
	// event loop (freezing every concurrent request, SSE, and model call) if run
	// inline in a handler — that is exactly the "everything goes slow / UI goes
	// blank" symptom. Caching makes the request path O(1) and defers the costly
	// scan to a background refresh that never blocks a response.
	const STATS_TTL_MS = 60_000;
	// Cache keyed by window (days): { [days]: { at, payload, computing } }.
	let statsCache = {};

	// (stats cache is filled lazily on the first /stats request, synchronously.)

	// --- route: token stats (served from cache; never blocks the event loop) ---
	ctx.webServer.register({
		kind: "exact",
		path: "/api/token-dashboard/stats",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://x");
				const force = url.searchParams.get("refresh") === "1";
				const days = Number(url.searchParams.get("days"));
				const winDays = (days > 0) ? days : null;
				const key = winDays || 0;
				let cell = statsCache[key];
				// Serve from cache if fresh; otherwise compute synchronously (first call
				// after a window switch blocks ~1.5s to fill the cache, then it's instant).
				if (force || !cell || (Date.now() - cell.at > STATS_TTL_MS && !cell.computing)) {
					const s = aggregateTokens(sessionsRoot, winDays);
					statsCache[key] = { at: Date.now(), payload: s, computing: false };
					cell = statsCache[key];
				}
				if (cell && cell.payload) {
					sendJson(res, 200, { ...cell.payload, cached: true, windowDays: winDays });
					return;
				}
				if (cell && cell.error) {
					sendJson(res, 500, { status: "error", message: cell.error, windowDays: winDays });
					return;
				}
				sendJson(res, 200, { status: "computing", cached: false, windowDays: winDays });
			} catch (error) {
				ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				sendJson(res, 500, { status: "error", message: String(error) });
			}
		}
	});

	// --- route: balance (with cache + ?force=1) ---
	let balanceCache = { at: 0, payload: null };
	ctx.webServer.register({
		kind: "exact",
		path: "/api/token-dashboard/balance",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://x");
				const force = url.searchParams.get("force") === "1";
				const now = Date.now();
				if (!force && balanceCache.payload && now - balanceCache.at < balanceCacheMs) {
					sendJson(res, 200, { ...balanceCache.payload, cached: true });
					return;
				}
				// Resolve the DeepSeek API key from DSH credentials (service fetched
				// lazily via ctx.get, mirroring dsh-llm-deepseek's own key path).
				let apiKey;
				try {
					const credentials = ctx.get("credentials");
					const hit = credentials?.resolve ? await credentials.resolve("DEEPSEEK_API_KEY") : null;
					apiKey = typeof hit === "string" ? hit : (hit?.value ?? null);
				} catch {
					apiKey = null;
				}
				if (!apiKey) apiKey = process.env.DEEPSEEK_API_KEY || null;
				const payload = await fetchBalance(apiKey);
				balanceCache = { at: now, payload };
				sendJson(res, 200, { ...payload, cached: false });
			} catch (error) {
				ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				sendJson(res, 500, { status: "error", message: String(error) });
			}
		}
	});

	ctx.logger.info(`[token-dashboard] mounted; sessionsRoot=${sessionsRoot}`);
}

export const inject = ["webServer"];
export const name = "token-dashboard";

// Re-export helpers for the standalone workspace self-test (not used by Cordis).
export { aggregateTokens, zstdDecompressToText, findSessionLogs };
